/**
 * The U7 integration-branch fixture, shared by the two files the original suite was split into.
 *
 * Everything is real git over a real repository: the run is bound to the daemon worktree U5
 * creates, the candidates are staged by the real runtime, and the patch that lands is the
 * candidate's own. The one thing the fixture decides is *when* an approval is recorded, which is
 * what lets an in-flight candidate be staged from a head the branch then moves past.
 */
import type Database from "better-sqlite3";
import { expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../../src/db/connection.js";
import { initializeDatabase } from "../../src/db/baseline.js";
import { TEAM_CONTROL_VERSION, type ControlRequest, type PlanBinding } from "../../src/contracts/team-control.js";
import { EventBus } from "../../src/domain/event-bus.js";
import { QueueRepository } from "../../src/domain/queue-repository.js";
import { PlanGovernance, hashBinding } from "../../src/domain/plan-governance.js";
import { WorkflowRuntime } from "../../src/domain/workflow-runtime.js";
import { composeIntegration, type Integration } from "../../src/domain/integration-branch.js";
import { commitPlan, ensurePlanWorktree, runSlug } from "../../src/domain/plan-branch.js";
import { bindingForGoal, refreshPlanBinding, unisolatedPolicyCapability } from "../../src/routes/team-start.js";
import { taskCompletionEvidence } from "../../src/domain/task-completion.js";

export const owner = { kind: "owner", sessionId: "owner-control" } as const;
export const policy = unisolatedPolicyCapability(4);
/** The run name every case in the suite uses, and what its branch is derived from. */
export const runName = "Add the health endpoint";
export const unusedUsage = { activeMs: 0, inputTokens: { value: null, reason: "unobserved" },
  outputTokens: { value: null, reason: "unobserved" }, costUsd: { value: null, reason: "unobserved" } };

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export function repository(parent: string): string {
  const root = realpathSync(mkdtempSync(join(parent, "owner-")));
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "test");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "base.ts"), "export const base = 1;\n");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "base");
  return root;
}

/** A worktree is sealed read-only by git; open every directory before removing the scratch tree. */
export function writable(path: string): void {
  try { chmodSync(path, 0o755); } catch { return; }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    try { if (entry.isDirectory()) writable(child); else chmodSync(child, 0o644); } catch { /* already gone */ }
  }
}

/** Every handle and helper the cases use, built once per case by `setup()`. */
export interface IntegrationFixture {
  directory: string; repo: string; worktrees: string; assignments: string; dbPath: string;
  db: Database.Database; governance: PlanGovernance; runtime: WorkflowRuntime;
  bus: EventBus; queue: QueueRepository;
  integration: Integration; binding: PlanBinding; runId: string;
  head: () => string;
  stage: (taskId: string, path: string, content: string) => ReturnType<WorkflowRuntime["candidateFor"]>;
  admit: (taskId: string, role: "implementer" | "reviewer", seat: string, extra?: Record<string, unknown>) => ReturnType<PlanGovernance["createTask"]>;
  startAttempt: (taskId: string, attemptId: string, role: "lead" | "implementer" | "reviewer") => ReturnType<PlanGovernance["recordAttempt"]>;
  stopAttempt: (attemptId: string) => string;
  attempt: (taskId: string, attemptId: string, role: "implementer" | "reviewer") => string;
  complete: (taskId: string) => ReturnType<PlanGovernance["recordTaskOutcome"]>;
  approveReview: (implementerTaskId: string) => ReturnType<PlanGovernance["recordTaskOutcome"]>;
  request: (actionId: string, payload: unknown) => ControlRequest<unknown>;
  currentBinding: () => PlanBinding;
  open: () => void;
  compose: () => void;
  reopen: () => void;
  useRun: (id: string) => void;
  branch: () => string;
  useBinding: (next: PlanBinding) => void;
  setup: () => void;
  teardown: () => void;
  readyTaskA: () => void;
  restartWithoutCandidateReads: (afterReopen?: () => void) => ReturnType<typeof vi.fn>;
}

export function createIntegrationFixture(): IntegrationFixture {
let directory: string, repo: string, worktrees: string, assignments: string, dbPath: string;
let db: Database.Database, bus: EventBus, queue: QueueRepository, governance: PlanGovernance;
let runtime: WorkflowRuntime, integration: Integration, binding: PlanBinding;
let runId: string, serial = 0;

const branch = () => runSlug({ runId, name: runName });

const request = (actionId: string, payload: unknown): ControlRequest<unknown> => ({
  protocolVersion: TEAM_CONTROL_VERSION, runId, actionId,
  expectedEntityVersion: governance.getRun(runId).entityVersion,
  idempotencyKey: `u7-${++serial}`, payload,
});

/** The run's current binding, read the way every production caller reads it. */
const currentBinding = () => refreshPlanBinding(governance.getRun(runId).binding, policy);

const open = () => {
  // A restart closes the handle it replaces; a case that reopens should not also have to close it.
  if (db?.open) db.close();
  db = createDb(dbPath);
  initializeDatabase(db);
  bus = new EventBus(db);
  queue = new QueueRepository(db, bus);
  governance = new PlanGovernance(db, bus, queue, undefined, () => policy);
};

/** Compose the runtime and the integration owner over the current database connection. */
const compose = () => {
  runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue,
    candidateRoot: (id, taskId, worker) => join(assignments, worker, `${id}-${taskId}`),
    candidateRecordsRoot: () => join(directory, "candidate-records"),
    assignmentRoot: () => assignments, defaultWorker: () => "worker1" });
  integration = composeIntegration({ db, governance, worktreeRoot: () => worktrees,
    candidateManifest: (id, taskId) => runtime.candidateManifestFor(id, taskId),
    sourceRefMoved: (repository, move) => runtime.acceptOwnerMerge(repository, move),
    currentBinding, log: () => {} });
};

/** The commit the run's worktree has out, which is the branch head. */
const head = () => git(governance.getRun(runId).binding.repository.root, "rev-parse", "HEAD").trim();
/** The run the helpers act on; a case that switches runs calls this, not its local copy. */
const useRun = (id: string) => { runId = id; };
/** A case that rebinds the run (a second run's plan) calls this so the helpers follow it. */
const useBinding = (next: PlanBinding) => { binding = next; };

/** Write one file into a task's candidate, as the agent's turn would. */
const stage = (taskId: string, path: string, content: string) => {
  const workspace = runtime.candidateFor(runId, taskId, "worker1");
  writeFileSync(join(workspace.root, path), content);
  return workspace;
};

const admit = (taskId: string, role: "implementer" | "reviewer", seat: string, extra: Record<string, unknown> = {}) =>
  governance.createTask(request(taskId, {
    assignment: { taskId, role, paths: ["src"], dependencies: [], ...extra },
    outputs: [], permissions: role === "reviewer" ? ["read-assigned-tree"] : ["write-assigned-tree"],
    sourceSession: "lead@rig", destinationSession: seat, body: `Implement ${taskId}`,
  }), currentBinding());

/** Start one attempt for a task, as a launch's receipt does. */
const startAttempt = (taskId: string, attemptId: string, role: "lead" | "implementer" | "reviewer") => {
  runtime.prepareDeliveryLeadTurn?.(runId, taskId);
  const task = governance.findTask(runId, taskId)!;
  const recorded = governance.recordAttempt(request(attemptId, {
    qitemId: task.qitemId, role, provider: "claude",
    identity: { nativeSessionId: `native-${attemptId}`, tmuxServer: "/tmp/tmux.sock", paneId: "%1",
      processId: 4242, processStart: `${attemptId}-start`, generation: 1, policyFingerprint: binding.policyFingerprint },
    unknownReason: null, state: "running", usage: unusedUsage,
  }), currentBinding());
  expect(recorded.status, JSON.stringify(recorded)).toBe("observed");
  return recorded;
};

/** Observe that attempt's process gone, as the daemon's sweep does. */
const stopAttempt = (attemptId: string) => {
  governance.recordUsage({
    protocolVersion: TEAM_CONTROL_VERSION, runId, actionId: attemptId,
    expectedEntityVersion: governance.getRun(runId).entityVersion,
    idempotencyKey: `stop-${attemptId}`,
    payload: { expectedAttemptVersion: governance.getAttempt(attemptId)!.entityVersion, state: "stopped", usage: unusedUsage },
  });
  return attemptId;
};

const attempt = (taskId: string, attemptId: string, role: "implementer" | "reviewer") => {
  startAttempt(taskId, attemptId, role);
  return stopAttempt(attemptId);
};

/** Complete an implementer task from its own candidate, as the daemon's evidence read does. */
const complete = (taskId: string) => {
  const attemptId = attempt(taskId, `attempt-${taskId}`, "implementer");
  const task = governance.findTask(runId, taskId)!;
  const manifest = runtime.candidateManifestFor(runId, taskId);
  const evidence = taskCompletionEvidence({ role: "implementer", assignmentPaths: task.assignment.paths, manifest });
  expect(evidence.validated, evidence.reasons.join("; ")).toBe(true);
  const outcome = governance.recordTaskOutcome(request(task.qitemId, {
    expectedTaskVersion: task.entityVersion, state: "done", closureReason: "no-follow-on",
    actorSession: "impl@rig", attemptId, expectedAttemptVersion: governance.getAttempt(attemptId)!.entityVersion,
    evidence,
  }), { kind: "daemon", sessionId: "daemon" });
  expect(outcome.status, JSON.stringify(outcome)).toBe("observed");
  return outcome;
};

/** Approve the review round the implementer's completion created. */
const approveReview = (implementerTaskId: string) => {
  const reviewer = governance.findTask(runId, `${implementerTaskId}-review-1`)!;
  const attemptId = attempt(reviewer.assignment.taskId, `attempt-${implementerTaskId}-review`, "reviewer");
  const outcome = governance.recordTaskOutcome(request(reviewer.qitemId, {
    expectedTaskVersion: governance.getTask(reviewer.qitemId)!.entityVersion, state: "done", closureReason: "no-follow-on",
    actorSession: "review@rig", attemptId, expectedAttemptVersion: governance.getAttempt(attemptId)!.entityVersion,
    evidence: { findings: [] },
  }), { kind: "daemon", sessionId: "daemon" });
  expect(outcome.status, JSON.stringify(outcome)).toBe("observed");
  expect((outcome.value as { review?: { verdict?: string } }).review?.verdict).toBe("approved");
  return outcome;
};

  const setup = () => {
  serial = 0;
  directory = realpathSync(mkdtempSync(join(tmpdir(), "u7-integration-")));
  repo = repository(directory);
  worktrees = join(directory, "worktrees");
  assignments = join(directory, "assignments");
  mkdirSync(join(assignments, "worker1"), { recursive: true });
  dbPath = join(directory, "team.db");
  runId = "run-1";
  open();
  db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'demo')").run();
  // The run is bound exactly where U5 leaves it after plan approval: the daemon's own
  // worktree, on the run's branch, with the approved plan committed there.
  const worktree = ensurePlanWorktree({ repositoryRoot: repo, worktreeRoot: worktrees, runId, name: runName }).path;
  commitPlan({ worktree, planRef: "plan.md", plan: "# Plan\n\nAdd the health endpoint.\n", message: `plan: ${runName}` });
  binding = bindingForGoal({ root: worktree, planRef: "plan.md", writePaths: ["src"], policy });
  governance.createRun({ id: runId, rigId: "rig", binding, reviewerSeat: "review@rig", displayName: runName });
  governance.requestApproval(request("implementation", { kind: "orchestrator", action: "implementation",
    payload: { bindingDigest: hashBinding(binding) }, targetDigest: hashBinding(binding),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString() }), { kind: "worker", sessionId: "lead@rig" });
  const decided = governance.decideApproval(request("implementation", { approvalVersion: 1, decision: "approved" }),
    owner, binding);
  expect(decided.status).toBe("accepted");
  compose();
  expect(admit("task-a", "implementer", "impl@rig").status).toBe("accepted");

  };

  const teardown = () => {
    if (db?.open) db.close();
    // The daemon's worktrees are registered in the owner repository's admin directory; the
    // scratch tree is removed whole, so git's own bookkeeping does not need unwinding.
    if (directory) { writable(directory); rmSync(directory, { recursive: true, force: true }); }
  };

  /** Stage, complete and approve `task-a`, the shape most cases start from. */
  const readyTaskA = () => {
    stage("task-a", "src/health.ts", "export const health = () => 'ok';\n");
    complete("task-a");
    approveReview("task-a");
  };

  /** Reopen the database and compose the runtime and integration owner over the new handle. */
  const reopen = () => { open(); compose(); };
  /** Reopen the database with a candidate reader that fails, proving recovery rereads nothing. */
  const restartWithoutCandidateReads = (afterReopen?: () => void) => {
    reopen();
    afterReopen?.();
    const candidateManifest = vi.fn(() => { throw new Error("Recovery reread the candidate"); });
    integration = composeIntegration({ db, governance, worktreeRoot: () => worktrees, candidateManifest, currentBinding, log: () => {} });
    return candidateManifest;
  };

  // Getters, not a snapshot: `setup()` assigns every handle, and a case may rebind the run and
  // its binding. A plain object would capture the values the factory saw before either happened.
  return {
    get directory() { return directory; }, get repo() { return repo; }, get worktrees() { return worktrees; },
    get assignments() { return assignments; }, get dbPath() { return dbPath; }, get db() { return db; },
    get bus() { return bus; }, get queue() { return queue; },
    get governance() { return governance; }, get runtime() { return runtime; },
    get integration() { return integration; }, get binding() { return binding; }, get runId() { return runId; },
    head, stage, admit, startAttempt, stopAttempt, attempt, complete, approveReview, request, currentBinding,
    open, compose, reopen, useRun, useBinding, branch, setup, teardown, readyTaskA, restartWithoutCandidateReads,
  };
}
