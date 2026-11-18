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
  it("keeps Merge completion observable after refresh, restart and later owner commits", async () => {
    const ownerBase = git(repo, "rev-parse", "HEAD").trim();
    expect(integration.status(runId).merge.merged).toBe(false);
    stage("task-a", "src/health.ts", "export const health = () => 'ok';\n");
    complete("task-a");
    approveReview("task-a");
    await integration.integrate(runId, "task-a");
    expect(integration.status(runId).merge.merged).toBe(false);
    expect(integration.merge(runId).status).toBe("merged");
    expect(integration.status(runId).merge.merged).toBe(true);

    db.close();
    open();
    compose();
    expect(integration.status(runId).merge.merged).toBe(true);
    writeFileSync(join(repo, "src", "base.ts"), "export const base = 2;\n");
    expect(integration.status(runId).merge).toMatchObject({ possible: false, merged: true });
    git(repo, "add", "src/base.ts");
    git(repo, "commit", "--quiet", "-m", "later owner work");
    expect(integration.status(runId).merge.merged).toBe(true);

    git(repo, "checkout", "-b", "different-owner-branch", ownerBase);
    expect(integration.status(runId).merge.merged).toBe(false);
    git(repo, "update-ref", "-d", `refs/heads/${branch()}`);
    expect(integration.status(runId).merge.merged).toBeNull();
  });

  it("makes one merge commit when the owner's branch diverged, and aborts a conflicting merge", async () => {
    stage("task-a", "src/health.ts", "export const health = () => 'ok';\n");
    complete("task-a");
    approveReview("task-a");
    await integration.integrate(runId, "task-a");
    // The owner moves their own branch after the run's base, so a fast-forward is impossible.
    writeFileSync(join(repo, "src", "owner.ts"), "export const owner = 1;\n");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "owner works on main");

    const merged = integration.merge(runId);
    expect(merged.status).toBe("merged");
    expect(merged.mode).toBe("merge-commit");
    expect(git(repo, "log", "--format=%s", "-1").trim()).toBe(`Merge ${branch()}: ${runName}`);
    // Both histories are in the merged result: the owner's own commit and the run's work.
    expect(git(repo, "log", "--format=%s").trim().split("\n")).toEqual(expect.arrayContaining([
      "owner works on main", "Implement task-a", `Merge ${branch()}: ${runName}`]));

    // Now a run whose work conflicts with the owner's: the merge is refused, aborted, unchanged.
    expect(admit("task-b", "implementer", "impl@rig").status).toBe("accepted");
    writeFileSync(join(repo, "src", "health.ts"), "export const health = 'owner version';\n");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "owner edits the same file");
    const conflictingHead = git(repo, "rev-parse", "HEAD").trim();
    stage("task-b", "src/health.ts", "export const health = 'team version';\n");
    complete("task-b");
    approveReview("task-b");
    await integration.integrate(runId, "task-b");
    const refused = integration.merge(runId);
    expect(refused).toMatchObject({ status: "refused", code: "merge_conflict" });
    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(conflictingHead);
    expect(git(repo, "status", "--porcelain=v1").trim()).toBe("");
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
  });

  it("finds the branch and worktree again after a restart, and keeps landing on it", async () => {
    expect(admit("task-b", "implementer", "impl@rig").status).toBe("accepted");
    stage("task-a", "src/health.ts", "export const health = () => 'ok';\n");
    complete("task-a");
    approveReview("task-a");
    await integration.integrate(runId, "task-a");
    const firstHead = head();

    // A restart forgets every in-process record but not the run, its rows or the worktree.
    reopen();
    const status = integration.status(runId);
    expect(status.branch).toBe(branch());
    expect(status.worktree).toBe(governance.getRun(runId).binding.repository.root);
    expect(status.commits.map(commit => commit.task)).toEqual(["task-a"]);

    stage("task-b", "src/metrics.ts", "export const metrics = () => ({});\n");
    complete("task-b");
    approveReview("task-b");
    expect((await integration.integrate(runId, "task-b")).status).toBe("committed");
    expect(git(status.worktree!, "rev-parse", "HEAD").trim()).not.toBe(firstHead);
    expect(integration.status(runId).commits.map(commit => commit.task)).toEqual(["task-a", "task-b"]);
  });

  it("serves the integration read and the merge to the owner only", async () => {
    stage("task-a", "src/health.ts", "export const health = () => 'ok';\n");
    complete("task-a");
    approveReview("task-a");
    await integration.integrate(runId, "task-a");

    const app = createTestApp(db, { appDeps: { eventBus: bus, queueRepo: queue, teamGovernance: governance,
      workflowRuntime: runtime, integration,
      teamControl: { credentials: { ownerToken: "owner-fixture", workers: [{ token: "worker-fixture", sessionId: "impl@rig", runId: "other" }] },
        readPolicyCapability: () => policy, planWorktreeRoot: () => worktrees } } }).app;
    const call = (path: string, token: string, method: "GET" | "POST" = "GET", body?: unknown) =>
      app.request(`/api/team-control${path}`, { method,
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      { incoming: { socket: { remoteAddress: "127.0.0.1" } } });

    const read = await call(`/runs/${runId}/integration`, "owner-fixture");
    expect(read.status).toBe(200);
    const body = await read.json() as { integration: { branch: string; commits: Array<{ task: string }>; tasksDone: boolean; merge: { possible: boolean } } };
    expect(body.integration).toMatchObject({ branch: branch(), tasksDone: true, merge: { possible: true } });
    expect(body.integration.commits.map(commit => commit.task)).toEqual(["task-a"]);

    // A worker credential is scoped to its own run and never reads another run's delivery.
    expect((await call(`/runs/${runId}/integration`, "worker-fixture")).status).toBe(403);

    const mergeBody = { protocolVersion: "1.0", runId, actionId: runId,
      expectedEntityVersion: governance.getRun(runId).entityVersion, idempotencyKey: "merge-route-1", payload: {} };
    const merged = await call(`/runs/${runId}/merge`, "owner-fixture", "POST", mergeBody);
    expect(merged.status).toBe(200);
    expect(await merged.json()).toMatchObject({ status: "merged", mode: "fast-forward", branch: branch() });
    const result = await call(`/runs/${runId}/tasks/task-a/result`, "owner-fixture");
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ result: { patch: expect.stringContaining("export const health") } });
    expect(await (await call(`/runs/${runId}/integration`, "owner-fixture")).json())
      .toMatchObject({ integration: { merge: { merged: true } } });
    const again = await call(`/runs/${runId}/merge`, "owner-fixture", "POST", { ...mergeBody, idempotencyKey: "merge-route-2" });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ status: "merged", mode: "up-to-date" });
  });
});
