import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashBinding, PlanGovernance } from "../src/domain/plan-governance.js";
import { dependencySatisfied } from "../src/domain/workflow-runtime.js";
import type { ContextManifest } from "../src/integrations/framework/context-manifest.js";
import { sourceFingerprint } from "../src/domain/team-workspace.js";
import { composeIntegration, IntegrationRepairRequired } from "../src/domain/integration-branch.js";
import { commitPlan, ensurePlanWorktree, runSlug } from "../src/domain/plan-branch.js";
import { bindingForGoal, refreshPlanBinding } from "../src/routes/team-start.js";
import { taskCompletionEvidence } from "../src/domain/task-completion.js";
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
});
afterEach(() => { fixture.teardown(); });

describe("U7 integration branch and merge", () => {
  it("lands two approved tasks as two commits in approval order, and never touches the owner's checkout", async () => {
    const ownerHead = git(repo, "rev-parse", "HEAD").trim();
    const ownerStatus = git(repo, "status", "--porcelain=v1").trim();
    expect(admit("task-b", "implementer", "impl@rig").status).toBe("accepted");
    stage("task-a", "src/health.ts", "export const health = () => 'ok';\n");
    stage("task-b", "src/metrics.ts", "export const metrics = () => ({});\n");

    complete("task-a");
    approveReview("task-a");
    // The first approval landed before the second was approved, which is what makes the
    // second candidate an in-flight one.
    const first = await integration.integrate(runId, "task-a");
    expect(first.status).toBe("committed");
    complete("task-b");
    approveReview("task-b");
    const second = await integration.integrate(runId, "task-b");
    expect(second.status).toBe("committed");

    const root = governance.getRun(runId).binding.repository.root;
    expect(git(root, "log", "--format=%s", "-2").trim().split("\n")).toEqual(["Implement task-b", "Implement task-a"]);
    expect(git(root, "log", "-1", "--format=%b")).toContain(`Run: ${runName}`);

    const status = integration.status(runId);
    expect(status.branch).toBe(branch());
    expect(status.commits.map(commit => commit.task)).toEqual(["task-a", "task-b"]);
    expect(status.commits.map(commit => commit.hash)).toEqual([first.commitSha!.slice(0, 7), second.commitSha!.slice(0, 7)]);
    expect(status.tasksDone).toBe(true);
    expect(status.merge.possible).toBe(true);

    // The owner's checkout is exactly where it was: no branch, commit, or working-tree change.
    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(ownerHead);
    expect(git(repo, "status", "--porcelain=v1").trim()).toBe(ownerStatus);
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
  });

  /**
   * The live acceptance run merged an empty branch: its only task was the lead, which had
   * failed, and the branch carried the plan commit but no task's work. The owner must never be
   * offered that merge, because it would land the plan and nothing the team was asked to do.
   */
  it("keeps the safe legacy base-record filename for existing UUID runs", () => {
    const legacyRun = "11111111-2222-4333-8444-555555555555";
    const legacyBinding = currentBinding();
    fixture.useRun(legacyRun);
    runId = legacyRun;
    governance.createRun({ id: legacyRun, rigId: "rig", binding: legacyBinding });
    governance.requestApproval(request("legacy-implementation", { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest: hashBinding(legacyBinding) }, targetDigest: hashBinding(legacyBinding),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString() }), owner);
    expect(governance.decideApproval(request("legacy-implementation", { approvalVersion: 1, decision: "approved" }),
      owner, legacyBinding).status).toBe("accepted");
    const candidate = runtime.candidateFor(legacyRun, "legacy-task", "worker1");
    const savedPath = join(directory, "candidate-records", `${legacyRun}-legacy-task.lead-base.json`);
    expect(JSON.parse(readFileSync(savedPath, "utf8"))).toEqual(candidate.base);
    reopen();
    expect(runtime.candidateFor(legacyRun, "legacy-task", "worker1").base).toEqual(candidate.base);
  });

  it("keeps another task's saved base intact when an admitted task id contains path separators", async () => {
    stage("task-a", "src/health.ts", "export const health = () => 'ok';\n");
    complete("task-a");
    approveReview("task-a");
    const records = join(directory, "candidate-records");
    const savedNames = readdirSync(records, { recursive: true }).filter(name => String(name).endsWith(".lead-base.json"));
    expect(savedNames).toHaveLength(1);
    const savedName = String(savedNames[0]);
    const savedPath = join(records, savedName);
    const savedBase = readFileSync(savedPath, "utf8");
    expect((await integration.integrate(runId, "task-a")).status).toBe("committed");
    const taskId = `pad/../../candidate-records/${savedName.slice(0, -".lead-base.json".length)}`;
    expect(admit(taskId, "implementer", "impl@rig").status).toBe("accepted");
    const added = runtime.candidateFor(runId, taskId, "worker1");
    expect(added.base).not.toEqual(JSON.parse(savedBase));
    expect(readFileSync(savedPath, "utf8")).toBe(savedBase);

    reopen();
    expect(runtime.candidateFor(runId, "task-a", "worker1").base).toEqual(JSON.parse(savedBase));
    expect(runtime.candidateFor(runId, taskId, "worker1").base).toEqual(added.base);
  });

});
