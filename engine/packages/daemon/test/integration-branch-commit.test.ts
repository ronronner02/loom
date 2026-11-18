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
  it("fails the task with integration_conflict and leaves the branch unchanged when the patch will not apply", async () => {
    expect(admit("task-b", "implementer", "impl@rig").status).toBe("accepted");
    stage("task-a", "src/shared.ts", "export const shared = 'a';\n");
    stage("task-b", "src/shared.ts", "export const shared = 'b';\n");

    complete("task-a");
    approveReview("task-a");
    const landed = await integration.integrate(runId, "task-a");
    expect(landed.status).toBe("committed");
    const headAfterA = head();

    complete("task-b");
    approveReview("task-b");
    const conflict = await integration.integrate(runId, "task-b");
    expect(conflict.status).toBe("conflict");

    // The branch is exactly where the first approval left it.
    expect(head()).toBe(headAfterA);
    expect(integration.status(runId).commits.map(commit => commit.task)).toEqual(["task-a"]);
    // The task is failed, named, and never retried: replaying the same patch fails the same way.
    const task = governance.findTask(runId, "task-b")!;
    expect(governance.queueState(task.qitemId)).toBe("failed");
    expect(task.evidence).toMatchObject({ reasonCode: "integration_conflict" });
    expect(String(task.evidence?.integrationConflict)).toMatch(/patch|conflict|merge/i);
    expect(classificationFor("integration_conflict").retryEligible).toBe(false);
    const events = db.prepare(`SELECT payload FROM events WHERE type = 'team.control'
      AND json_extract(payload, '$.action') = 'task.outcome'`).all() as Array<{ payload: string }>;
    expect(events.map(event => JSON.parse(event.payload).payload.observedBy)).toContain("daemon");
    expect(integration.status(runId).tasksDone).toBe(false);
  });

  it("still refuses an in-flight candidate when the owner's own source moved", async () => {
    expect(admit("task-b", "implementer", "impl@rig").status).toBe("accepted");
    stage("task-b", "src/other.ts", "export const other = 1;\n");
    // The owner commits on their own branch while the candidate is staged. The daemon owns the
    // `team/` namespace, not this ref, so the candidate is refused exactly as it was before U7.
    writeFileSync(join(repo, "src", "owner.ts"), "export const owner = 1;\n");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "owner work");
    expect(() => runtime.candidateManifestFor(runId, "task-b")).toThrow(/Source checkout changed/);
  });

  it("lands the commit when the daemon's own sweep records an approving review", async () => {
    stage("task-a", "src/health.ts", "export const health = () => 'ok';\n");
    const turnRoot = join(directory, "turns");
    startAttempt("task-a", "attempt-sweep", "implementer");
    const completion: AttemptCompletion = composeAttemptCompletion({
      db, governance, currentBinding, alive: () => false, log: () => {}, turnStateRoot: turnRoot,
      sessions: { findResumeContextByName: () => null, updateStartupStatus: vi.fn() },
      candidateManifestFor: (id, taskId) => runtime.candidateManifestFor(id, taskId),
      integrateTask: (id, taskId) => integration.integrate(id, taskId),
    });
    await completion.sweep();
    expect(governance.findTask(runId, "task-a-review-1")?.assignment.role).toBe("reviewer");

    const reviewerAttempt = startAttempt("task-a-review-1", "attempt-review", "reviewer");
    const path = agentTurnOutputPaths(turnRoot, "attempt-review").lastMessage;
    mkdirSync(join(turnRoot, "turns", "attempt-review"), { recursive: true });
    writeFileSync(path, "```json\n" + JSON.stringify({ findings: [] }) + "\n```\n");
    expect(reviewerAttempt.status).toBe("observed");
    await completion.sweep();

    expect(integration.status(runId).commits.map(commit => commit.task)).toEqual(["task-a"]);
    const root = governance.getRun(runId).binding.repository.root;
    expect(git(root, "log", "--format=%s", "-1").trim()).toBe("Implement task-a");

    // A second sweep finds the commit already recorded, so it commits nothing twice.
    await completion.sweep();
    expect(integration.status(runId).commits).toHaveLength(1);
  });

});
