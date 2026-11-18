/**
 * The scope-extension fixture, shared by the two files the original suite was split into.
 *
 * The cases share one live control database, one bound run and one pair of assigned tasks, and
 * they mutate all three, so the fixture is a single object the caller builds once per test rather
 * than a bag of helpers. `createScopeFixture()` performs exactly what the original `beforeEach`
 * did and returns the handles the cases use.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../../src/db/connection.js";
import { initializeDatabase } from "../../src/db/baseline.js";
import { EventBus } from "../../src/domain/event-bus.js";
import { QueueRepository } from "../../src/domain/queue-repository.js";
import { PlanGovernance, hashBinding, hashBytes } from "../../src/domain/plan-governance.js";
import { WorkflowRuntime } from "../../src/domain/workflow-runtime.js";
import { removeReviewPacket, type ReviewPacket } from "../../src/domain/team-workspace.js";
import type { ControlRequest, PlanBinding } from "../../src/contracts/team-control.js";

export const owner = { kind: "owner", sessionId: "owner" } as const;
export const worker = { kind: "worker", sessionId: "worker" } as const;
export const git = (root: string, ...args: string[]): string =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export const manifestBase = { name: "fixture", version: "1.0.0", devDependencies: {} as Record<string, string> };

export interface ScopeFixture {
  directory: string;
  repo: string;
  db: Database.Database;
  governance: PlanGovernance;
  runtime: WorkflowRuntime;
  binding: PlanBinding;
  packets: ReviewPacket[];
  command: (actionId: string, payload: unknown) => ControlRequest<unknown>;
  candidate: (taskId?: string) => ReturnType<WorkflowRuntime["candidateFor"]>;
  packet: (taskId?: string) => ReviewPacket;
  extensions: () => ReturnType<PlanGovernance["scopeForTask"]>["extensions"];
  decide: (id: string, decision?: "approved" | "rejected", head?: string) => ReturnType<PlanGovernance["decideApproval"]>;
  /**
   * Reopen the control database and its owners, as a restarted daemon does, and return the
   * handles that changed. The original `open()` reassigned the file's own bindings; a caller here
   * rebinds from the return value, which is the same thing without the fixture reaching into the
   * caller's scope.
   */
  open: () => Pick<ScopeFixture, "db" | "governance" | "runtime" | "candidate" | "packet" | "extensions" | "decide">;
  dispose: () => void;
}

/** Build the fixture the original `beforeEach` built: one run, two tasks, one approval. */
export function createScopeFixture(policyInput: { paths: number; extensions: number; registries: string[] | null }): ScopeFixture {
  policyInput.paths = 5; policyInput.extensions = 5; policyInput.registries = ["registry.npmjs.org:443"];
  const directory = mkdtempSync(join(tmpdir(), "scope-extension-"));
  const repo = join(directory, "source");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(directory, "assignments", "ma-worker1"), { recursive: true });
  for (const path of ["owned.ts", "neighbor.ts", "other.ts"]) {
    writeFileSync(join(repo, "src", path), "export const value = " + JSON.stringify(path) + ";\n");
  }
  writeFileSync(join(repo, "plan.md"), "approved plan");
  writeFileSync(join(repo, "package.json"), JSON.stringify(manifestBase));
  writeFileSync(join(repo, "package-lock.json"), JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": manifestBase } }));
  git(repo, "init", "--quiet", "--initial-branch=main");
  git(repo, "add", ".");
  git(repo, "-c", "user.name=fixture", "-c", "user.email=scope@test.invalid", "commit", "--quiet", "-m", "base");
  const binding: PlanBinding = {
    artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
    planRef: "plan.md", planDigest: hashBytes("approved plan"), repository: { root: repo, identity: "git:" + git(repo, "rev-parse", "HEAD").trim() },
    readPaths: ["src"], writePaths: ["src", "lib", "docs", "engine", "package.json", "package-lock.json", "pnpm-lock.yaml"], roles: ["lead", "implementer", "reviewer"],
    policyRevision: 4, policyFingerprint: hashBytes("policy"), limits: { maxSessions: 3, maxActiveMs: 600_000, maxRetries: 1, maxReviewRounds: 2 },
  };
  const db = createDb(join(directory, "control.db"));
  initializeDatabase(db);
  const bus = new EventBus(db), queue = new QueueRepository(db, bus);
  const governance = new PlanGovernance(db, bus, queue, () => new Date("2026-10-28T08:00:00.000Z"), () => ({
    policyRevision: binding.policyRevision, policyFingerprint: binding.policyFingerprint, verifiedProviders: ["claude", "codex"],
  }));
  const runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue, defaultWorker: () => "ma-worker1",
    assignmentRoot: () => join(directory, "assignments"),
    candidateRecordsRoot: () => join(directory, "candidate-records"),
    candidateRoot: (runId: string, taskId: string, workerName: string) => join(directory, "assignments", workerName, runId + "-" + taskId),
  });
  const packets: ReviewPacket[] = [];
  /** The database handle currently open; `open()` replaces it, and `dispose()` closes this one. */
  let live: Database.Database = db;
  let nextKey = 0;
  const command = (actionId: string, payload: unknown): ControlRequest<unknown> => ({
    protocolVersion: "1.0", runId: "run", actionId, payload,
    expectedEntityVersion: governance.getRun("run").entityVersion, idempotencyKey: "request-" + ++nextKey,
  });
  db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'fixture')").run();
  governance.createRun({ id: "run", rigId: "rig", binding });
  governance.requestApproval(command("implementation", { kind: "orchestrator", action: "implementation",
    payload: { bindingDigest: hashBinding(binding) }, targetDigest: hashBinding(binding), expiresAt: "9999-01-01T00:00:00.000Z" }), owner);
  governance.decideApproval(command("implementation", { approvalVersion: 1, decision: "approved" }), owner, binding);
  for (const [taskId, path] of [["task", "src/owned.ts"], ["other", "src/other.ts"]]) {
    const created = governance.createTask(command(taskId, { assignment: { taskId, role: "implementer", paths: [path], dependencies: [] },
      outputs: [], permissions: [], sourceSession: "lead@rig", destinationSession: taskId + "@rig", body: "Implement the assigned file" }), binding);
    if (created.status !== "accepted") throw new Error("scope fixture: task " + taskId + " was not accepted: " + created.status);
  }
  const candidate = (taskId = "task") => runtime.candidateFor("run", taskId, "ma-worker1");
  const packet = (taskId = "task") => {
    const value = runtime.reviewPacketFor("run", taskId, join(directory, "review-" + taskId + "-" + packets.length));
    packets.push(value);
    return value;
  };
  const extensions = () => governance.scopeForTask("run", "task").extensions;
  const decide = (id: string, decision: "approved" | "rejected" = "approved", head?: string) => {
    const approval = governance.getApproval(id)!;
    return governance.decideApproval(command(id, { approvalVersion: approval.entityVersion, decision,
      expectedChainHead: head ?? approval.payload.expectedChainHead }), owner, binding);
  };
  const dispose = () => {
    for (const value of packets.splice(0)) removeReviewPacket(value);
    // A case may have reopened the control database, and a case that did closes the original
    // itself; both are guarded, because closing a handle twice throws. On Windows an open handle
    // also keeps the directory from being removed.
    if (live.open) live.close();
    if (db.open && db !== live) db.close();
    rmSync(directory, { recursive: true, force: true });
  };
  /**
   * Reopen the control database and its owners, as a restarted daemon does, and return the
   * handles that changed. The original `open()` reassigned the file's own bindings; a caller here
   * rebinds from the return value, which is the same thing without the fixture reaching into the
   * caller's scope.
   */
  const open = (): Pick<ScopeFixture, "db" | "governance" | "runtime" | "packet" | "extensions" | "decide"> => {
    // A restart closes the previous handle; the caller that asks to reopen should not also have
    // to remember which handle was live.
    if (live.open) live.close();
    const reopened = createDb(join(directory, "control.db"));
    live = reopened;
    initializeDatabase(reopened);
    const bus = new EventBus(reopened), queue = new QueueRepository(reopened, bus);
    const nextGovernance = new PlanGovernance(reopened, bus, queue, () => new Date("2026-10-28T08:00:00.000Z"), () => ({
      policyRevision: binding.policyRevision, policyFingerprint: binding.policyFingerprint, verifiedProviders: ["claude", "codex"],
    }));
    const nextRuntime = new WorkflowRuntime({ db: reopened, eventBus: bus, queueRepo: queue, defaultWorker: () => "ma-worker1",
      assignmentRoot: () => join(directory, "assignments"),
      candidateRecordsRoot: () => join(directory, "candidate-records"),
      candidateRoot: (runId: string, taskId: string, workerName: string) => join(directory, "assignments", workerName, runId + "-" + taskId),
    });
    const nextPacket = (taskId = "task") => {
      const value = nextRuntime.reviewPacketFor("run", taskId, join(directory, "review-" + taskId + "-" + packets.length));
      packets.push(value);
      return value;
    };
    return {
      db: reopened, governance: nextGovernance, runtime: nextRuntime, packet: nextPacket,
      candidate: (taskId = "task") => nextRuntime.candidateFor("run", taskId, "ma-worker1"),
      extensions: () => nextGovernance.scopeForTask("run", "task").extensions,
      decide: (id: string, decision: "approved" | "rejected" = "approved", head?: string) => {
        const approval = nextGovernance.getApproval(id)!;
        return nextGovernance.decideApproval(command(id, { approvalVersion: approval.entityVersion, decision,
          expectedChainHead: head ?? approval.payload.expectedChainHead }), owner, binding);
      },
    };
  };
  return { directory, repo, db, governance, runtime, binding, packets, command, candidate, packet, extensions, decide, open, dispose };
}
