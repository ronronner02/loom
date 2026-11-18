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
  it("keeps a completed result readable after Merge without a restart", async () => {
    const candidate = stage("task-a", "src/health.ts", "export const health = () => 'ok';\n");
    complete("task-a");
    approveReview("task-a");
    await integration.integrate(runId, "task-a");
    const result = runtime.candidateManifestFor(runId, "task-a");
    const beforeMerge = sourceFingerprint(candidate.sourceRoot);

    expect(integration.merge(runId)).toMatchObject({ status: "merged", mode: "fast-forward" });
    const afterMerge = sourceFingerprint(candidate.sourceRoot);
    expect(afterMerge).toMatchObject({ head: beforeMerge.head, statusDigest: beforeMerge.statusDigest,
      dirtyHashes: beforeMerge.dirtyHashes });
    expect(afterMerge.refsDigest).not.toBe(beforeMerge.refsDigest);

    // A fresh runtime and the existing runtime must read the same registered candidate.
    const cachedRuntime = runtime;
    compose();
    expect(runtime.candidateManifestFor(runId, "task-a")).toEqual(result);
    expect(cachedRuntime.candidateManifestFor(runId, "task-a")).toEqual(result);

    const earlierRun = runId;
    fixture.useRun("run-2");
    runId = "run-2";
    const later = ensurePlanWorktree({ repositoryRoot: repo, worktreeRoot: worktrees, runId, name: runName }).path;
    commitPlan({ worktree: later, planRef: "plan.md", plan: "# Plan\n\nAdd metrics.\n", message: "plan: metrics" });
    binding = bindingForGoal({ root: later, planRef: "plan.md", writePaths: ["src"], policy });
    fixture.useBinding(binding);
    governance.createRun({ id: runId, rigId: "rig", binding, reviewerSeat: "review@rig", displayName: runName });
    governance.requestApproval(request("implementation-run-2", { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest: hashBinding(binding) }, targetDigest: hashBinding(binding),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString() }), { kind: "worker", sessionId: "lead@rig" });
    expect(governance.decideApproval(request("implementation-run-2", { approvalVersion: 1, decision: "approved" }),
      owner, binding).status).toBe("accepted");
    expect(admit("task-b", "implementer", "impl@rig").status).toBe("accepted");
    stage("task-b", "src/metrics.ts", "export const metrics = () => ({});\n");
    complete("task-b");
    approveReview("task-b");
    expect((await integration.integrate(runId, "task-b")).status).toBe("committed");
    expect(integration.merge(runId)).toMatchObject({ status: "merged", mode: "fast-forward" });
    expect(runtime.candidateManifestFor(earlierRun, "task-a")).toEqual(result);
  });

  it.each([false, true])("does not forgive unrelated source changes during Merge (invalidated: %s)", async (invalidated) => {
    stage("task-a", "src/health.ts", "export const health = () => 'ok';\n");
    complete("task-a");
    approveReview("task-a");
    await integration.integrate(runId, "task-a");
    git(repo, "branch", "owner-other");
    if (invalidated) {
      expect(() => runtime.candidateManifestFor(runId, "task-a")).toThrow(/Source checkout changed/);
      git(repo, "branch", "-D", "owner-other");
    }
    expect(integration.merge(runId).status).toBe("merged");
    expect(() => runtime.candidateManifestFor(runId, "task-a")).toThrow(/Source checkout changed/);
  });

  it("refuses a merge while work is open, fast-forwards a clean checkout, and refuses a dirty one", async () => {
    stage("task-a", "src/health.ts", "export const health = () => 'ok';\n");
    const stillOpen = integration.merge(runId);
    expect(stillOpen).toMatchObject({ status: "refused", code: "merge_tasks_open" });

    complete("task-a");
    approveReview("task-a");
    await integration.integrate(runId, "task-a");

    // A dirty owner checkout is refused before anything moves, and nothing does.
    const ownerHead = git(repo, "rev-parse", "HEAD").trim();
    writeFileSync(join(repo, "src", "base.ts"), "export const base = 2;\n");
    expect(integration.merge(runId)).toMatchObject({ status: "refused", code: "merge_checkout_dirty" });
    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(ownerHead);
    git(repo, "checkout", "--", "src/base.ts");

    const merged = integration.merge(runId);
    expect(merged).toMatchObject({ status: "merged", mode: "fast-forward", branch: branch() });
    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(head());
    expect(git(repo, "show", "--format=", "--name-only", "HEAD").trim()).toBe("src/health.ts");
  });

});
