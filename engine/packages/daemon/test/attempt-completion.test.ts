import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { initializeDatabase } from "../src/db/baseline.js";
import { TEAM_CONTROL_VERSION, type ControlRequest } from "../src/contracts/team-control.js";
import { composeAttemptCompletion, extractReviewerReport, type AttemptCompletionDependencies } from "../src/domain/attempt-completion.js";
import { agentTurnOutputPaths } from "../src/domain/agent-turn.js";
import { bootReconcileAttempts } from "../src/domain/boot-recovery.js";
import { pendingTasks } from "../src/domain/pending-dispatch.js";
import { EventBus } from "../src/domain/event-bus.js";
import { WorkflowRuntime, dependencySatisfied } from "../src/domain/workflow-runtime.js";
import { leadTeamEvents } from "../src/domain/lead-manager.js";
import { PlanGovernance, hashBinding } from "../src/domain/plan-governance.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { roleConfiguration } from "../src/domain/role-configuration.js";
import { bindingForGoal, unisolatedPolicyCapability } from "../src/routes/team-start.js";
import { FRAMEWORK_PIN } from "../src/integrations/framework/catalog.js";

const owner = { kind: "owner", sessionId: "owner-control" } as const;
const unavailable = { value: null, reason: "provider did not report usage" };
const usage = { activeMs: 0, inputTokens: unavailable, outputTokens: unavailable, costUsd: unavailable };

describe("U4 daemon-recorded outcomes", () => {
  let root: string;
  let turnRoot: string;
  let db: Database.Database;
  let governance: PlanGovernance;
  let binding: ReturnType<typeof bindingForGoal>;
  let taskQitemId: string;
  let attemptId: string;
  let serial = 0;

  const request = (actionId: string, payload: unknown): ControlRequest<unknown> => ({
    protocolVersion: TEAM_CONTROL_VERSION,
    runId: "run",
    actionId,
    expectedEntityVersion: governance.getRun("run").entityVersion,
    idempotencyKey: `fixture-${++serial}`,
    payload,
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "u4-outcomes-"));
    turnRoot = mkdtempSync(join(tmpdir(), "u4-turns-"));
    execFileSync("git", ["init", "-q", root]);
    writeFileSync(join(root, "plan.md"), "Approved goal.\n");
    execFileSync("git", ["-C", root, "add", "plan.md"]);
    execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);

    const policy = unisolatedPolicyCapability(1);
    binding = { ...bindingForGoal({ root, planRef: "plan.md", writePaths: ["src"], policy }),
      limits: { maxSessions: 2, maxActiveMs: 3_600_000, maxRetries: 1, maxReviewRounds: 2 } };
    db = createDb(join(turnRoot, "state.sqlite"));
    initializeDatabase(db);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'fixture')").run();
    const bus = new EventBus(db);
    governance = new PlanGovernance(db, bus, new QueueRepository(db, bus), () => new Date("2026-11-06T00:00:00.000Z"), () => policy);
    governance.createRun({ id: "run", rigId: "rig", binding, reviewerSeat: "reviewer@rig" });
    governance.requestApproval(request("approval", { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest: hashBinding(binding) }, targetDigest: hashBinding(binding), expiresAt: "2026-11-06T01:00:00.000Z" }), owner);
    governance.decideApproval(request("approval", { approvalVersion: 1, decision: "approved" }), owner, binding);
    const created = governance.createTask(request("task", {
      assignment: { taskId: "task", role: "implementer", paths: ["src"], dependencies: [] },
      outputs: ["src/a.ts"], permissions: [...roleConfiguration.implementer.permissions],
      sourceSession: "lead@rig", destinationSession: "implementer@rig", body: "Implement the task",
    }), binding);
    expect(created.status).toBe("accepted");
    taskQitemId = (created.value as { qitemId: string }).qitemId;
    attemptId = "attempt-1";
    governance.recordAttempt(request(attemptId, {
      qitemId: taskQitemId, role: "implementer", provider: "claude",
      identity: { nativeSessionId: "native", tmuxServer: "/tmp/tmux.sock", paneId: "%1", processId: 123,
        processStart: "start-1", generation: 1, policyFingerprint: binding.policyFingerprint },
      unknownReason: null, state: "running", usage,
    }), binding);
  });

  afterEach(() => {
    if (db?.open) db.close();
    if (root) rmSync(root, { recursive: true, force: true });
    if (turnRoot) rmSync(turnRoot, { recursive: true, force: true });
  });

  const manifest = (patch: string) => ({ base: "commit" as const, baseIdentifier: "a".repeat(40), files: [{ path: "src/a.ts" }],
    manifestDigest: `sha256:${"b".repeat(64)}`, patch });

  const completion = (candidateManifestFor: (runId: string, taskId: string) => ReturnType<typeof manifest>, readLeadProposal?: (runId: string, taskId: string) => readonly unknown[], overrides: Partial<AttemptCompletionDependencies> = {}) => composeAttemptCompletion({
    db, governance, currentBinding: () => structuredClone(binding), alive: () => false, log: () => {}, turnStateRoot: turnRoot,
    sessions: { findResumeContextByName: () => null, updateStartupStatus: vi.fn() }, candidateManifestFor,
    ...(readLeadProposal ? { readLeadProposal } : {}),
    readTaskReport: (runId, id) => {
      const eventBus = new EventBus(db);
      return new WorkflowRuntime({ db, eventBus, queueRepo: new QueueRepository(db, eventBus) }).taskReportFor(runId, id, turnRoot);
    },
    ...overrides,
  });

  const addAttempt = (taskId: string, id: string, role: "implementer" | "reviewer") => {
    const task = governance.findTask("run", taskId)!;
    return governance.recordAttempt(request(id, {
      qitemId: task.qitemId, role, provider: "claude",
      identity: { nativeSessionId: `native-${id}`, tmuxServer: "/tmp/tmux.sock", paneId: `%${id.length + 1}`,
        processId: 123 + id.length, processStart: `${id}-start`, generation: 1, policyFingerprint: binding.policyFingerprint },
      unknownReason: null, state: "running", usage,
    }), binding);
  };

  const writeTurn = (id: string, message: string) => {
    const path = agentTurnOutputPaths(turnRoot, id).lastMessage;
    mkdirSync(join(turnRoot, "turns", id), { recursive: true });
    writeFileSync(path, message);
  };

  it("records one native workflow outcome per generation without treating a launch as completion", async () => {
    db.prepare("UPDATE team_queue_authority SET workflow_json = ? WHERE qitem_id = ?").run(JSON.stringify({
      entrypoint: "spec-work", origin: "user", readOnly: false, revision: FRAMEWORK_PIN.revision,
    }), taskQitemId);
    expect(governance.workflowOutcomes("run")[0]?.outcome).toBeNull();
    writeTurn(attemptId, '<workflow-outcome>{"status":"complete","artifacts":["src/a.ts"],"summary":"Implemented and checked the requested behavior."}</workflow-outcome>');
    const observe = completion(() => manifest("diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n"));
    await observe.sweep(); await observe.sweep();
    expect(governance.workflowOutcomes("run")).toMatchObject([{ generation: 1, outcome: { status: "complete", artifacts: ["src/a.ts"] } }]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM team_workflow_outcomes").get()).toEqual({ count: 1 });
    expect(governance.queueState(taskQitemId)).toBe("done");
  });
  it("pauses a workflow with no final envelope instead of accepting its changed candidate", async () => {
    db.prepare("UPDATE team_queue_authority SET workflow_json = ? WHERE qitem_id = ?").run(JSON.stringify({
      entrypoint: "spec-work", origin: "caller", readOnly: false, revision: FRAMEWORK_PIN.revision,
    }), taskQitemId);
    await completion(() => manifest("diff --git a/src/a.ts b/src/a.ts\n")).sweep();
    expect(governance.workflowOutcomes("run")[0]?.outcome?.status).toBe("incomplete");
    expect(governance.queueState(taskQitemId)).toBe("blocked");
    expect(governance.getTask(taskQitemId)?.evidence?.taskReport).toMatchObject({ status: "blocked" });
  });
  it("accepts an answer-only read-only workflow only when the candidate stayed unchanged", async () => {
    db.prepare("UPDATE team_queue_authority SET workflow_json = ? WHERE qitem_id = ?").run(JSON.stringify({
      entrypoint: "spec-pov", origin: "user", readOnly: true, revision: FRAMEWORK_PIN.revision,
    }), taskQitemId);
    writeTurn(attemptId, '<workflow-outcome>{"status":"complete","artifacts":[],"summary":"Keep the current interface because its callers need streaming."}</workflow-outcome>');
    await completion(() => manifest("")).sweep();
    expect(governance.queueState(taskQitemId)).toBe("done");
    expect(governance.getRun("run").reviewRoundsUsed).toBe(0);
    const queue = new QueueRepository(db, new EventBus(db));
    expect(dependencySatisfied(db, queue, id => governance.getTask(id)?.evidence?.validated === true, "run", "task")).toBe(true);
  });

  it("extracts the final fenced findings block and rejects missing or malformed reports", () => {
    expect(extractReviewerReport("Earlier```json\n{\"findings\": [{\"id\": \"old\"}]}\n```\nFinal```json\n{\"findings\": []}\n```"))
      .toEqual({ findings: [] });
    expect(extractReviewerReport("no report")).toBeNull();
    expect(extractReviewerReport("```json\n{\"findings\": [}\n```"))
      .toBeNull();
  });

  it("records a validated implementer outcome and review from one stop observation", async () => {
    const observe = completion(() => manifest("diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n"));

    await observe.sweep();

    expect(governance.getAttempt(attemptId)?.state).toBe("stopped");
    expect(governance.queueState(taskQitemId)).toBe("done");
    expect(governance.findTask("run", "task-review-1")?.assignment.role).toBe("reviewer");
    const outcomes = (db.prepare("SELECT payload FROM events WHERE type = 'team.control' AND json_extract(payload, '$.action') = 'task.outcome'").all() as Array<{ payload: string }>)
      .map(row => JSON.parse(row.payload));
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ payload: { observedBy: "daemon" } });

    await observe.sweep();
    expect(db.prepare("SELECT count(*) AS n FROM events WHERE type = 'team.control' AND json_extract(payload, '$.action') = 'task.outcome'").get()).toEqual({ n: 1 });
  });


  it("reconciles an unrecorded stopped outcome after a completion restart", async () => {
    const record = vi.spyOn(governance, "recordTaskOutcome");
    record.mockImplementationOnce(() => { throw new Error("one-shot outcome persistence failure"); });
    const candidate = () => manifest("diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n");

    await completion(candidate).sweep();

    expect(governance.getAttempt(attemptId)?.state).toBe("stopped");
    expect(governance.queueState(taskQitemId)).toBe("pending");
    expect(pendingTasks(db, "run")).toEqual([]);

    db.close();
    db = createDb(join(turnRoot, "state.sqlite"));
    initializeDatabase(db);
    const bus = new EventBus(db);
    governance = new PlanGovernance(db, bus, new QueueRepository(db, bus), () => new Date("2026-11-06T00:00:00.000Z"),
      () => unisolatedPolicyCapability(1));
    await completion(candidate).sweep();

    expect(governance.queueState(taskQitemId)).toBe("done");
    expect(governance.findTask("run", "task-review-1")?.assignment.role).toBe("reviewer");
    expect(governance.getRun("run").reviewRoundsUsed).toBe(1);
    await completion(candidate).sweep();
    expect(governance.getRun("run").reviewRoundsUsed).toBe(1);
  });

  it("reuses a committed outcome receipt before rereading candidate evidence", async () => {
    const original = governance.recordTaskOutcome.bind(governance);
    const record = vi.spyOn(governance, "recordTaskOutcome").mockImplementationOnce((...args) => {
      original(...args);
      throw new Error("crash after the outcome commit");
    });
    const candidate = vi.fn(() => manifest("diff --git a/src/a.ts b/src/a.ts\n"));
    const telemetry = { capture: vi.fn(), recordOutcome: vi.fn() };
    await completion(candidate, undefined, { telemetry }).sweep();
    expect(governance.getRun("run").reviewRoundsUsed).toBe(1);

    candidate.mockImplementation(() => { throw new Error("a newer candidate must not be read"); });
    await completion(candidate, undefined, { telemetry }).sweep();

    expect(record).toHaveBeenCalledTimes(1);
    expect(candidate).toHaveBeenCalledTimes(1);
    expect(telemetry.recordOutcome).toHaveBeenLastCalledWith(attemptId, { outcome: "succeeded", retryScheduled: false });
    expect(governance.getRun("run").reviewRoundsUsed).toBe(1);
  });

  it("counts a boot-interrupted attempt's retry once across an outcome acknowledgement crash", async () => {
    await bootReconcileAttempts({ db, governance, observe: async () => "dead", log: () => {} });
    const original = governance.recordTaskOutcome.bind(governance);
    vi.spyOn(governance, "recordTaskOutcome").mockImplementationOnce((...args) => {
      original(...args);
      throw new Error("crash after retry accounting");
    });
    const candidate = vi.fn(() => manifest(""));
    const telemetry = { capture: vi.fn(), recordOutcome: vi.fn() };
    await completion(candidate, undefined, { telemetry }).sweep();
    expect(governance.getRun("run").retriesUsed).toBe(1);
    await completion(candidate, undefined, { telemetry }).sweep();
    await completion(candidate, undefined, { telemetry }).sweep();
    expect(governance.getRun("run").retriesUsed).toBe(1);
    expect(telemetry.recordOutcome).toHaveBeenLastCalledWith(attemptId, { outcome: "failed", retryScheduled: true });
    expect(candidate).not.toHaveBeenCalled();
  });

  it("resumes unfinished turn owners without repeating acknowledged owners or dispatching early", async () => {
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {}).mockRejectedValueOnce(new Error("second owner unavailable"));
    const dispatchPending = vi.fn(async () => {});
    const overrides = { stoppedOwners: [{ name: "first", complete: first }, { name: "second", complete: second }], dispatchPending };
    const candidate = () => manifest("diff --git a/src/a.ts b/src/a.ts\n");
    await completion(candidate, undefined, overrides).sweep();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(dispatchPending).not.toHaveBeenCalled();
    expect(pendingTasks(db, "run")).toEqual([]);

    await completion(candidate, undefined, overrides).sweep();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    expect(dispatchPending).toHaveBeenCalledWith("run");
    await completion(candidate, undefined, overrides).sweep();
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("persists stop and enrollment atomically", async () => {
    db.exec(`CREATE TRIGGER fail_finalization BEFORE INSERT ON team_attempt_finalizations
      BEGIN SELECT RAISE(ABORT, 'checkpoint failure'); END`);
    const candidate = vi.fn(() => manifest("diff --git a/src/a.ts b/src/a.ts\n"));
    await completion(candidate).sweep();
    expect(governance.getAttempt(attemptId)?.state).toBe("running");
    expect(candidate).not.toHaveBeenCalled();
    db.exec("DROP TRIGGER fail_finalization");
    await completion(candidate).sweep();
    expect(governance.queueState(taskQitemId)).toBe("done");
  });

  it("retries integration after the approved reviewer outcome without another verdict", async () => {
    const candidate = () => manifest("diff --git a/src/a.ts b/src/a.ts\n");
    await completion(candidate).sweep();
    addAttempt("task-review-1", "review-attempt", "reviewer");
    writeTurn("review-attempt", '```json\n{"findings":[]}\n```');
    const integrateTask = vi.fn(async () => {}).mockRejectedValueOnce(new Error("integration unavailable"));
    await completion(candidate, undefined, { integrateTask }).sweep();
    expect(governance.queueState(governance.findTask("run", "task-review-1")!.qitemId)).toBe("done");
    expect(integrateTask).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT count(*) AS n FROM team_attempt_finalizations").get()).toEqual({ n: 1 });
    await completion(candidate, undefined, { integrateTask }).sweep();
    expect(integrateTask).toHaveBeenCalledTimes(2);
    expect(db.prepare("SELECT count(*) AS n FROM team_attempt_finalizations").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM events WHERE json_extract(payload, '$.action') = 'review.verdict'").get()).toEqual({ n: 1 });
  });

  it("does not restart after stop is called during boot reconciliation", async () => {
    let reconciled!: () => void;
    const boot = new Promise<void>(resolve => { reconciled = resolve; });
    const alive = vi.fn(() => true);
    const observe = completion(() => manifest(""), undefined, { reconcileOnBoot: () => boot, alive });
    observe.start(); observe.stop(); reconciled();
    await new Promise(resolve => setImmediate(resolve));
    expect(alive).not.toHaveBeenCalled();
  });

  it("does not backfill historical manually stopped attempts", async () => {
    governance.recordUsage(request(attemptId, { expectedAttemptVersion: 1, state: "stopped", usage }));
    const candidate = vi.fn(() => manifest("diff --git a/src/a.ts b/src/a.ts\n"));
    await completion(candidate).sweep();
    expect(candidate).not.toHaveBeenCalled();
    expect(governance.queueState(taskQitemId)).toBe("pending");
    expect(governance.getRun("run").reviewRoundsUsed).toBe(0);
  });

  it("leaves a newer occupant's seat untouched when an older finalization resumes", async () => {
    const complete = vi.fn(async () => {}).mockRejectedValueOnce(new Error("owner unavailable"));
    const updateStartupStatus = vi.fn();
    const sessions = { findResumeContextByName: () => ({ sessionId: "seat" } as
      NonNullable<ReturnType<AttemptCompletionDependencies["sessions"]["findResumeContextByName"]>>), updateStartupStatus };
    const candidate = () => manifest("diff --git a/src/a.ts b/src/a.ts\n");
    const overrides = { sessions, stoppedOwners: [{ name: "owner", complete }] };
    await completion(candidate, undefined, overrides).sweep();
    expect(updateStartupStatus).not.toHaveBeenCalled();
    governance.createTask(request("next", {
      assignment: { taskId: "next", role: "implementer", paths: ["src"], dependencies: [] },
      outputs: ["src/b.ts"], permissions: [...roleConfiguration.implementer.permissions],
      sourceSession: "lead@rig", destinationSession: "implementer@rig", body: "Next task",
    }), binding);
    addAttempt("next", "newer-attempt", "implementer");

    await completion(candidate, undefined, { ...overrides, alive: () => true }).sweep();

    expect(governance.getAttempt("newer-attempt")?.state).toBe("running");
    expect(updateStartupStatus).not.toHaveBeenCalled();
  });

  it("waits for boot reconciliation before starting timer sweeps", async () => {
    vi.useFakeTimers();
    let reconciled!: () => void;
    const boot = new Promise<void>(resolve => { reconciled = resolve; });
    const alive = vi.fn(() => true);
    const observe = completion(() => manifest(""), undefined, { reconcileOnBoot: () => boot, intervalMs: 10, alive });
    try {
      observe.start();
      await vi.advanceTimersByTimeAsync(50);
      expect(alive).not.toHaveBeenCalled();
      reconciled();
      await vi.advanceTimersByTimeAsync(1);
      expect(alive).toHaveBeenCalledTimes(1);
    } finally {
      observe.stop();
      reconciled();
      vi.useRealTimers();
    }
  });

  it("keeps polling after a transient first-sweep failure", async () => {
    vi.useFakeTimers();
    const alive = vi.fn(() => true);
    const log = vi.fn();
    const prepare = db.prepare.bind(db);
    let fail = true;
    const fault = vi.spyOn(db, "prepare").mockImplementation(sql => {
      if (fail && sql.startsWith("SELECT seq, payload FROM events")) {
        fail = false;
        throw new Error("one-shot database read failure");
      }
      return prepare(sql);
    });
    const observe = completion(() => manifest(""), undefined, { intervalMs: 10, alive, log });
    try {
      observe.start();
      await vi.advanceTimersByTimeAsync(1);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("one-shot database read failure"));
      expect(alive).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10);
      expect(alive).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10);
      expect(alive).toHaveBeenCalledTimes(2);
    } finally {
      observe.stop();
      fault.mockRestore();
      vi.useRealTimers();
    }
  });

  const writeReport = (id: string, content: unknown) => {
    const path = agentTurnOutputPaths(turnRoot, id).taskReport;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  };

  it.each(["blocked", "needs-decision"] as const)("pauses a %s report without a retry; a blocked one goes to the lead, a question to the owner", async status => {
    writeReport(attemptId, { status, question: "Which response is required?", evidence: "The approved plan names two responses." });
    const candidate = vi.fn(() => manifest("diff --git a/src/a.ts b/src/a.ts\n"));
    const observe = completion(candidate);
    await observe.sweep();
    expect(candidate).not.toHaveBeenCalled();
    expect(governance.queueState(taskQitemId)).toBe("blocked");
    expect(governance.getTask(taskQitemId)?.evidence).toMatchObject({
      taskReport: { status, question: "Which response is required?" }, reportedAttemptId: attemptId, validated: false,
    });
    expect(governance.getRun("run")).toMatchObject({ state: "approved", retriesUsed: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM team_chat_messages WHERE kind = 'decision'").get()).toEqual({ n: 0 });
    expect(leadTeamEvents(db, "run")).toEqual(status === "needs-decision" ? [] : [expect.objectContaining({ key: "report:task:" + attemptId,
      note: expect.stringContaining("Which response is required?") })]);
    expect(pendingTasks(db, "run")).not.toContain("task");
  });

  it.each(["implementer", "reviewer"] as const)("closes a dropped %s report without reading a candidate or recording a review verdict", async role => {
    let id = attemptId, qitemId = taskQitemId;
    if (role === "reviewer") {
      await completion(() => manifest("diff --git a/src/a.ts b/src/a.ts\n")).sweep();
      id = "review-attempt"; qitemId = governance.findTask("run", "task-review-1")!.qitemId;
      addAttempt("task-review-1", id, "reviewer");
    }
    writeReport(id, { status: "dropped", evidence: "This task has no remaining work." });
    const candidate = vi.fn(() => manifest(""));
    await completion(candidate).sweep();
    expect(candidate).not.toHaveBeenCalled();
    expect(governance.queueState(qitemId)).toBe("done");
    expect(governance.getTask(qitemId)?.evidence).toMatchObject({ taskReport: { status: "dropped" }, validated: false });
    expect(governance.getRun("run").retriesUsed).toBe(0);
    expect(db.prepare("SELECT count(*) AS n FROM events WHERE json_extract(payload, '$.action') = 'review.verdict'").get()).toEqual({ n: 0 });
    if (role === "implementer") expect(governance.findTask("run", "task-review-1")).toBeNull();
  });

  it("turns malformed report bytes into a paused task with the parse error as its question", async () => {
    writeReport(attemptId, "{");
    await completion(() => manifest("diff --git a/src/a.ts b/src/a.ts\n")).sweep();
    expect(governance.queueState(taskQitemId)).toBe("blocked");
    expect(governance.getTask(taskQitemId)?.evidence).toMatchObject({ taskReport: {
      status: "blocked", question: expect.stringContaining("not valid JSON"),
    } });
    expect(governance.getRun("run")).toMatchObject({ state: "approved", retriesUsed: 0 });
  });

  it("sends invalid candidate evidence to the lead without spending a retry", async () => {
    const observe = completion(() => manifest("diff --git a/docs/outside.md b/docs/outside.md\n+++ b/docs/outside.md\n"));
    await observe.sweep();
    expect(governance.findTask("run", "task-review-1")).toBeNull();
    expect(governance.getTask(taskQitemId)?.evidence).toMatchObject({ validated: false, reasonCode: "evidence_invalid" });
    expect(governance.getAttempt(attemptId)?.failure).toMatchObject({ reasonCode: "evidence_invalid", failureClass: "judgment", retryEligible: false });
    expect(governance.queueState(taskQitemId)).toBe("failed");
    expect(governance.getRun("run")).toMatchObject({ state: "approved", retriesUsed: 0 });
    expect(pendingTasks(db, "run")).toEqual([]);
    expect(leadTeamEvents(db, "run").some(event => event.key.startsWith("failed:task"))).toBe(true);
  });

  it("does not repeat a judgment outcome on later sweeps", async () => {
    const observe = completion(() => manifest("diff --git a/docs/outside.md b/docs/outside.md\n+++ b/docs/outside.md\n"));
    await observe.sweep();
    const version = governance.getTask(taskQitemId)!.entityVersion;
    await observe.sweep();
    expect(governance.queueState(taskQitemId)).toBe("failed");
    expect(governance.getTask(taskQitemId)!.entityVersion).toBe(version);
    expect(governance.getRun("run").retriesUsed).toBe(0);
    expect(pendingTasks(db, "run")).toEqual([]);
  });

  it("records reviewer findings from the final message and reopens on a cited P1", async () => {
    const observe = completion(() => manifest("diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n"));
    await observe.sweep();
    const reviewer = governance.findTask("run", "task-review-1")!;
    addAttempt(reviewer.assignment.taskId, "review-attempt", "reviewer");
    writeTurn("review-attempt", "```json\n" + JSON.stringify({ findings: [{ id: "R1-1", severity: "P1", citation: "KTD8", category: "correctness",
      file: "src/a.ts", scenario: "The changed path fails the task's acceptance check." }] }) + "\n```");

    await observe.sweep();

    expect(governance.queueState(reviewer.qitemId)).toBe("done");
    expect(governance.queueState(taskQitemId)).toBe("pending");
    expect(db.prepare("SELECT json_extract(payload, '$.payload.verdict') AS verdict FROM events WHERE json_extract(payload, '$.action') = 'review.verdict'").get())
      .toEqual({ verdict: "changes-required" });
  });

  it("approves a reviewer report with no blocking findings", async () => {
    const observe = completion(() => manifest("diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n"));
    await observe.sweep();
    const reviewer = governance.findTask("run", "task-review-1")!;
    addAttempt(reviewer.assignment.taskId, "review-attempt", "reviewer");
    writeTurn("review-attempt", "```json\n{\"findings\":[{\"id\":\"R1-2\",\"severity\":\"P3\",\"citation\":\"KTD8\",\"category\":\"style\",\"file\":\"src/a.ts\"}]}\n```");

    await observe.sweep();

    expect(governance.queueState(reviewer.qitemId)).toBe("done");
    expect(governance.queueState(taskQitemId)).toBe("done");
    expect(db.prepare("SELECT json_extract(payload, '$.payload.verdict') AS verdict FROM events WHERE json_extract(payload, '$.action') = 'review.verdict'").get())
      .toEqual({ verdict: "approved" });
  });

  it("sends a missing reviewer report to the lead rather than retrying it", async () => {
    const observe = completion(() => manifest("diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n"));
    await observe.sweep();
    const reviewer = governance.findTask("run", "task-review-1")!;
    addAttempt(reviewer.assignment.taskId, "review-attempt", "reviewer");

    await observe.sweep();

    expect(governance.queueState(reviewer.qitemId)).toBe("failed");
    expect(governance.getAttempt("review-attempt")?.failure).toMatchObject({ reasonCode: "review_report_missing", failureClass: "judgment", retryEligible: false });
    expect(governance.getTask(reviewer.qitemId)?.evidence).toEqual({ reasonCode: "review_report_missing" });
    expect(governance.getRun("run").retriesUsed).toBe(0);
    expect(leadTeamEvents(db, "run").some(event => event.key.startsWith("failed:task-review-1"))).toBe(true);
  });

  it("records a validated lead proposal without creating a review task", async () => {
    // Close the fixture implementer so this test can focus on the lead's own task.
    governance.recordUsage(request(attemptId, { expectedAttemptVersion: 1, state: "stopped", usage }));
    const implementer = governance.findTask("run", "task")!;
    governance.recordTaskOutcome(request(implementer.qitemId, { expectedTaskVersion: implementer.entityVersion, state: "done",
      closureReason: "no-follow-on", actorSession: "implementer@rig", attemptId, expectedAttemptVersion: 2,
      evidence: { validated: true, manifestDigest: `sha256:${"b".repeat(64)}` } }), owner);
    const created = governance.createTask(request("lead-task", {
      assignment: { taskId: "lead-task", role: "lead", paths: ["src"], dependencies: [] },
      outputs: [], permissions: [...roleConfiguration.lead.permissions],
      sourceSession: "owner-control", destinationSession: "lead@rig", body: "Decompose the approved goal",
    }), binding);
    expect(created.status).toBe("accepted");
    const lead = governance.findTask("run", "lead-task")!;
    const leadAttempt = "lead-attempt";
    governance.recordAttempt(request(leadAttempt, { qitemId: lead.qitemId, role: "lead", provider: "claude",
      identity: { nativeSessionId: "native-lead", tmuxServer: "/tmp/tmux.sock", paneId: "%7", processId: 777,
        processStart: "lead-start", generation: 1, policyFingerprint: binding.policyFingerprint }, unknownReason: null, state: "running", usage }), binding);
    const observe = completion(() => ({ base: "commit", baseIdentifier: "a".repeat(40), files: [{ path: "lead-proposal.json" }],
      manifestDigest: `sha256:${"c".repeat(64)}`, patch: "diff --git a/lead-proposal.json b/lead-proposal.json\n+++ b/lead-proposal.json\n" }),
      () => [{ taskId: "follow-up", paths: ["src"], dependencies: [] }]);

    await observe.sweep();

    expect(governance.queueState(lead.qitemId)).toBe("done");
    expect(governance.findTask("run", "lead-task-review-1")).toBeNull();
    expect(governance.getTask(lead.qitemId)?.evidence).toMatchObject({ validated: true, changedPaths: ["lead-proposal.json"] });
  });
});
