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
  it.each([false, true])("keeps an in-flight candidate's recorded base and applies it on top of the moved head (restart: %s)", async restart => {
    expect(admit("task-b", "implementer", "impl@rig").status).toBe("accepted");
    // Both tasks start from the same head; the second candidate is staged before anything lands.
    const a = stage("task-a", "src/shared.ts", "export const shared = 'a';\n");
    const b = stage("task-b", "src/other.ts", "export const other = 'b';\n");
    expect(b.base).toMatchObject({ kind: "commit", commit: a.base.kind === "commit" ? a.base.commit : "" });
    const stagedAt = b.base.kind === "commit" ? b.base.commit : "";

    complete("task-a");
    approveReview("task-a");
    expect((await integration.integrate(runId, "task-a")).status).toBe("committed");
    expect(head()).not.toBe(stagedAt);

    if (restart) { reopen(); }

    // The candidate was staged from a head the branch has moved past, and the daemon can still
    // read it: it keeps its own base, and its patch lands on top of the landed work.
    const manifest = runtime.candidateManifestFor(runId, "task-b");
    expect(manifest.baseIdentifier).toBe(stagedAt);
    expect(taskCompletionEvidence({ role: "implementer", assignmentPaths: ["src/other.ts"], manifest }))
      .toMatchObject({ validated: true, changedPaths: ["src/other.ts"], outsideAssignment: [] });
    complete("task-b");
    approveReview("task-b");
    expect((await integration.integrate(runId, "task-b")).status).toBe("committed");

    const root = governance.getRun(runId).binding.repository.root;
    expect(git(root, "show", "--format=", "--name-only", "HEAD").trim()).toBe("src/other.ts");
    expect(git(root, "show", "--format=", "--name-only", "HEAD~1").trim()).toBe("src/shared.ts");
    expect(git(root, "log", "--format=%s", "-1").trim()).toBe("Implement task-b");
  });

});
