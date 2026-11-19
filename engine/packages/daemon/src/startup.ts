import { pendingFinalization } from "./domain/attempt-finalization.js";
import { documentDispatchRefusal } from "./domain/project-documents.js";
import { managedModelRefusal } from "./domain/team-model-policy.js";
import { discoverTailscaleSelfNames } from "./middleware/browser-boundary.js";
import { configureShadowCapture } from "./domain/shadow-capture.js";
import type { Hono } from "hono";
import type Database from "better-sqlite3";
import { openDatabase } from "./db/connection.js";
import { RigRepository } from "./domain/rig-repository.js";
import { SessionRegistry } from "./domain/session-registry.js";
import { deriveCanonicalSessionName, isHumanSeatSessionRef, parseSessionName } from "./domain/session-name.js";
import { resolveExternal } from "./domain/queue-routing/external-admission.js";
import { loadHumanRegistry } from "./domain/queue-routing/human-registry.js";
import { EventBus } from "./domain/event-bus.js";
import { codexDaemonSupportProbe } from "./domain/codex-daemon-support.js";
import { prepareCodexTeamWorkspace } from "./domain/codex-team-workspace.js";
// TODO: AS-T12 — migrate to pod-aware bundle source resolver
import { DaemonLifecycleStore } from "./domain/daemon-lifecycle-store.js";
import { randomUUID } from "node:crypto";
import { AgentActivityStore } from "./domain/agent-activity-store.js";
import { MailboxRepository } from "./domain/mailbox-repository.js";
import { StreamStore } from "./domain/stream-store.js";
import { SlowOpRecorder, type SlowOperationInstrumentation } from "./domain/slow-op-recorder.js";
import { configureSyncSiteRecorder } from "./domain/sync-site-wrap.js";
import { RequestPhaseObserver } from "./domain/request-phase-observer.js";
import { QueueRepository } from "./domain/queue-repository.js";
import { WorkflowRuntime } from "./domain/workflow-runtime.js";
// Phase 3a slice 3.3 — plugin discovery service.
// Slice 28 Checkpoint C-3 — skill-library discovery (SC-29 #11 cumulative).
import { SettingsStore as ContextPackSettingsStore } from "./domain/user-settings/settings-store.js";
import { SettingsStore } from "./domain/user-settings/settings-store.js";
import { createApp, type AppDeps } from "./server.js";
import { markDaemonDatabase, PlanGovernance, hashBytes } from "./domain/plan-governance.js";
import { refreshPlanBinding, unisolatedPolicyCapability } from "./routes/team-start.js";
import { leadActivation } from "./domain/lead-proposal.js";
import { planningRosterRequired } from "./domain/lead-roster.js";
import { composeLeadTurnEnd } from "./domain/lead-chat.js";
// The managed attempt's production inputs, composed here beside the candidate roots.
import { WorkerControlAccess } from "./domain/worker-control-access.js";
import { MailboxDelivery, createMailboxPromptStateReader } from "./domain/mailbox-delivery.js";
import { SeatMailboxCapabilities } from "./domain/worker-mailbox-capability.js";
import { WorkerIdentities } from "./domain/worker-identity.js";
import { FRAMEWORK_PIN } from "./integrations/framework/catalog.js";
import { resolveTeamSoul } from "./domain/team-souls.js";
import { teamSectionsText } from "./domain/team-prompt-sections.js";
import { recordWorkflowOutcome, workflowCapabilityRefusal } from "./domain/team-workflows.js";
import { prepareFrameworkInvocation } from "./integrations/framework/invocation.js";
import { frameworkInstructionSources } from "./integrations/framework/source.js";
import { createSystemHealthReader, attemptsFromRecords, type SystemHealthProbeResult } from "./domain/system-health.js";
import { parseAttemptClassification } from "./domain/attempt-failure.js";
import { TeamReadModel } from "./team-control-surface.js";
import { canonicalJson } from "./contracts/team-control.js";
import type { TeamSystemHealth } from "./contracts/team-control.js";
import { workerEventNotification } from "./domain/worker-event-notification.js";
import { DirectWorkerLauncher, type DirectLaunchFacts } from "./adapters/direct-worker-launch.js";
import { readSupervisorExit } from "./adapters/child-process-supervisor.js";
import type { WorkerClient } from "./adapters/worker-launcher.js";
import type { WorkerEvent } from "./contracts/worker-events.js";
import { unisolatedWorkerRoots, type ManagedWorkerRoots } from "./domain/unisolated-roots.js";
import { defaultWorktreeRoot } from "./domain/worktree-policy.js";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { LOOM_HOME, getStatePath } from "./data-paths.js";
import { GithubCli } from "./domain/github-cli.js";

interface DaemonOptions {
  dbPath?: string;
  teamControl?: AppDeps["teamControl"];
  /** S20 — the effective bind plan (mode/hosts/ignoredRoutingHost),
   *  computed once in index.ts and exposed on /healthz so adoption gates verify
   *  listeners by binding evidence. Absent (tests/legacy) = healthz body unchanged. */
  bindPlan?: import("./domain/bind-plan.js").BindPlan;
  slowOpRecorder?: SlowOperationInstrumentation;
  /**
   * PL-005 Phase B: bearer token for Mission Control write verbs.
   * When null, the auth-bearer-token middleware passes through (the
   * index.ts startup-side check ensures this is only valid when bound
   * on loopback). When set, the middleware enforces constant-time
   * comparison + 401 on missing/mismatch.
   */
  bearerToken?: string | null;
  /** Overrides the `ui.enabled` setting (tests). */
  webUiEnabled?: boolean;
  /** The client command a managed launch starts (tests use the stub runner). */
  directLaunchCommand?: (facts: DirectLaunchFacts) => string[];
  /** The real client executable an unisolated launch starts, when a test or an operator names it. */
  directLaunchExecutable?: (client: WorkerClient) => string | undefined;
  /** A stand-in for the supervised child, so a test can drive the launch without spawning. */
  directLaunchSupervise?: (launch: import("./adapters/child-process-supervisor.js").SupervisorLaunch,
    deps: { onEvent: (event: WorkerEvent) => void }) => import("./adapters/child-process-supervisor.js").SupervisedTurn;
  /** The owner's stop, where a signal cannot drain the daemon (Windows). See `AppDeps`. */
  requestShutdown?: (signal: string) => void;
}

interface DaemonResult {
  app: Hono;
  db: Database.Database;
  deps: AppDeps;
  // Returned so index.ts can stop() it on graceful shutdown.
  eventLoopMonitor: import("./domain/event-loop-monitor.js").EventLoopMonitor;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}

const KNOWN_PROVIDER_AUTH_ENV = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  // The Claude-side counterpart of OPENAI_BASE_URL: a key or token issued by an
  // Anthropic-compatible gateway is only valid together with that gateway's
  // endpoint, so both must be able to reach the seat.
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT_ID",
  // Issue #194: the bearer token of a Codex Amazon Bedrock provider
  // (`env_key = "AWS_BEARER_TOKEN_BEDROCK"`). Still forwarded only when the
  // operator names it in recovery.provider_auth_env_allowlist.
  "AWS_BEARER_TOKEN_BEDROCK",
]);

export function collectAllowlistedProviderAuthEnv(
  raw: string | null | undefined,
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of (raw ?? "").split(",")) {
    const name = item.trim();
    if (!name) continue;
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) continue;
    if (!KNOWN_PROVIDER_AUTH_ENV.has(name)) continue;
    const value = env[name];
    if (typeof value === "string" && value.length > 0) {
      out[name] = value;
    }
  }
  return out;
}

/**
 * The managed launch chain.
 *
 * The attempt is produced by the runtime, the mailbox authenticates, and the seat resolves to
 * its own candidate. The client itself starts as this daemon's user, as a direct child
 * process.
 */
function composeDirectLaunch(dependencies: {
  governance: PlanGovernance;
  rigRepo: RigRepository;
  /** The workflow runtime a managed launch must be admitted through. Read at launch, not at composition. */
  workflowRuntime: () => WorkflowRuntime | undefined;
  /** The client command the unisolated launch starts. A test injects a stub here. */
  command?: (facts: DirectLaunchFacts) => string[];
  /** An explicit client executable, which a fixture names and an operator may override. */
  executablePath?: (client: WorkerClient) => string | undefined;
  /** Publish a normalized worker event, where this daemon records attempt facts. */
  onEvent?: (facts: DirectLaunchFacts, event: WorkerEvent) => void;
  /** The durable lifecycle recorder the launch writes its facts through. */
  lifecycle?: import("./adapters/direct-worker-launch.js").DirectWorkerLaunchDeps["lifecycle"];
  /** A stand-in for the supervised child, so a test can drive the launch without spawning. */
  supervise?: (launch: import("./adapters/child-process-supervisor.js").SupervisorLaunch,
    deps: { onEvent: (event: WorkerEvent) => void }) => import("./adapters/child-process-supervisor.js").SupervisedTurn;
  /** The owner's settings, read at each launch for the network proxy the client runs behind. */
  settingsStore?: import("./domain/user-settings/settings-store.js").SettingsStore;
}) {
  const { rigRepo } = dependencies;
  const endpoints: Map<string, Pick<import("./adapters/worker-mailbox-bridge.js").WorkerMailboxBridge, "binding" | "endpoint">> = new Map();
  const launcher = new DirectWorkerLauncher({
    modelRefusal: input => managedModelRefusal(rigRepo.db, input),
    documentRefusal: input => {
      const { runId, assignment, binding } = input.attempt.context;
      if (pendingFinalization(rigRepo.db, runId)) return "managed_finalization_pending";
      const run = dependencies.governance.getRun(runId);
      return documentDispatchRefusal(rigRepo.db, run, assignment.role, assignment.taskId, binding);
    },
    // The turn runs in the tree the runtime admitted, as a direct child process. The seat's
    // terminal is no longer the transport, so no pane is resolved and none is recorded.
    resolveAssignedTree: (runId, assignment) => {
      const runtime = dependencies.workflowRuntime();
      if (!runtime) throw new Error("direct_launch_runtime_unavailable");
      return runtime.assignedTreeFor(runId, assignment);
    },
    ...(dependencies.command ? { command: dependencies.command } : {}),
    ...(dependencies.executablePath ? { executablePath: dependencies.executablePath } : {}),
    ...(dependencies.onEvent ? { onEvent: dependencies.onEvent } : {}),
    ...(dependencies.lifecycle ? { lifecycle: dependencies.lifecycle } : {}),
    ...(dependencies.supervise ? { supervise: dependencies.supervise } : {}),
    ...(dependencies.settingsStore ? { settingsStore: dependencies.settingsStore } : {}),
  });
  return { launcher, endpoints };
}

/**
 * The exact receipt a native-token resume must present again.
 *
 * The launcher compares this receipt's hash with the one recorded on the attempt's running
 * launch intent, so the bytes are read back verbatim from the launch event rather than
 * reconstructed. A receipt for another run, task or client is treated as absent, and the
 * launch refuses instead of resuming under an attempt it does not own.
 */
function recordedManagedReceipt(dependencies: { db: Database.Database; governance: PlanGovernance }, input: {
  seat: string; nativeToken: string; runId: string; qitemId: string; client: "claude-code" | "codex" | "gemini";
}): import("./domain/runtime-adapter.js").ManagedSessionReceipt | undefined {
  const row = dependencies.db.prepare(`
    SELECT payload FROM events
    WHERE type = 'managed.attempt.receipt'
      AND json_extract(payload, '$.sessionName') = ?
      AND json_extract(payload, '$.receipt.identity.nativeSessionId') = ?
      AND json_extract(payload, '$.receipt.runId') = ?
    ORDER BY seq DESC LIMIT 1`).get(input.seat, input.nativeToken, input.runId) as
    { payload: string } | undefined;
  if (!row) return undefined;
  const receipt = (JSON.parse(row.payload) as
    { receipt?: import("./domain/runtime-adapter.js").ManagedSessionReceipt }).receipt;
  const prior = receipt ? dependencies.governance.getAttempt(receipt.attemptId) : null;
  return receipt && receipt.client === input.client && prior?.qitemId === input.qitemId
    && prior.identity && canonicalJson(prior.identity) === canonicalJson(receipt.identity)
    ? receipt : undefined;
}

/**
 * The attempt a managed seat launches under.
 *
 * A seat is managed when its queue destination names it and the run is approved. That lookup —
 * not the daemon's mode — is the authority: a personal seat in a managed daemon resolves to no
 * task and keeps its personal launch. The endpoint is registered before this returns.
 */
function composeManagedAttemptAttachment(dependencies: {
  readMaxSeats?: () => number;
  db: Database.Database;
  governance: PlanGovernance;
  endpoints: Map<string, Pick<import("./adapters/worker-mailbox-bridge.js").WorkerMailboxBridge, "binding" | "endpoint">>;
  runtime: () => WorkflowRuntime | undefined;
  owners: () => { chat?: MailboxRepository; delivery?: MailboxDelivery };
  /** The roots in force for this daemon: the daemon's own state tree. */
  roots: () => ManagedWorkerRoots;
}) {
  return async (input: import("./domain/startup-orchestrator.js").StartupInput):
    Promise<import("./domain/runtime-adapter.js").ManagedAttempt | undefined> => {
    const client = input.adapter.runtime;
    if (client !== "claude-code" && client !== "codex" && client !== "gemini") return undefined;
    const seat = input.sessionName ?? input.binding.tmuxSession;
    if (!seat) return undefined;
    // A seat may be the destination of at most one live task. Two is not a choice this
    // composition may make: attaching either would hand one assignment another's binding.
    // The dispatcher already made that choice, so a launch it started names its task and the
    // row is checked against it rather than the seat being refused outright.
    const rows = dependencies.db.prepare(`
      SELECT a.qitem_id AS qitemId, a.run_id AS runId, a.task_id AS taskId,
        q.source_session AS sourceSession
      FROM team_queue_authority a
      JOIN queue_items q ON q.qitem_id = a.qitem_id
      JOIN team_runs r ON r.id = a.run_id
      WHERE q.destination_session = ? AND q.state IN ('pending', 'in-progress') AND r.state = 'approved'
        AND (? IS NULL OR a.run_id = ?) AND (? IS NULL OR a.task_id = ?)
      LIMIT 2`).all(seat, input.runId ?? null, input.runId ?? null, input.taskId ?? null, input.taskId ?? null) as
        Array<{ qitemId: string; runId: string; taskId: string; sourceSession: string | null }>;
    if (rows.length === 0 && input.runId === undefined && input.taskId === undefined) return undefined;
    if (rows.length !== 1) throw new Error("Managed launch task is ambiguous");
    const row = rows[0]!;
    const task = dependencies.governance.getTask(row.qitemId);
    // made the task record the store for outputs and permissions; a row without one
    // predates it and cannot describe an attempt this composition may produce.
    if (!task) throw new Error("Managed attempt task is not recorded");
    const assignment = task.assignment;
    const runtime = dependencies.runtime();
    if (!runtime) throw new Error("Managed launch runtime is unavailable");
    const roots = dependencies.roots();
    const worker = roots.worker;
    // The worker is this daemon's own user, so its identity comes from the process.
    const identity = new WorkerIdentities(() => ({ workerRoot: roots.workerRoot,
      assignmentRoot: roots.assignmentRoot, identities: roots.workerIdentities })).resolve(worker);
    const run = dependencies.governance.getRun(row.runId);
    // The destination session names a seat on the run's own rig; a row that resolves to a
    // seat elsewhere would attach this attempt to a binding it never authorized.
    if (run.rigId !== input.rigId) throw new Error("Managed attempt seat is not on the task's rig");
    const remainingMs = run.binding.limits.maxActiveMs - run.activeMs;
    if (remainingMs <= 0) throw new Error("Managed run active-time limit is exhausted");
    const { chat, delivery } = dependencies.owners();
    if (!chat || !delivery) throw new Error("Managed attempt mailbox owners are unavailable");
    // A native-token resume re-enters the attempt it recorded, so the projection is reused
    // and the launcher receives the exact previous receipt. A token with no recorded receipt
    // refuses: resuming outside the worker boundary is never the fallback.
    const previous = input.resumeToken
      ? recordedManagedReceipt({ db: dependencies.db, governance: dependencies.governance }, {
          seat, nativeToken: input.resumeToken, runId: row.runId, qitemId: row.qitemId, client })
      : undefined;
    if (input.resumeToken && !previous) throw new Error("Managed resume receipt is not recorded");
    const attemptId = previous?.attemptId ?? randomUUID();
    const outputs = task.outputs ?? [], permissions = task.permissions ?? [];
    const remainingDeadline = Date.now() + remainingMs;
    if (previous && previous.deadline <= Date.now()) throw new Error("Managed resume deadline has expired");
    // The launcher refuses a resume whose deadline exceeds the previous receipt's, so the
    // resumed attempt stays inside the run clock the first attempt was given.
    const deadline = previous ? Math.min(previous.deadline, remainingDeadline) : remainingDeadline;
    // Admission is asked first so the candidate exists exactly where the producer will be
    // told to look, and a refusal leaves no tree. `produceManagedAttempt` repeats the same
    // admission for this attempt, which is idempotent and re-takes the same claim.
    const admitted = runtime.admitForLaunch(row.runId, { attemptId, worker, assignment,
      outputs, permissions,
      context: { binding: run.binding, runId: row.runId, role: assignment.role, workflow: task.workflow } as
        unknown as import("./integrations/framework/context-manifest.js").ContextManifest });
    let produced: Awaited<ReturnType<WorkflowRuntime["produceManagedAttempt"]>>;
    try {
      const selected = task.workflow;
      if (selected && selected.revision !== FRAMEWORK_PIN.revision) throw new Error("The task's workflow source revision changed");
      const workflow = selected ? prepareFrameworkInvocation({ client, entrypoint: selected.entrypoint,
        origin: selected.origin, binding: run.binding, input: selected.input ??
          (dependencies.db.prepare("SELECT body FROM queue_items WHERE qitem_id = ?").get(task.qitemId) as { body: string }).body,
        readOnly: selected.readOnly }) : undefined;
      if (workflow && "status" in workflow) throw new Error(workflow.reason);
      const capabilityError = selected ? workflowCapabilityRefusal(selected.entrypoint) : null;
      if (capabilityError) throw new Error(capabilityError);
      const frameworkFiles = frameworkInstructionSources(roots.frameworkRoot, selected?.entrypoint);
      // A lead activation carries its protocol, roster and run instructions, and nothing
      // else does. The roster is the rig's seats whose role the approval covers, and the
      // instructions are the daemon's own words about where the decomposition goes; both are
      // read-only entries the manifest projects, so the lead cannot rewrite what it must obey.
      const lead = assignment.role === "lead" ? leadActivation(dependencies.db, {
        rigId: run.rigId, runId: run.id, roles: run.binding.roles, seat, activationId: attemptId,
        goal: (dependencies.db.prepare("SELECT body FROM queue_items WHERE qitem_id = ?").get(task.qitemId) as { body: string }).body,
        // A planning run's lead agrees a plan with the owner first; every other lead
        // activation is the decomposition protocol C3 already had.
        phase: run.phase, planRef: run.binding.planRef, buildRoster: planningRosterRequired(run.binding),
        maxSeats: dependencies.readMaxSeats?.() ?? 6,
      }) : undefined;
      produced = await runtime.produceManagedAttempt(row.runId, {
        attemptId, worker, assignment, outputs, permissions,
        role: assignment.role, client, candidate: admitted.candidate, sessionId: seat,
        rigId: run.rigId, taskId: row.taskId, recipients: row.sourceSession ? [row.sourceSession] : [],
        deadline, isCurrent: () => true, ...(previous ? { previous } : {}),
        delivery, chat, context: { client, discoveryRoots: [], mutableStateRoot: identity.scratch,
          ...(workflow ? { workflow } : {}),
          soul: resolveTeamSoul(dependencies.db, run.rigId, assignment.role,
            (dependencies.db.prepare(`SELECT n.soul_id AS id FROM nodes n JOIN sessions s ON s.node_id = n.id
              WHERE n.rig_id = ? AND s.session_name = ? ORDER BY s.rowid DESC LIMIT 1`).get(run.rigId, seat) as { id: string | null } | undefined)?.id ?? undefined),
          teamSections: teamSectionsText(dependencies.db, run.rigId),
          ...(lead ? { lead } : {}) },
        frameworkFiles,
      });    } catch (error) {
      if (task.workflow) recordWorkflowOutcome(dependencies.db, {
        // A refused resume did not start its next native generation. Keep its launch block
        // separate so retrying that generation can still record the actual native result.
        attemptId: previous ? randomUUID() : attemptId, qitemId: task.qitemId, generation: 1, workflow: task.workflow,
        outcome: { status: "blocked", artifacts: [], reason: (error instanceof Error ? error.message : "Workflow launch failed").slice(0, 16_384) },
      });
      // A fresh failed admission gives its claim back. An exact resume reuses an earlier
      // owner's claim and must preserve that attempt's work for a later retry.
      if (!previous) runtime.releaseCandidate(row.runId, assignment.taskId, attemptId);
      throw error;
    }
    dependencies.endpoints.set(attemptId, produced.bridge);
    return produced.attempt;
  };
}

/** One tree per task, under the assignment root, addressed the way the producer expects. */
function managedCandidateRoot(assignmentRoot: string, worker: string, runId: string, taskId: string): string {
  return nodePath.join(assignmentRoot, worker, `${runId}-${taskId}`);
}

/**
 * Native managed health: no terminal control plane remains.
 *
 * Every worker is a direct child of this daemon, so the boundary, network and client-lock
 * lights report that their subsystem does not exist rather than reading an installed
 * policy nothing enforces.
 */
export function composeSystemHealthReader(dependencies: { db: Database.Database; queue: QueueRepository }): () => Promise<TeamSystemHealth> {
  const absent = () => ({ state: "unknown" as const, evidenceRef: "native:direct-child", reason: "workers_run_unisolated" });
  return createSystemHealthReader({
    isolation: "none",
    database: () => ({ state: "ok", evidenceRef: "database:schema_version:" + String(dependencies.db.prepare("PRAGMA schema_version").pluck().get()) }),
    queueMailbox: () => ({ state: "ok", evidenceRef: "queue:active:" + dependencies.queue.list({ activeOnly: true }).length }),
    controlTmux: async () => ({ state: "unknown", evidenceRef: "native:direct-child", reason: "terminal_control_removed" }),
    workerBoundary: absent, sandboxNetwork: absent, clients: absent,
    latestAttempts: () => attemptsFromRecords(() => new Date(), (dependencies.db.prepare(`SELECT id, run_id AS runId, provider, state, failure_json AS failureJson FROM team_attempts ORDER BY updated_at DESC, id DESC LIMIT 100`).all() as Array<{ id: string; runId: string; provider: "claude" | "codex" | "gemini"; state: string; failureJson: string | null }>).map(row => ({ id: row.id, runId: row.runId, provider: row.provider, state: row.state, failure: storedFailure(row.failureJson) }))),
  });
}

/** The recorded classification of an attempt, or null when it has none or the row is unusable. */
function storedFailure(json: string | null): { reasonCode: string; resumeSafe: boolean } | null {
  if (json === null) return null;
  try { return parseAttemptClassification(JSON.parse(json)); } catch { return null; }
}

export async function createDaemon(opts?: DaemonOptions): Promise<DaemonResult> {
  // The caller names the owner credential, or names none at all. Absence is never filled in from
  // the environment: `startServer` consumes `LOOM_OWNER_TOKEN` before any child starts and
  // passes the result here, so a second read would only ever see the value it deleted. A daemon
  // with no owner credential cannot authenticate the owner surface, so it refuses to start.
  const teamControl = opts?.teamControl ?? { credentials: { ownerToken: null } };
  if (!teamControl.credentials.ownerToken) {
    throw new Error("A managed daemon requires an owner credential: pass teamControl.credentials.ownerToken, "
      + "or start it with LOOM_OWNER_TOKEN set.");
  }
  const daemonHome = os.homedir();
  const configuredCodexHome = process.env.CODEX_HOME || undefined;
  if (configuredCodexHome && !nodePath.isAbsolute(configuredCodexHome)) {
    throw new Error(`CODEX_HOME must be an absolute path for managed seats: ${configuredCodexHome}`);
  }
  const codexHome = configuredCodexHome || nodePath.join(daemonHome, ".codex");
  // Only the explicit selection overrides a pane rc or the legacy PID-home
  // reader. The resolved default remains the writer/network-reader/session root.
  const dbPath = opts?.dbPath ?? ":memory:";
  const db = openDatabase(dbPath);
  markDaemonDatabase(db);
  // The worker control credential owner, built before the managed launch chain is
  // composed because that chain captures the credentials object it authenticates with.
  // `reconcile` revokes every row a previous process left: the plaintext is never durable,
  // so an inherited digest can only name a token this daemon cannot honour.
  const workerControl = new WorkerControlAccess(db, teamControl.credentials);
  workerControl.reconcile();

  // P7 — the daemon's LIFECYCLE record (distinct from the 059 identity record).
  // A new boot mints a fresh epoch, stamps started_at, and clears any prior run's
  // stopped_at/heartbeat. The heartbeat (index.ts post-bind) advances last-seen
  // while running; a clean shutdown (index.ts shutdown, AFTER stopping the timer)
  // stamps stopped_at for THIS epoch.
  const daemonLifecycleStore = new DaemonLifecycleStore(db);
  const daemonBootEpoch = randomUUID();
  daemonLifecycleStore.recordBoot(daemonBootEpoch, new Date().toISOString());

  const rigRepo = new RigRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  const eventBus = new EventBus(db);
  const streamStore = new StreamStore(db, eventBus);
  // Explicit source opt-in only. No sink I/O until a separate drain request.
  const shadow = configureShadowCapture(process.env.LOOM_SHADOW_CAPTURE);
  const slowOpRecorder = opts?.slowOpRecorder ?? (dbPath === ":memory:"
    ? undefined
    : new SlowOpRecorder({
        logPath: nodePath.join(LOOM_HOME, "logs", "slow-operations.jsonl"),
      }));
  configureSyncSiteRecorder(slowOpRecorder);
  // Instrumentation wiring is observe-only: neither a throwing registration
  // call nor a throwing callback body (streamStore.emit) may abort createDaemon
  // or later wrapped work. Guard both boundaries.
  try {
    slowOpRecorder?.setDegradedHandler?.(({ reason, site }) => {
      try {
        streamStore.emit({
          sourceSession: "daemon@kernel",
          body: `slow-operation instrumentation degraded: ${reason} at ${site}`,
          hintType: "observation",
          hintUrgency: "high",
          hintTags: ["daemon", "slow-operation", "observability-degraded"],
        });
      } catch (error) {
        console.error("[slow-operation] degradation notification failed", error);
      }
    });
  } catch (error) {
    console.error("[slow-operation] setDegradedHandler registration failed", error);
  }
  // PL-004 Phase A revision (R1): topology-backed validateRig.
  // Reject `<member>@<unknown-rig>` shapes against the rig registry.
  // Bare ids without `@` are also rejected
  // (no canonical rig binding).
  // OPR.0.4.6.MH1 FR-8: this gate is the ARCHETYPE consumer of the shared
  // parse contract — human-seat classification BEFORE parse, then the
  // greedy first-@ rig (so "member@rig@x" looks up rig "rig@x", misses,
  // and rejects with the same unknown_destination_rig as ever — BR-1).
  const topologyValidateRig = (sessionRef: string): boolean => {
    const parsed = parseSessionName(sessionRef);
    // M1 A4b — @external entity-admission (checked BEFORE the human-CLASS bare-admit,
    // which A2 also makes true for <local>@external): a queue row destinationed to
    // <local>@external is admitted ONLY if the human is REGISTERED (or it is a literal
    // scheme address); an unregistered entity is REFUSED (the 4b site carries the
    // entity-level teaching via externalAdmissionTeaching). Admission is the gateway's
    // job, never the classifier's (arch 8cd30094).
    if (parsed.kind === "external") {
      const reg = loadHumanRegistry();
      const entities = reg.ok ? reg.entities.map((e) => ({ entityId: e.entityId, address: e.address })) : [];
      return resolveExternal(parsed.local, entities).kind !== "unregistered";
    }
    if (isHumanSeatSessionRef(sessionRef)) return true;
    if (parsed.kind !== "canonical") return false;
    return rigRepo.findRigsByName(parsed.rig).length > 0;
  };
  // Seat absence in positively known local topology is advice, never admission
  // authority. Keep every typed destination intact, including adopted aliases.
  const topologyDestinationAdvisory = (sessionRef: string) => {
    const parsed = parseSessionName(sessionRef);
    if (isHumanSeatSessionRef(sessionRef) || parsed.kind !== "canonical") return null;
    const rigs = rigRepo.findUnarchivedRigsByName(parsed.rig);
    if (rigs.length === 0) return null;
    // Membership needs only registered names and logical seat coordinates,
    // not the full inventory projection (activity and lifecycle history).
    for (const rig of rigs) {
      if (db.prepare(`SELECT 1 FROM sessions s JOIN nodes n ON n.id = s.node_id
        WHERE n.rig_id = ? AND s.session_name = ? LIMIT 1`).get(rig.id, sessionRef)) return null;
      if (db.prepare(`SELECT 1 FROM nodes WHERE rig_id = ? AND
        CASE WHEN instr(logical_id, '.') = 0 THEN logical_id
          WHEN instr(logical_id, '.') > 1 AND instr(logical_id, '.') < length(logical_id)
          THEN substr(logical_id, 1, instr(logical_id, '.') - 1) || '-' || substr(logical_id, instr(logical_id, '.') + 1)
        END = ? LIMIT 1`).get(rig.id, parsed.member)) return null;
    }
    const names = rigs.flatMap((rig) => db.prepare(`SELECT n.logical_id, s.session_name
      FROM nodes n LEFT JOIN sessions s ON s.id =
        (SELECT id FROM sessions WHERE node_id = n.id ORDER BY id DESC LIMIT 1)
      WHERE n.rig_id = ?`).all(rig.id) as Array<{ logical_id: string; session_name: string | null }>);
    const canonicalName = (logicalId: string) => {
      const dot = logicalId.indexOf(".");
      if (dot < 0) return `${logicalId}@${parsed.rig}`;
      return dot > 0 && dot < logicalId.length - 1
        ? deriveCanonicalSessionName(logicalId.slice(0, dot), logicalId.slice(dot + 1), parsed.rig) : null;
    };
    const availableDestinations = [...new Set(names.flatMap((entry) => [
      entry.session_name, canonicalName(entry.logical_id),
    ]).filter((destination): destination is string => !!destination && parseSessionName(destination).kind === "canonical"))].sort();
    return {
      code: "unmatched_destination_seat" as const,
      destinationSession: sessionRef,
      availableDestinations,
      message: `Suspected seat typo: '${sessionRef}' matches no session address of locally known rig '${parsed.rig}'. `
        + `Available destinations: ${availableDestinations.join(", ") || "(none)"}. `
        + "The row keeps the exact destination as typed; this warning does not guarantee pickup or delivery.",
    };
  };
  // PL-004 Phase A — shared coordination services. Constructed early so
  // the queueRepo dep slot and the outbox share one instance.
  const queueRepoInstance = new QueueRepository(db, eventBus, {
    validateRig: topologyValidateRig,
    destinationAdvisory: topologyDestinationAdvisory,
    // OPR.0.4.6.WF3 FR-6 — the frontier close-path guard's predicate,
    // INJECTED here (arch layering pin: the queue never imports the
    // workflow domain; startup wires them — the validateRig precedent).
    // GHOST-STAGE (h): resolve the source seat's atom-B generation for the handoff-nudge Sent: line
    // (same injected-predicate layering — the queue never imports the session domain).
    resolveOccupantGeneration: (sessionName) => sessionRegistry.currentOccupantGenerationForSession(sessionName),
  });
  const launchPath = process.env.PATH ?? "";
  const startupSettings = new ContextPackSettingsStore().resolveConfig();
  // One governance owner serves the app and the managed launch chain.
  // What a new run's binding is approved against. Nothing is installed beyond the daemon's own
  // roots, so the daemon states their revision and a fingerprint naming that posture.
  const runPolicyCapability = teamControl.readPolicyCapability
    ?? (() => unisolatedPolicyCapability(unisolatedWorkerRoots(LOOM_HOME).policyRevision));
  // Governance checks each task against the same reader the start route approved the run with.
  const teamGovernance = new PlanGovernance(db, eventBus, queueRepoInstance, undefined, runPolicyCapability);
  // The roots in force for this daemon: the daemon's own state tree, so nothing in the launch
  // path ever reads an installed policy.
  const roots = unisolatedWorkerRoots(LOOM_HOME);
  const rootsNow = () => roots;
  const lastWorkerHeartbeat = new Map<string, number>();
  const managedLaunch = composeDirectLaunch({ governance: teamGovernance, rigRepo,
        workflowRuntime: () => workflowRuntime,
        // Every supervised turn records its durable lifecycle facts through governance.
        lifecycle: fact => teamGovernance.recordAttemptLifecycle(fact),
        onEvent: (facts, event) => {
          // The lifecycle recorder owns acknowledgment; notifications only wake live projections.
          if (event.type === "attempt.acknowledged") return;
          if (event.type === "heartbeat") {
            const now = Date.now(), last = lastWorkerHeartbeat.get(facts.attemptId);
            if (last !== undefined && now - last < 15_000) return;
            lastWorkerHeartbeat.set(facts.attemptId, now);
          }
          const run = teamGovernance.getRun(facts.runId);
          eventBus.emit({ type: "team.control", protocolVersion: "1.0", eventId: randomUUID(), rigId: run.rigId,
            runId: run.id, taskId: facts.taskId, attemptId: facts.attemptId, entityId: facts.attemptId,
            entityVersion: run.entityVersion, action: `worker.${event.type}`, payload: workerEventNotification(event) });
        },
        ...(opts?.directLaunchCommand ? { command: opts.directLaunchCommand } : {}),
        ...(opts?.directLaunchExecutable ? { executablePath: opts.directLaunchExecutable } : {}),
        ...(opts?.directLaunchSupervise ? { supervise: opts.directLaunchSupervise } : {}),
        // The client's own provider traffic follows the owner's proxy, read at each launch.
        settingsStore: new ContextPackSettingsStore() });
  const workerLauncher = { workerLauncher: managedLaunch.launcher };
  const launcher = managedLaunch.launcher;
  // The attachment every managed launch path resolves through. Assigned once the runtime
  // exists below; a wrapper that reads it at launch time is the only correct shape, because the
  // runtime is constructed later in this function and no managed launch precedes it.
  let managedAttempt: ((input: import("./domain/startup-orchestrator.js").StartupInput) =>
    Promise<import("./domain/runtime-adapter.js").ManagedAttempt | undefined>) | undefined;
  // The reader, composed from the owners above and injected through the one teamControl options object.
  // A caller that supplied its own reader keeps it: that is the injection seam the tests and
  // any embedding host use.
  const teamControlOptions: NonNullable<AppDeps["teamControl"]> = { ...teamControl, readSystemHealth: teamControl.readSystemHealth
    ?? composeSystemHealthReader({ db, queue: queueRepoInstance }),
    // The capability a start request approves its binding against.
    readPolicyCapability: runPolicyCapability,
    // Where a planning run's plan worktree lives. The default is the short root
    // the worktree policy names (`%LOCALAPPDATA%\Loom\wt` on Windows, `~/.loom/wt`
    // elsewhere), because Git for Windows refuses a worktree path above a measured ceiling. The
    // policy preflights every path against that ceiling, so a root that is too deep is refused
    // by name rather than failing inside Git.
    planWorktreeRoot: teamControl.planWorktreeRoot ?? defaultWorktreeRoot,
    ...(!teamControl.resolveBinding ? { resolveBinding: run => refreshPlanBinding(run.binding, runPolicyCapability()!) } : {}) };
  // The seat capability a managed send must reuse. `createApp` builds the mailbox
  // owner when none is supplied, so this rides the deps slot rather than constructing it
  // twice: one owner, one seat table.
  // The mailbox owner `createApp` builds reads this slot (through `deps`), so a managed send
  // reuses the seat's recorded value instead of minting a second one.
  const seatCapabilities = new SeatMailboxCapabilities(db);
  const readSeatMailboxCapability = (runId: string, sessionId: string) => seatCapabilities.find(runId, sessionId);
  // The managed owner read projection, composed over the same owners the
  // daemon already built. A caller that supplied one keeps it: that is the
  // injection seam the tests and any embedding host use.
  if (!teamControlOptions.readModel) {
    teamControlOptions.readModel = new TeamReadModel({
      db,
      governance: teamGovernance,
      events: eventBus,
      readTaskWorkspace: (runId, taskId) => {
        const candidate = workflowRuntime?.existingCandidate(runId, taskId);
        return candidate ? { root: candidate.root, sourceRoot: candidate.sourceRoot,
          baseCommit: candidate.base.kind === "commit" ? candidate.base.commit : null } : null;
      },
      readTaskRows: (runId: string) => (db.prepare(
        `SELECT a.qitem_id AS qitemId, a.task_id AS taskId,
          json_extract(a.assignment_json, '$.role') AS role,
          q.state AS queueState, q.destination_session AS session
          FROM team_queue_authority a JOIN queue_items q ON q.qitem_id = a.qitem_id
          WHERE a.run_id = ? ORDER BY a.task_id`).all(runId) as Array<{
            qitemId: string; taskId: string; role: string; queueState: string; session: string | null }>),
    });
  }
  // #275: one reader for both Codex launch adapters, with the PATH, HOME and CODEX_HOME a seat session gets.
  const { StartupOrchestrator } = await import("./domain/startup-orchestrator.js");
  const { ClaudeCodeAdapter } = await import("./adapters/claude-code-adapter.js");
  const { CodexRuntimeAdapter } = await import("./adapters/codex-runtime-adapter.js");
  const { GeminiRuntimeAdapter } = await import("./adapters/gemini-runtime-adapter.js");
  const fsOps = {
    readFile: (file: string) => fs.readFileSync(file, "utf8"),
    writeFile: (file: string, content: string) => fs.writeFileSync(file, content, "utf8"),
    exists: (file: string) => fs.existsSync(file),
    mkdirp: (dir: string) => fs.mkdirSync(dir, { recursive: true }),
    copyFile: (src: string, dest: string) => fs.copyFileSync(src, dest),
    listFiles: (dir: string) => fs.readdirSync(dir),
    readdir: (dir: string) => fs.readdirSync(dir),
    statMode: (file: string) => fs.statSync(file).mode,
    chmod: (file: string, mode: number) => fs.chmodSync(file, mode),
    homedir: daemonHome,
  };
  const startupOrchestrator = new StartupOrchestrator({ db, sessionRegistry, eventBus,
    managedAttempt: input => managedAttempt?.(input) ?? Promise.resolve(undefined) });
  const claudeAdapter = new ClaudeCodeAdapter({ fsOps, ...workerLauncher });
  const codexAdapter = new CodexRuntimeAdapter({ fsOps, ...workerLauncher });
  const geminiAdapter = new GeminiRuntimeAdapter(workerLauncher);
  const agentActivityStore = new AgentActivityStore({ db, eventBus,
    resolveOccupantGeneration: (nodeId) => sessionRegistry.currentOccupantTenure(nodeId)?.generationUuid ?? null,
    isRegisteredOccupantGeneration: (nodeId, generation) => sessionRegistry.isOccupantGenerationRegistered(nodeId, generation) });
  // The one mailbox owner. Its channel reader is the daemon's own observed activity, so it is
  // composed here where both the store and the owner exist, and `createApp` is handed a
  // finished object rather than the parts it would otherwise assemble a second one from.
  const runtimeAdapters = { "claude-code": claudeAdapter, codex: codexAdapter, gemini: geminiAdapter };
  const chatRepository = new MailboxRepository(db);
  const mailboxDelivery = new MailboxDelivery(chatRepository, createMailboxPromptStateReader({
    db,
    agentActivityStore,
    observedSince: new Date().toISOString(),
  }), undefined, readSeatMailboxCapability);
  // The GitHub accounts delivery and intake share. Composed with the network proxy the owner's
  // settings name, read at each spawn so a change applies to the next upload.
  const github = new GithubCli();
  const githubAgent = new GithubCli({ env: { ...process.env, GH_CONFIG_DIR: getStatePath("github-agent") } });

  // The candidate runtime. It owns where a task's work tree is created and reads
  // the files a lead and a worker write; nothing here instantiates a workflow.
  const queueRepoForWorkflow = queueRepoInstance;
  let workflowRuntime: WorkflowRuntime | undefined;
  let integration: AppDeps["integration"];
  if (queueRepoForWorkflow) {
    // The runtime owns where a candidate is created. The roots are the daemon's own state
    // tree, so nothing in the launch path ever reads an installed policy.
    // The producer's remaining inputs, from owners this composition already holds —
    // the roots for identity and layout, the control database for the seat's capability,
    // and the credential owner above for the token its endpoint authenticates with.
    const managedInputs = {
      identities: new WorkerIdentities(() => {
        const policy = rootsNow();
        return { workerRoot: policy.workerRoot, assignmentRoot: policy.assignmentRoot, identities: policy.workerIdentities };
      }),
      capabilities: seatCapabilities,
      credentials: workerControl,
    };
    workflowRuntime = new WorkflowRuntime({
      db,
      eventBus,
      queueRepo: queueRepoForWorkflow,
      assignmentRoot: () => rootsNow().assignmentRoot,
      defaultWorker: () => rootsNow().worker,
      candidateRoot: (runId: string, taskId: string, worker: string) =>
        managedCandidateRoot(rootsNow().assignmentRoot, worker, runId, taskId),
      candidateRecordsRoot: () => nodePath.join(rootsNow().controlStateDir, "candidates"),
      // Where the producer writes the attempt's projection and mailbox, and the
      // ownership facts it cannot derive itself.
      managedAttemptRoots: () => {
        const roots = rootsNow();
        return { contextRoot: roots.contextRoot, mailboxRoot: roots.mailboxRoot,
          controlStateDir: roots.controlStateDir, policyRevision: roots.policyRevision,
          workerIdentities: roots.workerIdentities, frameworkRoot: roots.frameworkRoot,
          frameworkRevision: FRAMEWORK_PIN.revision, toolchainDir: roots.toolchainDir };
      },
      // The worker is the daemon's own user, so the projection's private-ownership checks
      // prove nothing (there is one identity) and are skipped by name rather than satisfied
      // by construction.
      sameIdentity: true,
      managedAttemptInputs: {
        issueCredential: (runId: string, sessionId: string) => managedInputs.credentials.issue(runId, sessionId),
        hasCredential: (runId: string, sessionId: string) => managedInputs.credentials.has(runId, sessionId),
        // A read, never a mint: the endpoint authenticates every request through this, and a
        // request against a revoked seat must not bring its credential back.
        readCredentials: () => managedInputs.credentials.readCredentials(),
        mailboxCapability: (runId: string, sessionId: string) => managedInputs.capabilities.forSeat(runId, sessionId),
        workerIdentity: (worker: string) => managedInputs.identities.resolve(worker),
      },
      onManagedAttemptRetired: (attempt: { runId: string; sessionId: string }) =>
        managedInputs.credentials.retire(attempt.runId, attempt.sessionId),
    });
    // The run's integration branch. The worktree root is the one plan worktree lives
    // under, and the patch is the runtime's own candidate read, so what lands is exactly the
    // work the reviewer approved and `loom team apply` would have applied.
    {
      const { composeIntegration } = await import("./domain/integration-branch.js");
      integration = composeIntegration({
        db, governance: teamGovernance,
        worktreeRoot: () => teamControlOptions.planWorktreeRoot!(),
        candidateManifest: (runId: string, taskId: string) => {
          if (!workflowRuntime) throw new Error("Candidate runtime is unavailable");
          return workflowRuntime.candidateManifestFor(runId, taskId);
        },
        sourceRefMoved: (repository, move) => workflowRuntime?.acceptOwnerMerge(repository, move),
        // The binding every other command reads: the plan at the worktree's current head. A
        // commit the daemon just landed moves that head, and the recorded binding has to move
        // with it or the next dispatch would see a run whose plan changed under it.
        ...(runPolicyCapability ? { currentBinding: (runId: string) => {
          const run = teamGovernance.getRun(runId), policy = runPolicyCapability();
          return policy ? refreshPlanBinding(run.binding, policy) : run.binding;
        } } : {}),
      });
      teamControlOptions.integrateTask = (runId: string, taskId: string) => integration!.integrate(runId, taskId);
    }
    // Assigned here, after the runtime it produces through exists and before the app
    // serves: every seat launch that could reach a worker happens after this point.
    managedAttempt = managedLaunch ? composeManagedAttemptAttachment({
      readMaxSeats: () => Number(settingsStore.resolveOne("team.maxSeats").value ?? 6),
      db, governance: teamGovernance, endpoints: managedLaunch.endpoints,
      runtime: () => workflowRuntime,
      owners: () => ({ chat: chatRepository, delivery: mailboxDelivery }),
      roots: rootsNow,
    }) : undefined;
  }

  const settingsStore = new SettingsStore();

  // What a new task starts. A start request dispatches the agent it puts work on, because
  // nothing else ever launches a seat.
  const { composeTaskDispatch } = await import("./domain/task-dispatch.js");
  // The run's live-session count and its limit, asked before a client starts. Both are
  // read from the run's own rows and binding, so the dispatcher cannot disagree with the
  // governance gate that enforces the same limit when the launch's receipt is registered.
  const liveSessions = (runId: string) => (db.prepare(
    "SELECT count(*) AS count FROM team_attempts WHERE run_id = ? AND state IN ('running', 'unknown')")
    .get(runId) as { count: number }).count;
  const maxSessions = (runId: string) => teamGovernance.getRun(runId).binding.limits.maxSessions;
  teamControlOptions.dispatch = composeTaskDispatch({ rigRepo, sessions: sessionRegistry, startupOrchestrator, runtimeAdapters,
    prepareDeliveryLeadTurn: (runId, taskId) => {
      if (!workflowRuntime) throw new Error("Candidate runtime is unavailable");
      return workflowRuntime.prepareDeliveryLeadTurn(runId, taskId);
    },
    liveSessions, maxSessions, renewApproval: runId => teamGovernance.renewImplementationApproval(runId) });
  // A task admitted while the run was at its limit used to wait forever: nothing tried
  // it again. A freed slot now starts the run's next pending task through the same dispatch,
  // as internal scheduling over the durable queue rather than an owner verb.
  const { composePendingDispatch } = await import("./domain/pending-dispatch.js");
  const dispatchPending = composePendingDispatch({ db, dispatch: () => teamControlOptions.dispatch,
    liveSessions, maxSessions });
  // The other end of that dispatch. A direct launch's receipt names the client process
  // the seat runs, and nothing wrote or closed the attempt from it, so a task could never be
  // observed to finish. This path admits the attempt when its receipt lands, records it stopped
  // when the process it named is gone, and records the daemon-verifiable outcome.
  const { composeAttemptCompletion } = await import("./domain/attempt-completion.js");
  const { AttemptTelemetry } = await import("./domain/attempt-telemetry.js");
  // The lead as manager: what its turn delivered, and what its team did since it spoke.
  // It runs on this sweep's cadence (one owner of "the queue as it is now") and asks the same
  // dispatch every other launch uses, so nothing here starts a client of its own.
  const { composeLeadManager } = await import("./domain/lead-manager.js");
  // The run's current binding, read the way every control command reads it.
  const currentBinding = (runId: string) => {
    const run = teamGovernance.getRun(runId), policy = runPolicyCapability?.();
    return policy ? refreshPlanBinding(run.binding, policy) : run.binding;
  };
  const leadManager = composeLeadManager({ db, governance: teamGovernance,
    readLeadProposal: (runId, taskId) => {
      if (!workflowRuntime) throw new Error("Candidate runtime is unavailable");
      return workflowRuntime.leadProposalWithSeatsFor(runId, taskId);
    },
    readMaxSeats: () => Number(settingsStore.resolveOne("team.maxSeats").value ?? 6),
    currentBinding, dispatch: () => teamControlOptions.dispatch });
  // The direct worker's mutable state root: each attempt's prompt, its captured Codex thread
  // id and its final message live under it. One value, so the readers of a turn's end cannot
  // disagree about where.
  const turnStateRoot = nodePath.join(rootsNow().workerRoot, rootsNow().worker, "scratch");
  const telemetry = new AttemptTelemetry(db, { turnStateRoot });
  const { composeTaskThreads, declinePath } = await import("./domain/task-thread.js");
  const { agentTurnOutputPaths } = await import("./domain/agent-turn.js");
  const taskThreads = composeTaskThreads({ db, governance: teamGovernance, turnStateRoot, dispatch: () => teamControlOptions.dispatch });
  // A restart reconciles the attempts its predecessor left running before the first sweep.
  const { bootReconcileAttempts } = await import("./domain/boot-recovery.js");
  const attemptCompletion = composeAttemptCompletion({ db, governance: teamGovernance, sessions: sessionRegistry,
    turnStateRoot, telemetry,
    reconcileOnBoot: () => bootReconcileAttempts({ db, governance: teamGovernance }),
    // A native turn's own end: the supervisor writes what it observed to the attempt's
    // output, and that is the classifier's evidence now that no pane holds an exit status.
    turnExit: attemptId => readSupervisorExit(turnStateRoot, attemptId),
    captureTurnDocuments: attempt => {
      if (attempt.role !== "lead" || !teamGovernance.documents(attempt.runId)) return;
      const run = teamGovernance.getRun(attempt.runId), lead = teamGovernance.leadTask(attempt.runId);
      try {
        if (!lead || !workflowRuntime) throw new Error("The document reader is not available.");
        teamGovernance.captureLeadDocuments(attempt.runId, attempt.id,
          workflowRuntime.documentsFor(attempt.runId, lead.taskId, run.binding.planRef));
      } catch {
        teamGovernance.captureLeadDocuments(attempt.runId, attempt.id, {}, "The lead's document files could not be saved. Ask the lead to repair them.");
      }
    },
    readTaskReport: (runId, attemptId) => {
      if (!workflowRuntime) throw new Error("Candidate runtime is unavailable");
      return workflowRuntime.taskReportFor(runId, attemptId, turnStateRoot);
    },
    candidateManifestFor: (runId, taskId) => {
      if (!workflowRuntime) throw new Error("Candidate runtime is unavailable");
      return workflowRuntime.candidateManifestFor(runId, taskId);
    },
    readLeadProposal: (runId, taskId) => {
      if (!workflowRuntime) throw new Error("Candidate runtime is unavailable");
      return workflowRuntime.leadProposalFor(runId, taskId);
    },
    // A delivery lead's second deliverable is the question only the owner can answer.
    readLeadEscalation: (runId, taskId) => {
      if (!workflowRuntime) throw new Error("Candidate runtime is unavailable");
      const escalation = workflowRuntime.leadEscalationFor(runId, taskId);
      return escalation === null ? null : { optionCount: escalation.options.length };
    },
    // The exit evidence a direct launch leaves behind. The seat's pane is where the
    // client ran, so tmux's own record of that pane ending (its dead flag and exit status)
    // and the last lines it held are the only structured evidence available without a
    // wrapper around the native client. Both reads are read-only; a pane this daemon cannot
    // see yields no evidence, which the classifier treats as "not classified", never a retry.
    // The launch stamps the task it starts into the pane, so a seat with two live tasks — two
    // completed implementers are two pending reviews on the same reviewer seat — still admits
    // the attempt the receipt names.
    // The end of a lead's turn is the lead's reply in the run's chat, and a message that
    // waited for that turn is the next turn's prompt. The conversation owner reads the turn's
    // recorded final message and asks the same dispatch for the next turn. adds the one
    // other thing the turn can say: the decision it asked the owner for.
    stoppedOwners: [
      { name: "lead-chat", complete: composeLeadTurnEnd({ db, governance: teamGovernance, turnStateRoot,
        readEscalation: (runId, taskId) => workflowRuntime ? workflowRuntime.leadEscalationFor(runId, taskId) : null,
        dispatch: () => teamControlOptions.dispatch }) },
      { name: "lead-proposal", complete: attempt => leadManager.turnEnd(attempt) },
      { name: "task-comments", complete: attempt => taskThreads.attemptStopped(attempt) },
      { name: "github-comments", complete: attempt => githubSource?.attemptStopped(attempt,
        declinePath(agentTurnOutputPaths(turnStateRoot, attempt.id).taskReport)) },
    ],
    // An approving review is the run's signal to deliver: the implementer's task lands as
    // one commit on the run's branch, through the same owner the merge route reads.
    ...(integration ? { integrateTask: (runId: string, taskId: string) => integration!.integrate(runId, taskId) } : {}),
    // The facts no single attempt produces — a failed retry, an exhausted review, an
    // integration conflict, every task done — are read once per tick, after the attempts.
    onSweep: async () => { await leadManager.sweep(); await taskThreads.sweep(); await pullRequestDelivery?.sweep(); await githubSource?.sweep(); await githubIntake?.sweep(); },
    dispatchPending,
    currentBinding });
  // The owner's cancel stops the work. Dispatch closure is the
  // governance eligibility check that already refuses every command outside `approved`;
  // this owner adds the two things nothing did: end the processes the run launched, and
  // record the observation once the sweep above has seen them end.
  const { composeCancellation } = await import("./domain/team-cancellation.js");
  teamControlOptions.cancellation = composeCancellation({ db, governance: teamGovernance });

  // The daemon's event-loop health: a lag histogram and a tick stamp, so /healthz can say whether
  // a listening daemon is still answering.
  const { EventLoopMonitor } = await import("./domain/event-loop-monitor.js");
  const { RouteTimingRecorder } = await import("./domain/route-timing-recorder.js");
  const requestPhaseObserver = slowOpRecorder?.recordDiagnostic ? new RequestPhaseObserver(slowOpRecorder) : undefined;
  const eventLoopMonitor = new EventLoopMonitor({ onTick: (at, previous) => requestPhaseObserver?.tick(at, previous) });
  const routeTimingRecorder = new RouteTimingRecorder();
  // `ui.enabled` (default off): read once at start.
  const webUiEnabled = opts?.webUiEnabled ?? new ContextPackSettingsStore().resolveOne("ui.enabled").value === true;
  // The GitHub side of delivery: the pull request a run's branch becomes, the reviews and CI that
  // come back to it, and the issues that start a run. Composed only where a run can be delivered.
  let pullRequestDelivery: AppDeps["pullRequestDelivery"], githubSource: AppDeps["githubSource"], githubIntake: AppDeps["githubIntake"];
  if (integration) {
    const { composePullRequestDelivery } = await import("./domain/pull-request-delivery.js");
    pullRequestDelivery = composePullRequestDelivery({ db, governance: teamGovernance, integration,
      agent: githubAgent, owner: github });
    const { composeGithubSource } = await import("./domain/github-source.js");
    githubSource = composeGithubSource({ db, governance: teamGovernance, agent: githubAgent, owner: github,
      dispatch: () => teamControlOptions.dispatch });
    const { composeGithubIntake } = await import("./domain/github-intake.js");
    const { commandAssessor } = await import("./domain/intake-assessor.js");
    const { startTeamRun } = await import("./routes/team-start.js");
    const { resolveExecutable } = await import("./domain/executable-resolver.js");
    const intakeActor = { kind: "owner" as const, sessionId: "github-intake" };
    githubIntake = composeGithubIntake({ db, agent: githubAgent, owner: github,
      assess: commandAssessor({ resolve: client => {
        if (client !== "claude-code" && client !== "codex" && client !== "gemini") return null;
        const configured = opts?.directLaunchExecutable?.(client);
        const resolution = resolveExecutable(client === "claude-code" ? "claude" : client, configured ? { configuredPath: configured } : {});
        return resolution.ok ? resolution : null;
      } }),
      start: async (rigId, goal, displayName) => {
        const outcome = await startTeamRun(teamGovernance, rigRepo,
          { ...teamControlOptions, settingsStore }, intakeActor,
          { goal, rig: rigId, planning: true, displayName });
        if (outcome.status !== 201) throw new Error(String(outcome.body.error ?? outcome.body.code ?? "The start was refused."));
        return String(outcome.body.runId);
      } });
  }

  // The dependency object is built once, after every owner exists: nothing below reaches back
  // into it, so what the routes see is exactly what this composition decided.
  const deps: AppDeps = {
    teamControl: teamControlOptions,
    teamGovernance,
    readSeatMailboxCapability,
    mailboxDelivery,
    github, githubAgent,
    rigRepo, db, daemonLifecycleStore, daemonBootEpoch, eventBus,
    workflowRuntime,
    workerLauncher: launcher,
    attemptCompletion,
    integration,
    pullRequestDelivery,
    githubSource,
    githubIntake,
    attemptTelemetry: telemetry,
    settingsStore,
    slowOpRecorder,
    requestPhaseObserver,
    eventLoopMonitor,
    routeTimingRecorder,
    bindPlan: opts?.bindPlan,
    requestShutdown: opts?.requestShutdown,
    legacyBearerToken: opts?.bearerToken ?? null,
    webUiEnabled,
    selfNameDiscovery: () => discoverTailscaleSelfNames({ timeoutMs: 1500 }),
  };
  const app = createApp(deps);
  return { app, db, deps, eventLoopMonitor };
}
