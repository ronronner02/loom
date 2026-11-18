import { pendingFinalization, recordedControlReceipt, saveFinalization,
  type AttemptFinalizationProgress, type FinalizationOutcome, type PreparedAttemptOutcome } from "./attempt-finalization.js";
import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { TEAM_CONTROL_VERSION, jsonValue, type ControlRequest, type JsonValue } from "../contracts/team-control.js";
import type { PlanGovernance } from "./plan-governance.js";
import type { SessionRegistry } from "./session-registry.js";
import type { NativeAttemptIdentity } from "../contracts/team-control.js";
import { classifyAttemptFailure, classificationFor, type AttemptClassification, type AttemptReasonCode } from "./attempt-failure.js";
import { agentTurnOutputPaths, readAgentTurnThreadId } from "./agent-turn.js";
import type { CandidateFacts } from "./task-completion.js";
import { prepareAutomaticOutcome } from "./attempt-outcome.js";
import { reviewerOutput } from "./reviewer-report.js";
import { recordedFindings } from "./review-loop.js";
import type { AttemptTelemetry } from "./attempt-telemetry.js";
import type { TaskReport } from "./task-report.js";
import { recordWorkflowTurn } from "./team-workflows.js";
import { observeIdentity } from "./process-termination.js";
import type { SupervisorExitFacts } from "../adapters/child-process-supervisor.js";

/**
 * The completion path's observation half.
 *
 * A direct launch records a receipt naming the client process the pane runs under, but nothing
 * wrote that attempt into `team_attempts` and nothing ever closed it. A task could therefore
 * never be observed to finish, and the owner's outcome command — which requires a stopped
 * attempt with an identity — could never succeed outside the demos.
 *
 * This path closes that gap with the receipt and stop writes, then records the task outcome from
 * the daemon's own evidence. Owner commands remain an override, while ordinary implementer,
 * lead and reviewer turns complete through this sweep. Stopping enrolls durable finalization;
 * completed owners are acknowledged separately and unfinished owners resume on the next sweep.
 */

/** How often receipts are registered and identities re-observed, on the daemon's 1 Hz cadence. */
export const ATTEMPT_SWEEP_INTERVAL_MS = 1_000;

export interface AttemptCompletionDependencies {
  db: Database.Database;
  governance: PlanGovernance;
  /**
   * The run's current binding, read the way every control command reads it. A plan that moved
   * under the attempt invalidates the run instead of being admitted against a stale approval.
   */
  currentBinding: (runId: string) => unknown;
  /** The seat's session status, which the dispatcher reads to decide whether to start a client. */
  sessions: Pick<SessionRegistry, "findResumeContextByName" | "updateStartupStatus">
    & Partial<Pick<SessionRegistry, "updateResumeToken">>;
  /** The direct worker's mutable state root, shared with its turn launcher. */
  turnStateRoot?: string;
  /** The same attempt store served by the live and historical telemetry routes. */
  telemetry?: Pick<AttemptTelemetry, "capture" | "recordOutcome">;
  /** The runtime's daemon-owned candidate manifest reader, used for automatic completion evidence. */
  candidateManifestFor?: (runId: string, taskId: string) => CandidateFacts;
  /** The runtime's daemon-owned lead proposal reader, used for automatic lead completion evidence. */
  readLeadProposal?: (runId: string, taskId: string) => readonly unknown[];
  readTaskReport?: (runId: string, attemptId: string) => TaskReport | null;
  /**
   * The runtime's reader of a delivery lead's escalation.
   *
   * Present means this daemon reads the second file a lead may deliver, and it turns on the
   * manager rule: a delivery lead turn that writes neither file is still a turn the owner asked
   * for, and one that writes either must have written a shape the boundary accepts.
   */
  readLeadEscalation?: (runId: string, taskId: string) => { optionCount: number } | null;
  /** Injectable for the tests; production reads the recorded identity on any host. */
  alive?: (identity: { processId: number; processStart: string }) => boolean | Promise<boolean>;
  /**
   * The exit facts a supervised turn recorded, read by attempt id.
   *
   * The supervisor writes what it observed — exit code, signal, bounded stderr and output — to
   * the attempt's own output as soon as the child ends. Absent means this daemon has no such
   * evidence and classifies from the recorded identity alone, which is what a fixture wants.
   */
  turnExit?: (attemptId: string) => SupervisorExitFacts | null;
  /**
   * Start the run's next pending task now that this attempt's seat and slot are free.
   *
   * Absent means nothing dispatches on a freed slot, which is what a caller without a
   * dispatcher (a test) wants.
   */
  dispatchPending?: (runId: string) => Promise<void>;
  /** Persist native-turn documents before the stop write, while an interrupted capture can still be swept. */
  captureTurnDocuments?: (attempt: import("../contracts/team-control.js").TeamAttempt) => void;
  /**
   * The end of one turn, after its stop is recorded and before the next task starts.
   *
   * A lead's turn ends with its final message, and that message is the reply the owner reads in
   * the run's chat. Reading it and storing it belongs to the owner of that conversation, not to
   * this sweep: this is the observation that the turn ended, which is the fact the conversation
   * owner cannot see for itself. It is awaited so a reply is stored before the slot is offered
   * again. A failed integration stays pending for the next sweep.
   */
  onAttemptStopped?: (attempt: import("../contracts/team-control.js").TeamAttempt) => Promise<void>;
  /** Each owner is acknowledged separately after its idempotent durable effects complete. */
  stoppedOwners?: readonly { name: string; complete: (attempt: import("../contracts/team-control.js").TeamAttempt) => void | Promise<void> }[];
  /**
   * Land a task whose review just approved on the run's integration branch.
   *
   * The approval is the trigger: the outcome command records it, and this is the observation
   * that it happened. Awaited so the branch has the commit before the sweep offers the slot
   * again. Its failure retains the finalization checkpoint; a recorded conflict wakes the lead.
   */
  integrateTask?: (runId: string, taskId: string) => Promise<unknown>;
  /**
   * The tick after every observation, for the owner of facts no single attempt produces.
   *
   * The lead is woken by what its whole team did — a task that failed after its retry, a review
   * allowance that ran out, a task that conflicts on the integration branch, every task done —
   * and none of those is "this attempt stopped". The completion sweep is already the daemon's
   * 1 Hz observation of the queue, so the team-event owner runs on it rather than opening a
   * second timer that could disagree about the cadence.
   */
  onSweep?: () => Promise<void>;
  /**
   * Reconcile every running or unknown attempt once, before the first sweep.
   *
   * A daemon that stopped while a turn was running left `team_attempts` rows whose processes
   * it can no longer observe. This runs once at `start()`, ahead of the ordinary sweep, so the
   * first observation of the queue sees reconciled facts rather than stale running rows. Its
   * own owner is `domain/boot-recovery.ts`; absent means this daemon reconciles nothing, which
   * is what a unit fixture wants.
   */
  reconcileOnBoot?: () => Promise<unknown>;
  now?: () => Date;
  intervalMs?: number;
  log?: (message: string) => void;
}

export interface AttemptCompletion {
  /** Register every receipt whose attempt is not recorded, then stop the ones that ended. */
  sweep(): Promise<void>;
  start(): void;
  stop(): void;
}

const unavailable = { value: null, reason: "Native usage has not been observed" };

/**
 * Whether the process a receipt named is still the one running, on POSIX.
 *
 * The start time is the identity: a recycled pid starts at a different clock tick, so it is a
 * different process. A zombie has already exited even though `/proc` still lists it. A `/proc`
 * that cannot be read at all is not evidence of an end — only a missing process is.
 *
 * Windows has no `/proc`; there the same question is answered from the process's creation time
 * through the platform boundary, by `identityAlive` below.
 */
export function processIdentityAlive(identity: { processId: number; processStart: string }): boolean {
  try {
    const raw = readFileSync("/proc/" + identity.processId + "/stat", "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
    return fields[0] !== "Z" && fields[0] !== "X" && fields[19] === identity.processStart;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/**
 * The sweep's liveness question on any host, in the one form its caller can act on.
 *
 * The sweep closes an attempt when this answers false, so only a proved end may answer false: a
 * missing process, or a zombie. On Windows a denied or timed-out query is `unknown` and a moved
 * creation time is `not-ours`; neither is evidence that the recorded process ended, so both answer
 * true and the attempt stays open. Recovery's own `unknown`/`unresolved` handling belongs to the
 * unit that reconciles identities at boot, not to this observation.
 */
export async function identityAlive(identity: { processId: number; processStart: string }): Promise<boolean> {
  return await observeIdentity(identity) !== "dead";
}

interface ReceiptRow { seq: number; payload: string }

export function composeAttemptCompletion(dependencies: AttemptCompletionDependencies): AttemptCompletion {
  const { db, governance, currentBinding, sessions } = dependencies;
  const log = dependencies.log ?? ((message: string) => console.warn(message));
  // The readers the outcome assembly needs, named once so the sweep and the evaluator cannot
  // disagree about which evidence they hold.
  const outcomeInput = { db, governance, turnStateRoot: dependencies.turnStateRoot,
    ...(dependencies.candidateManifestFor ? { candidateManifestFor: dependencies.candidateManifestFor } : {}),
    ...(dependencies.readLeadProposal ? { readLeadProposal: dependencies.readLeadProposal } : {}),
    ...(dependencies.readTaskReport ? { readTaskReport: dependencies.readTaskReport } : {}),
    ...(dependencies.readLeadEscalation ? { readLeadEscalation: dependencies.readLeadEscalation } : {}),
    log };
  const intervalMs = dependencies.intervalMs ?? ATTEMPT_SWEEP_INTERVAL_MS;
  const alive = dependencies.alive ?? identityAlive;
  let timer: ReturnType<typeof setInterval> | null = null;
  let sweeping = false;
  let started = false;
  let booting = false;
  let generation = 0;
  /**
   * The highest receipt `seq` this process has already read.
   *
   * Receipts are only ever appended, and `register` is idempotent, so the first sweep after a
   * restart reads the log once from the beginning and every later tick reads only what is new.
   * Without this, the cost of a tick would grow with every run the daemon has ever hosted.
   */
  let processedSeq = 0;

  /**
   * The task a seat is working, resolved from the run's own rows.
   *
   * The launch records its task in the submitted lifecycle fact before the child exists, so the
   * receipt and the task agree. Match that exact task before limiting the seat lookup, because a
   * seat may have several queued tasks; without a named task only one live task is evidence
   * enough, and a task for another seat must never fall back to that guess.
   */
  const taskForSeat = (runId: string, sessionName: string, taskId: string | null) => {
    const rows = db.prepare(`
      SELECT a.qitem_id AS qitemId, json_extract(a.assignment_json, '$.role') AS role
      FROM team_queue_authority a
      JOIN queue_items q ON q.qitem_id = a.qitem_id
      JOIN team_runs r ON r.id = a.run_id
      WHERE a.run_id = ? AND q.destination_session = ? AND q.state IN ('pending', 'in-progress')
        AND r.state = 'approved' AND (? IS NULL OR a.task_id = ?)
      LIMIT 2`).all(runId, sessionName, taskId, taskId) as Array<{ qitemId: string; role: string }>;
    return rows.length === 1 ? { qitemId: rows[0]!.qitemId, role: rows[0]!.role } : null;
  };

  /** Admit the attempt a launch receipt names, unless it is already recorded. */
  const register = async (row: ReceiptRow): Promise<void> => {
    const { sessionName, receipt } = JSON.parse(row.payload) as {
      sessionName?: string; receipt?: { attemptId: string; runId: string; client: string; identity: NativeAttemptIdentity };
    };
    if (!sessionName || !receipt) return;
    // A resume re-enters the attempt it recorded, so its row already exists and keeps its own
    // history. Only the first observation of a native generation admits a new row.
    if (governance.getAttempt(receipt.attemptId)) return;
    const submitted = db.prepare(`SELECT json_extract(payload, '$.taskId') AS taskId FROM events
      WHERE type = 'team.control' AND json_extract(payload, '$.runId') = ?
        AND json_extract(payload, '$.attemptId') = ? AND json_extract(payload, '$.action') = 'attempt.submitted'
      ORDER BY seq DESC LIMIT 1`).get(receipt.runId, receipt.attemptId) as { taskId: string | null } | undefined;
    const taskId = submitted?.taskId ?? null;
    const task = taskForSeat(receipt.runId, sessionName, taskId);
    if (!task) {
      log(`team completion: no single live task on ${sessionName} for run=${receipt.runId}` +
        `${taskId === null ? "" : ` (the launch names ${taskId})`}; attempt ${receipt.attemptId} is unrecorded`);
      return;
    }
    const request: ControlRequest<unknown> = {
      protocolVersion: TEAM_CONTROL_VERSION, runId: receipt.runId, actionId: receipt.attemptId,
      expectedEntityVersion: governance.getRun(receipt.runId).entityVersion,
      // One key per attempt: a repeated receipt replays the same admission instead of racing a
      // second row for the same native generation.
      idempotencyKey: "attempt-receipt:" + receipt.attemptId,
      payload: {
        qitemId: task.qitemId, role: task.role, provider: receipt.client === "claude-code" ? "claude" : receipt.client,
        identity: receipt.identity as unknown as JsonValue, state: "running", unknownReason: null,
        usage: { activeMs: 0, inputTokens: unavailable, outputTokens: unavailable, costUsd: unavailable },
      },
    };
    const recorded = governance.recordAttempt(request, currentBinding(receipt.runId));
    if (recorded.status !== "observed" && !recorded.replayed) {
      log(`team completion: attempt ${receipt.attemptId} was not registered: ${recorded.reason ?? recorded.status}`);
    }
  };

  /**
   * Record the end of every running attempt whose process is gone.
   *
   * The seat the attempt ran on is put back to the state a start leaves a never-launched seat
   * in. `startup_status: ready` is what tells the dispatcher "this seat already has an agent",
   * and it is true only while one is running: leaving it set would make the rework dispatch and
   * the reviewer's second round see a live agent and start nothing, and the task would wait
   * forever for work nobody was doing. The session's `status` is left alone — it is the
   * presence record of the terminal, not of the agent.
   *
   * The stop carries the attempt's one classification. The evidence is read here,
   * once, at the moment the sweep observes the process gone: the run's own cancel state, the
   * exit status the seat's terminal recorded, and the last lines it held. Nothing later
   * re-derives it, and nothing here adds an attempt or a unit of budget.
   */
  const close = async (): Promise<void> => {
    const rows = db.prepare("SELECT id FROM team_attempts WHERE state = 'running' AND identity_json IS NOT NULL")
      .all() as Array<{ id: string }>;
    for (const row of rows) {
      try {
        const attempt = governance.getAttempt(row.id);
        if (!attempt?.identity) continue;
        // A native turn's exit facts are written by the supervisor as soon as the child
        // ends, so they are the direct proof of an end. Without them the recorded identity
        // decides, exactly as before: a live process keeps the attempt open.
        if (dependencies.turnExit?.(attempt.id) == null && await alive(attempt.identity)) continue;
        const failure = classify(attempt);
        dependencies.telemetry?.capture(attempt);
        // A persisted stop is excluded from later sweeps. Save its exact documents first so a
        // restart never needs to attribute the candidate's later mutable bytes to this turn.
        dependencies.captureTurnDocuments?.(attempt);
        const request: ControlRequest<unknown> = {
          protocolVersion: TEAM_CONTROL_VERSION, runId: attempt.runId, actionId: attempt.id,
          expectedEntityVersion: governance.getRun(attempt.runId).entityVersion,
          idempotencyKey: `attempt-stop:${attempt.id}:${attempt.entityVersion}`,
          // The end of the process is the observation; no usage figure is claimed for it.
          payload: { expectedAttemptVersion: attempt.entityVersion, state: "stopped", usage: jsonValue(attempt.usage),
            ...(failure === null ? {} : { failure: jsonValue(failure) }) },
        };
        const recorded = governance.recordUsage(request, { finalize: true });
        if (recorded.status !== "observed") {
          log(`team completion: attempt ${attempt.id} stop was not recorded: ${recorded.reason ?? recorded.status}`);
        }
      } catch (error) {
        // A run or attempt that moved under the sweep is re-read on the next tick; one failed
        // observation must not stop the others.
        log(`team completion: sweep skipped ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  /**
   * The evidence the daemon holds about one ended attempt, classified once.
   *
   * A read that fails is no evidence, and the classifier already treats no evidence as no
   * failure rather than as a clean exit, so a transient read error cannot manufacture a
   * retryable code.
   *
   * The exit status decides first, because it is structured: a client that exits with 0 finished
   * its turn, so nothing it printed is the failure of this attempt. Only a non-zero exit, a
   * signal, or no exit record at all sends the tail to the fingerprints. The supervisor wrote
   * both to `exit.json` beside the attempt's other output when the child ended.
   */
  const classify = (attempt: NonNullable<ReturnType<PlanGovernance["getAttempt"]>>): AttemptClassification | null => {
    const run = governance.getRun(attempt.runId);
    const canceled = run.state === "cancel_requested" || run.state === "canceled";
    const facts = dependencies.turnExit?.(attempt.id) ?? null;
    return classifyAttemptFailure({ canceled,
      exit: facts === null || (facts.exitCode === null && facts.signal === null) ? null : { code: facts.exitCode },
      terminalTail: facts === null ? null : ([facts.stderrTail, facts.outputTail].filter(Boolean).join("\n") || null),
      now: dependencies.now?.() });
  };

  const defaultOutcome = (attempt: NonNullable<ReturnType<PlanGovernance["getAttempt"]>>): FinalizationOutcome => ({
    telemetry: { outcome: attempt.failure?.reasonCode === "canceled" ? "canceled" : attempt.failure ? "failed" : "unknown", retryScheduled: false },
  });

  const recordAutomaticOutcome = (attempt: NonNullable<ReturnType<PlanGovernance["getAttempt"]>>,
    progress: AttemptFinalizationProgress): FinalizationOutcome => {
    const key = `daemon-task-outcome:${attempt.id}`;
    // A receipt is checked before workflow writes, candidate reads, or current entity versions.
    const prior = recordedControlReceipt(db, attempt.runId, key);
    const resultOf = (receipt: NonNullable<typeof prior>): FinalizationOutcome => {
      if (receipt.status !== "observed" || !progress.outcome) {
        if (receipt.status !== "observed") log(`team completion: outcome for ${attempt.id} was ${receipt.status}: ${receipt.reason}`);
        return defaultOutcome(attempt);
      }
      const value = receipt.value as { review?: { verdict?: string; taskId?: string }; evidence?: { retryNotBefore?: string } } | null;
      const state = progress.outcome.state;
      return { telemetry: { outcome: state === "done" ? "succeeded" : state === "canceled" ? "canceled" : "failed",
        retryScheduled: state === "failed" && typeof value?.evidence?.retryNotBefore === "string" },
        ...(value?.review?.verdict === "approved" && typeof value.review.taskId === "string" ? { integrateTaskId: value.review.taskId } : {}) };
    };
    if (prior) return resultOf(prior);
    const task = attempt.qitemId === null ? null : governance.getTask(attempt.qitemId);
    const latest = task ? db.prepare("SELECT id FROM team_attempts WHERE qitem_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(task.qitemId) as { id: string } | undefined : null;
    if (!task || latest?.id !== attempt.id || !["pending", "in-progress", "blocked"].includes(governance.queueState(task.qitemId) ?? "")) {
      return defaultOutcome(attempt);
    }
    if (progress.outcome === undefined) {
      progress.outcome = prepareAutomaticOutcome(attempt, outcomeInput);
      saveFinalization(db, attempt.id, progress);
    }
    const prepared = progress.outcome;
    if (!prepared || task.entityVersion !== prepared.taskVersion) return defaultOutcome(attempt);
    let currentAttempt = attempt;
    if (prepared.state === "failed" && currentAttempt.failure === null && prepared.reasonCode !== null) {
      const observed = governance.recordUsage({
        protocolVersion: TEAM_CONTROL_VERSION, runId: currentAttempt.runId, actionId: currentAttempt.id,
        expectedEntityVersion: governance.getRun(currentAttempt.runId).entityVersion,
        idempotencyKey: `attempt-failure:${currentAttempt.id}:${currentAttempt.entityVersion}`,
        payload: { expectedAttemptVersion: currentAttempt.entityVersion, state: "stopped", usage: jsonValue(currentAttempt.usage),
          failure: jsonValue(classificationFor(prepared.reasonCode)) },
      });
      if (observed.status !== "observed") return defaultOutcome(attempt);
      currentAttempt = governance.getAttempt(currentAttempt.id)!;
    }
    const outcome = governance.recordTaskOutcome({
      protocolVersion: TEAM_CONTROL_VERSION, runId: currentAttempt.runId, actionId: task.qitemId,
      expectedEntityVersion: governance.getRun(currentAttempt.runId).entityVersion, idempotencyKey: key,
      payload: { expectedTaskVersion: prepared.taskVersion, state: prepared.state, actorSession: prepared.actorSession,
        attemptId: currentAttempt.id, expectedAttemptVersion: currentAttempt.entityVersion, evidence: prepared.evidence,
        ...(prepared.state === "done" ? { closureReason: "no-follow-on" } : {}) },
    }, { kind: "daemon", sessionId: "daemon" });
    return resultOf(outcome);
  };

  /** Keep unfinished work durable; one failed owner never replays earlier acknowledged owners. */
  const finalize = async (): Promise<void> => {
    const rows = db.prepare(`SELECT f.attempt_id AS id, f.progress_json AS progress FROM team_attempt_finalizations f
      JOIN team_attempts a ON a.id = f.attempt_id WHERE a.state = 'stopped' AND a.identity_json IS NOT NULL ORDER BY a.rowid`)
      .all() as Array<{ id: string; progress: string }>;
    for (const row of rows) {
      try {
        const attempt = governance.getAttempt(row.id)!;
        const progress = JSON.parse(row.progress) as AttemptFinalizationProgress;
        if (progress.result === undefined) {
          progress.result = recordAutomaticOutcome(attempt, progress);
          saveFinalization(db, attempt.id, progress);
        }
        const step = async (name: string, complete: () => void | Promise<unknown>) => {
          if (progress.completed.includes(name)) return;
          await complete();
          progress.completed.push(name);
          saveFinalization(db, attempt.id, progress);
        };
        const result = progress.result;
        await step("integration", () => result.integrateTaskId ? dependencies.integrateTask?.(attempt.runId, result.integrateTaskId) : undefined);
        await step("telemetry", () => {
          // Boot-reconciled stops did not pass through the live capture before their stop.
          if (dependencies.telemetry && !db.prepare("SELECT 1 FROM attempt_telemetry WHERE attempt_id = ?").get(attempt.id)) {
            dependencies.telemetry.capture(attempt);
          }
          dependencies.telemetry?.recordOutcome(attempt.id, result.telemetry);
        });
        const owners = [...dependencies.stoppedOwners ?? [],
          ...(dependencies.onAttemptStopped ? [{ name: "turn-end", complete: dependencies.onAttemptStopped }] : [])];
        for (const owner of owners) await step(`owner:${owner.name}`, () => owner.complete(attempt));
        // Owners may reopen durable work, but dispatch stays fenced until every owner finishes.
        releaseSeat(attempt);
        db.prepare("DELETE FROM team_attempt_finalizations WHERE attempt_id = ?").run(attempt.id);
      } catch (error) {
        log(`team completion: finalization for ${row.id} remains pending: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  /** Return the seat that ran a stopped attempt to "never launched", so a dispatch may start it. */
  const releaseSeat = (attempt: NonNullable<ReturnType<PlanGovernance["getAttempt"]>>): void => {
    const seat = attempt.qitemId === null ? null : governance.taskSeat(attempt.qitemId);
    if (seat === null || db.prepare(`SELECT 1 FROM team_attempts a JOIN queue_items q ON q.qitem_id = a.qitem_id
      WHERE q.destination_session = ? AND a.id <> ?
        AND (a.state <> 'stopped' OR a.rowid > (SELECT rowid FROM team_attempts WHERE id = ?)) LIMIT 1`)
      .get(seat, attempt.id, attempt.id)) return;
    const codexAttemptId = attempt.provider === "codex" ? attempt.id : undefined;
    const context = seat === null ? null : sessions.findResumeContextByName(seat);
    if (!context) return;
    if (codexAttemptId && dependencies.turnStateRoot) {
      const path = agentTurnOutputPaths(dependencies.turnStateRoot, codexAttemptId).threadId;
      const token = readAgentTurnThreadId(path);
      if (token) sessions.updateResumeToken?.(context.sessionId, "codex_id", token, "scrape");
    }
    sessions.updateStartupStatus(context.sessionId, "pending");
  };

  /** The runs that still hold work nobody is doing, as the scheduler's own durable rows say. */
  const pendingRunIds = (): string[] => (db.prepare(`
    SELECT DISTINCT a.run_id AS runId
    FROM team_queue_authority a
    JOIN queue_items q ON q.qitem_id = a.qitem_id
    JOIN team_runs r ON r.id = a.run_id
    WHERE q.state IN ('pending', 'in-progress') AND r.state = 'approved'
      AND NOT EXISTS (SELECT 1 FROM team_attempts t WHERE t.qitem_id = a.qitem_id AND t.state <> 'stopped')`)
    .all() as Array<{ runId: string }>).map(row => row.runId);

  const sweep = async (): Promise<void> => {
    if (sweeping || booting) return;
    sweeping = true;
    try {
      const receipts = db.prepare("SELECT seq, payload FROM events WHERE type = 'managed.attempt.receipt' AND seq > ? ORDER BY seq")
        .all(processedSeq) as ReceiptRow[];
      for (const row of receipts) {
        // Advance before registering: a receipt that cannot be registered now is not retried, and
        // the owner action refuses its task with a named reason rather than leaving a tick to
        // repeat the same refusal every second for the life of the daemon.
        processedSeq = row.seq;
        try { await register(row); } catch (error) {
          log(`team completion: receipt was not registered: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      await close();
      await finalize();
      for (const runId of pendingRunIds()) {
        if (pendingFinalization(db, runId)) continue;
        try { await dependencies.dispatchPending?.(runId); } catch (error) {
          log(`team completion: scheduled dispatch for run=${runId} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      // The sweep has recorded everything this tick can observe about its attempts; the facts the
      // whole team produced are read after it, once, for the same cadence.
      try { await dependencies.onSweep?.(); } catch (error) {
        log(`team completion: the sweep's team-event owner failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      sweeping = false;
    }
  };

  return {
    sweep,
    start() {
      if (started) return;
      started = true;
      booting = true;
      const currentGeneration = ++generation;
      void (async () => {
        try {
          await dependencies.reconcileOnBoot?.();
          if (!started || generation !== currentGeneration) return;
          booting = false;
          timer = setInterval(() => {
            sweep().catch(error => log(`team completion: sweep failed: ${error instanceof Error ? error.message : String(error)}`));
          }, intervalMs);
          timer.unref?.();
          await sweep().catch(error => {
            log(`team completion: startup sweep failed: ${error instanceof Error ? error.message : String(error)}`);
          });
        } catch (error) {
          log(`team completion: startup failed before dispatch: ${error instanceof Error ? error.message : String(error)}`);
          if (generation === currentGeneration) {
            started = false;
            booting = false;
            if (timer) clearInterval(timer);
            timer = null;
          }
        }
      })();
    },
    stop() {
      started = false;
      booting = false;
      generation += 1;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
