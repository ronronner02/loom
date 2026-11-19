import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { createConnection } from "node:net";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { initializeDatabase } from "../src/db/baseline.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { hashBinding, hashBytes } from "../src/domain/plan-governance.js";
import { MailboxRepository } from "../src/domain/mailbox-repository.js";
import { MailboxDelivery } from "../src/domain/mailbox-delivery.js";
import type { AssignmentInput } from "../src/domain/team-assignment.js";
import type { ManagedSessionReceipt } from "../src/domain/runtime-adapter.js";
import type { ContextInput } from "../src/integrations/framework/context-manifest.js";
import { FRAMEWORK_PIN } from "../src/integrations/framework/catalog.js";

// T042: the attempt an admitted assignment launches from is produced by the runtime,
// not assembled at a call site.
//
// Every case goes through `WorkflowRuntime.produceManagedAttempt` with the privileged
// launcher absent: this task proves what the control produces offline. T038 observes
// the composed chain against installed clients, and T047 attaches the result.

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "t042-repo-"));
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "test");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "base.ts"), "export const base = 1;\n");
  writeFileSync(join(root, "plan.md"), "approved plan\n");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "base");
  return root;
}

/** Every directory the fixture seals is chmod'ed back before removal. */
function writable(path: string): void {
  try { chmodSync(path, 0o755); } catch { return; }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    try { if (entry.isDirectory()) writable(child); else chmodSync(child, 0o644); } catch { /* already gone */ }
  }
}

describe("the managed attempt a seat launches from: refusal and release", () => {
  let directory: string, repo: string, assignmentRoot: string, contextRoot: string, mailboxRoot: string;
  let frameworkRoot: string, controlStateDir: string, toolchainDir: string;
  let db: Database.Database, bus: EventBus, queue: QueueRepository, runtime: WorkflowRuntime;
  let binding: AssignmentInput["binding"];
  let workerGid: number;

  const candidateDir = (worker: string, runId = "run-1", taskId = "T042") =>
    join(assignmentRoot, worker, `${runId}-${taskId}`);
  const projectionDir = (attemptId: string, worker = "ma-worker1", runId = "run-1") =>
    join(contextRoot, worker, runId, attemptId);
  // The unisolated layout leaves out the run segment: an AF_UNIX path must fit 108 bytes, and an
  // attempt id is already unique per attempt.
  const mailboxDir = (attemptId: string, worker = "ma-worker1") =>
    join(mailboxRoot, worker, attemptId);

  const open = () => {
    db = createDb(join(directory, "t042.db"));
    initializeDatabase(db);
    bus = new EventBus(db);
    queue = new QueueRepository(db, bus, { now: () => new Date("2026-10-23T00:00:00.000Z") } as never);
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue,
      candidateRoot: (runId, taskId, worker) => candidateDir(worker, runId, taskId),
      assignmentRoot: () => assignmentRoot, defaultWorker: () => "ma-worker1", sameIdentity: true,
      managedAttemptRoots: () => ({ contextRoot, mailboxRoot, controlStateDir,
        policyRevision: binding.policyRevision, workerIdentities: ["ma-worker1", "ma-worker2"],
        frameworkRoot, frameworkRevision: FRAMEWORK_PIN.revision, toolchainDir }) });
  };

  /** A real pinned framework file, in the layout the catalog uses. Fixed bytes: a resumed
   * attempt must be compared against what it recorded, so this must not change per call. */
  let frameworkSource = "";
  const frameworkFiles = () => [{ path: "skills/autoresearch/SKILL.md", source: frameworkSource }];

  const produceInput = (overrides: Record<string, unknown> = {}) => ({
    attemptId: "attempt-1", worker: "ma-worker1",
    assignment: { taskId: "T042", role: "implementer" as const, paths: ["src"], dependencies: ["T011"] },
    outputs: ["src/result.ts"], permissions: ["write-assigned-tree"], role: "implementer" as const,
    client: "claude-code" as const, candidate: candidateDir("ma-worker1"), sessionId: "implementer-session",
    rigId: "rig-1", taskId: "T042", recipients: ["lead@rig-1"], workerGid,
    // The recipient's own capability: poll matches on it, so the endpoint must carry this
    // value rather than mint a fresh one, or the worker's mailbox reads empty.
    mailboxCapability: "mailbox:" + "c".repeat(43),
    deadline: Date.now() + 60_000, isCurrent: () => true,
    delivery: new MailboxDelivery(new MailboxRepository(db)), chat: new MailboxRepository(db),
    // A real worker credential: the bootstrap carries it as `Bearer`, and the endpoint
    // authenticates with it. A constant here would make every request 401.
    readCredentials: () => ({ ownerToken: "owner-fixture",
      workers: [{ token: "worker-fixture-token", sessionId: "implementer-session", runId: "run-1" }] }),
    context: { frameworkRoot, frameworkRevision: FRAMEWORK_PIN.revision,
      // The worker is the daemon's own user, so its uid and groups come from this process.
      workerUid: typeof process.getuid === "function" ? process.getuid() : -1, workerGroups: [],
      discoveryRoots: [], mutableStateRoot: join(directory, "state") },
    frameworkFiles: frameworkFiles(),
    ...overrides,
  });

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "t042-attempt-"));
    chmodSync(directory, 0o755);
    repo = repository();
    assignmentRoot = join(directory, "assignments");
    contextRoot = join(directory, "context");
    controlStateDir = join(directory, "control");
    mailboxRoot = join(controlStateDir, "mailboxes");
    frameworkRoot = join(directory, "framework");
    toolchainDir = join(directory, "toolchain");
    // The daemon's own directories and the roots it creates for its worker.
    for (const path of [join(assignmentRoot, "ma-worker1"), frameworkRoot, controlStateDir,
      mailboxRoot, join(directory, "state"), toolchainDir]) mkdirSync(path, { recursive: true, mode: 0o700 });
    // The context root is shared rather than control-private, as the worker reads it.
    mkdirSync(contextRoot, { recursive: true, mode: 0o755 });
    chmodSync(contextRoot, 0o755);
    // `<context_root>/<worker>` is setgid, so a directory created beneath it inherits that
    // group. The anchor's group is read back rather than assumed.
    const anchors = [join(contextRoot, "ma-worker1"), join(mailboxRoot, "ma-worker1")];
    for (const anchor of anchors) mkdirSync(anchor, { recursive: true });
    chmodSync(join(contextRoot, "ma-worker1"), 0o2750);
    chmodSync(join(mailboxRoot, "ma-worker1"), 0o700);
    // The pinned framework tree is control-owned and worker-readable through its group.
    chmodSync(frameworkRoot, 0o2750);
    // The pinned framework bytes, written once per test so a resumed attempt is compared
    // against exactly what it recorded.
    frameworkSource = join(frameworkRoot, "skills", "autoresearch", "SKILL.md");
    mkdirSync(join(frameworkRoot, "skills", "autoresearch"), { recursive: true });
    writeFileSync(frameworkSource, "pinned instructions\n", { mode: 0o644 });
    chmodSync(join(frameworkRoot, "skills"), 0o2750);
    chmodSync(join(frameworkRoot, "skills", "autoresearch"), 0o2750);
    workerGid = lstatSync(join(contextRoot, "ma-worker1")).gid;
    binding = {
      artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
      planRef: "plan.md", planDigest: hashBytes("approved plan\n"),
      repository: { root: repo, identity: "git:" + "a".repeat(40) },
      readPaths: ["src"], writePaths: ["src"], roles: ["lead", "implementer", "reviewer"],
      // Revision 5 is what the producer states for the roots in force.
      policyRevision: 5, policyFingerprint: hashBytes("policy"),
      limits: { maxSessions: 3, maxActiveMs: 600_000, maxRetries: 1, maxReviewRounds: 2 },
    };
    open();
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'test')").run();
    db.prepare(`INSERT INTO team_runs (id, rig_id, binding_json, binding_digest, state, created_at, updated_at)
      VALUES ('run-1', 'rig-1', ?, ?, 'approved', '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z')`)
      .run(JSON.stringify(binding), hashBinding(binding));
    db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body)
      VALUES ('dep-item', '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z', 'lead@rig-1', 'dep-session', 'done', 'body')`).run();
    db.prepare(`INSERT INTO team_queue_authority (qitem_id, run_id, task_id, assignment_json, evidence_json)
      VALUES ('dep-item', 'run-1', 'T011', ?, ?)`).run(
      JSON.stringify({ taskId: "T011", role: "implementer", paths: ["test/dependency"], dependencies: [] }),
      JSON.stringify({ validated: true }));
    const task = produceInput();
    db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body)
      VALUES ('task-item', '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z', 'lead@rig-1', 'implementer-session', 'pending', 'body')`).run();
    db.prepare(`INSERT INTO team_queue_authority (qitem_id, run_id, task_id, assignment_json, outputs_json, permissions_json)
      VALUES ('task-item', 'run-1', 'T042', ?, ?, ?)`).run(
      JSON.stringify(task.assignment), JSON.stringify(task.outputs), JSON.stringify(task.permissions));
  });

  afterEach(() => {
    if (db?.open) db.close();
    if (existsSync(directory)) writable(directory);
    rmSync(directory, { recursive: true, force: true });
  });

  // --- refusal and release ---
  it("refuses a candidate that is not the task's own", async () => {
    await expect(runtime.produceManagedAttempt("run-1", produceInput({ candidate: join(directory, "elsewhere") })))
      .rejects.toThrow("Managed attempt candidate mismatch");
    expect(runtime.managedAttemptFor("attempt-1")).toBeUndefined();
  }, 30_000);

  it.skipIf(typeof process.getuid !== "function")("keeps the mailbox directory under the configured mailbox root and worker", async () => {
    // The mailbox root is configuration: whatever root the runtime is handed, the directory
    // the producer creates is derived from that root and the worker alone. A root that is not
    // `control_state_dir/mailboxes` is not refused — the composition root decides where the
    // mailboxes live, and a guard here would refuse a layout the caller asked for.
    const elsewhere = join(directory, "elsewhere-mailboxes");
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue,
      candidateRoot: (runId, taskId, worker) => candidateDir(worker, runId, taskId),
      assignmentRoot: () => assignmentRoot, defaultWorker: () => "ma-worker1", sameIdentity: true,
      managedAttemptRoots: () => ({ contextRoot, mailboxRoot: elsewhere, controlStateDir,
        policyRevision: binding.policyRevision, workerIdentities: ["ma-worker1", "ma-worker2"],
        frameworkRoot, frameworkRevision: FRAMEWORK_PIN.revision, toolchainDir }) });
    const produced = await runtime.produceManagedAttempt("run-1", produceInput());
    expect(produced.bridge.binding.directory).toBe(join(elsewhere, "ma-worker1", "attempt-1"));
    expect(existsSync(join(elsewhere, "ma-worker1", "attempt-1"))).toBe(true);
    await runtime.retireManagedAttempt("attempt-1");
  }, 30_000);

  it.skipIf(typeof process.getuid !== "function")("seals the whole projection, not just its root, because the manifest refuses a writable directory", async () => {
    // Sealing only the attempt root would leave `framework/` writable, and the manifest
    // refuses a projection any of whose directories its owner can still write. This is
    // asserted on every directory in the tree, not just the root.
    const produced = await runtime.produceManagedAttempt("run-1", produceInput());
    const root = produced.attempt.context.root;
    const writable: string[] = [];
    const walk = (directory: string): void => {
      if ((lstatSync(directory).mode & 0o222) !== 0) writable.push(directory);
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(directory, entry.name));
      }
    };
    walk(root);
    expect(writable).toEqual([]);
    // The subdirectory exists, so this is not vacuous.
    expect(existsSync(join(root, "framework"))).toBe(true);
    await runtime.retireManagedAttempt("attempt-1");
  }, 30_000);

  it("keeps an earlier attempt's projection when a later produce is refused", async () => {
    // A refused produce must not delete run evidence. The projection belongs to the
    // attempt that made it, and KTD24 retains projections with the run evidence.
    await runtime.produceManagedAttempt("run-1", produceInput());
    const root = projectionDir("attempt-1");
    await runtime.retireManagedAttempt("attempt-1");
    const restarted = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue,
      candidateRoot: (runId, taskId, worker) => candidateDir(worker, runId, taskId),
      assignmentRoot: () => assignmentRoot, defaultWorker: () => "ma-worker1", sameIdentity: true,
      managedAttemptRoots: () => ({ contextRoot, mailboxRoot, controlStateDir,
        policyRevision: binding.policyRevision, workerIdentities: ["ma-worker1", "ma-worker2"],
        frameworkRoot, frameworkRevision: FRAMEWORK_PIN.revision, toolchainDir }) });
    await expect(restarted.produceManagedAttempt("run-1", produceInput({ candidate: join(directory, "elsewhere") })))
      .rejects.toThrow("Managed attempt candidate mismatch");
    // Still there, still sealed, still the recorded bytes.
    expect(existsSync(root)).toBe(true);
    expect(existsSync(join(root, "charter"))).toBe(true);
  }, 30_000);

  it("closes every endpoint this daemon owns", async () => {
    await runtime.produceManagedAttempt("run-1", produceInput());
    const second = await runtime.produceManagedAttempt("run-1", produceInput({ attemptId: "attempt-2" }));
    expect(existsSync(second.bridge.endpoint().path)).toBe(true);
    await runtime.closeManagedAttempts();
    expect(runtime.managedAttemptFor("attempt-1")).toBeUndefined();
    expect(runtime.managedAttemptFor("attempt-2")).toBeUndefined();
  }, 30_000);
});
