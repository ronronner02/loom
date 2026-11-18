import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PlanGovernance, hashBinding } from "../src/domain/plan-governance.js";
import { dependencySatisfied } from "../src/domain/workflow-runtime.js";
import type { ContextManifest } from "../src/integrations/framework/context-manifest.js";
import { sourceFingerprint } from "../src/domain/team-workspace.js";
import { composeIntegration, IntegrationRepairRequired } from "../src/domain/integration-branch.js";
import { commitPlan, ensurePlanWorktree, runSlug } from "../src/domain/plan-branch.js";
import { refreshPlanBinding } from "../src/routes/team-start.js";
import { classificationFor } from "../src/domain/attempt-failure.js";
import { composeAttemptCompletion, type AttemptCompletion } from "../src/domain/attempt-completion.js";
import { agentTurnOutputPaths } from "../src/domain/agent-turn.js";
import { createTestApp } from "./helpers/test-app.js";
import {
  createIntegrationFixture, git, owner, policy, runName, unusedUsage, writable, type IntegrationFixture,
} from "./helpers/integration-fixture.js";

vi.mock("node:child_process", async importActual => {
  const actual = await importActual<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

let fixture: IntegrationFixture;
let directory: string, repo: string, worktrees: string, assignments: string, dbPath: string;
let db: IntegrationFixture["db"], governance: IntegrationFixture["governance"];
let bus: IntegrationFixture["bus"], queue: IntegrationFixture["queue"];
let runtime: IntegrationFixture["runtime"], integration: IntegrationFixture["integration"];
let binding: IntegrationFixture["binding"], runId: string;
let head: IntegrationFixture["head"], stage: IntegrationFixture["stage"], admit: IntegrationFixture["admit"];
let startAttempt: IntegrationFixture["startAttempt"], stopAttempt: IntegrationFixture["stopAttempt"];
let attempt: IntegrationFixture["attempt"], complete: IntegrationFixture["complete"];
let approveReview: IntegrationFixture["approveReview"], request: IntegrationFixture["request"];
let currentBinding: IntegrationFixture["currentBinding"], open: IntegrationFixture["open"];
let compose: IntegrationFixture["compose"], readyTaskA: IntegrationFixture["readyTaskA"];
let restartWithoutCandidateReads: IntegrationFixture["restartWithoutCandidateReads"];
let branch: IntegrationFixture["branch"];
let reopen: () => void;

beforeEach(() => {
  fixture = createIntegrationFixture();
  fixture.setup();
  ({ directory, repo, worktrees, assignments, dbPath, db, bus, queue, governance, runtime, integration, binding, runId,
    head, stage, admit, startAttempt, stopAttempt, attempt, complete, approveReview, request, currentBinding,
    open, compose, branch, readyTaskA, restartWithoutCandidateReads } = fixture);
  // The fixture's handles are replaced when the database is reopened, so the case's own bindings
  // have to be refreshed from it. This shadows the fixture's `reopen` with one that does both.
  reopen = () => {
    fixture.reopen();
    ({ db, bus, queue, governance, runtime, integration } = fixture);
  };
  // `compose()` rebuilds the runtime and the integration owner, so the case's copies follow it.
  compose = () => {
    fixture.compose();
    ({ runtime, integration } = fixture);
  };
  // A restart replaces every handle; the case's copies follow the fixture's.
  restartWithoutCandidateReads = () => {
    const candidateManifest = fixture.restartWithoutCandidateReads();
    ({ db, bus, queue, governance, runtime, integration } = fixture);
    return candidateManifest;
  };
});
afterEach(() => { fixture.teardown(); });

describe("U7 integration branch and merge", () => {
  it.each(["commit-msg", "pre-commit"] as const)("preserves a %s mismatch as repair-required without recommitting", async hookName => {
    readyTaskA();
    const parent = head();
    const hook = join(repo, ".git", "hooks", hookName);
    const script = hookName === "commit-msg" ? "#!/bin/sh\nprintf '\\nchanged by hook\\n' >> \"$1\"\n"
      : "#!/bin/sh\nprintf 'export const hook = 1;\\n' > src/hook.ts\ngit add -- src/hook.ts\n";
    writeFileSync(hook, script, { mode: 0o755 }); chmodSync(hook, 0o755);
    await expect(integration.integrate(runId, "task-a")).rejects.toBeInstanceOf(IntegrationRepairRequired);
    const changedHead = head();
    expect(changedHead).not.toBe(parent);
    expect(governance.integrationRecord(runId).commits).toHaveLength(0);
    expect(governance.queueState(governance.findTask(runId, "task-a")!.qitemId)).toBe("done");
    const candidate = restartWithoutCandidateReads();
    await expect(integration.integrate(runId, "task-a")).rejects.toBeInstanceOf(IntegrationRepairRequired);
    expect(head()).toBe(changedHead);
    expect(candidate).not.toHaveBeenCalled();
  });

  it("retries a non-mutating commit failure from the saved intent after restart", async () => {
    readyTaskA();
    const root = governance.getRun(runId).binding.repository.root;
    const parent = head();
    const hook = join(repo, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    chmodSync(hook, 0o755);
    await expect(integration.integrate(runId, "task-a")).rejects.toThrow("Git commit failed");
    const intent = db.prepare(`SELECT tree_sha AS treeSha, message, repair_reason AS repairReason
      FROM team_integration_intents WHERE run_id = ? AND task_id = ?`).get(runId, "task-a") as {
        treeSha: string; message: string; repairReason: string | null };
    expect(head()).toBe(parent);
    expect(intent.repairReason).toBeNull();
    expect(git(root, "write-tree").trim()).toBe(intent.treeSha);
    rmSync(hook);

    const candidate = restartWithoutCandidateReads();
    await expect(integration.integrate(runId, "task-a")).resolves.toMatchObject({ status: "committed" });
    expect(git(root, "rev-parse", "HEAD^{tree}").trim()).toBe(intent.treeSha);
    const object = git(root, "cat-file", "commit", "HEAD");
    expect(object.slice(object.indexOf("\n\n") + 2)).toBe(intent.message);
    expect(git(root, "rev-list", "--count", `${parent}..HEAD`).trim()).toBe("1");
    expect(governance.integrationRecord(runId).commits).toHaveLength(1);
    expect(candidate).not.toHaveBeenCalled();
  });

  it.each([false, true])("resumes a frozen intent before commit (already staged: %s)", async staged => {
    readyTaskA();
    const root = governance.getRun(runId).binding.repository.root;
    const parent = head();
    const task = governance.findTask(runId, "task-a")!;
    const manifest = runtime.candidateManifestFor(runId, "task-a");
    const env = { ...process.env, GIT_INDEX_FILE: join(directory, "prepared-index") };
    const indexGit = (args: string[], input?: string) => execFileSync("git", ["-C", root, ...args], {
      windowsHide: true, encoding: "utf8", input, env, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    indexGit(["read-tree", parent]);
    indexGit(["apply", "--cached", "--3way", "-"], manifest.patch);
    const tree = indexGit(["write-tree"]).trim();
    const actualBranch = git(root, "symbolic-ref", "--short", "HEAD").trim();
    const subject = governance.taskDisplayName(task.qitemId) ?? "task-a";
    const message = `${subject}\n\nRun: ${runName}\nTask: task-a\n`;
    db.prepare(`INSERT INTO team_integration_intents (run_id, task_id, repository, worktree, branch,
      parent_sha, tree_sha, subject, message, repair_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
      .run(runId, "task-a", repo, root, actualBranch, parent, tree, subject, message, new Date().toISOString());
    if (staged) git(root, "read-tree", "-m", "-u", parent, tree);
    const candidate = restartWithoutCandidateReads();
    const result = await integration.integrate(runId, "task-a");
    expect(result.status).toBe("committed");
    expect(git(root, "rev-parse", "HEAD^{tree}").trim()).toBe(tree);
    expect(git(root, "rev-list", "--count", `${parent}..HEAD`).trim()).toBe("1");
    expect(candidate).not.toHaveBeenCalled();
  });

  it.each([false, true])("waits for reviewed dependencies to land before staging a dependent (restart: %s)", async restart => {
    // The two tasks own disjoint files, as the live dependency graph requires.
    const prerequisite = governance.findTask(runId, "task-a")!;
    db.prepare("UPDATE team_queue_authority SET assignment_json = ? WHERE qitem_id = ?")
      .run(JSON.stringify({ ...prerequisite.assignment, paths: ["src/health.ts"] }), prerequisite.qitemId);
    expect(admit("consumer", "implementer", "consumer@rig", { paths: ["src/consumer.ts"], dependencies: ["task-a"] }).status).toBe("accepted");
    stage("task-a", "src/health.ts", "export const health = () => 'ok';\n");
    const launch = () => {
      const task = governance.findTask(runId, "consumer")!;
      return runtime.admitForLaunch(runId, { attemptId: "consumer-attempt", worker: "worker1",
        assignment: task.assignment, outputs: [], permissions: ["write-assigned-tree"],
        context: { runId, role: "implementer", binding: currentBinding() } as ContextManifest });
    };
    const ready = () => dependencySatisfied(db, queue,
      qitemId => governance.getTask(qitemId)?.evidence?.validated === true, runId, "task-a");
    const consumerRoot = join(assignments, "worker1", `${runId}-consumer`);

    complete("task-a");
    expect(ready()).toBe(false);
    expect(launch).toThrow("Dependency lacks validated success");
    expect(existsSync(consumerRoot)).toBe(false);

    approveReview("task-a");
    expect(ready()).toBe(false);
    expect(launch).toThrow("Dependency lacks validated success");
    expect(existsSync(consumerRoot)).toBe(false);

    expect((await integration.integrate(runId, "task-a")).status).toBe("committed");
    if (restart) { reopen(); }
    expect(ready()).toBe(true);
    const admitted = launch();
    expect(readFileSync(join(admitted.candidate, "src/health.ts"), "utf8")).toBe("export const health = () => 'ok';\n");
    expect(git(admitted.candidate, "rev-parse", "HEAD").trim()).toBe(head());
  });

});
