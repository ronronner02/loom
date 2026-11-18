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
  it("does not offer a merge while no task's work has landed", async () => {
    const ownerHead = git(repo, "rev-parse", "HEAD").trim();
    stage("task-a", "src/health.ts", "export const health = () => 'ok';\n");
    complete("task-a");
    approveReview("task-a");

    const status = integration.status(runId);
    expect(status.commits).toEqual([]);
    expect(status.merge).toEqual({ possible: false, merged: false, reason: "No task's work has landed on the integration branch yet." });
    expect(integration.merge(runId)).toMatchObject({ status: "refused", code: "merge_not_ready" });
    // The refusal is what keeps the owner's checkout exactly where it was.
    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(ownerHead);
  });

  it("does not offer a merge while any task has failed, the lead included", async () => {
    stage("task-a", "src/health.ts", "export const health = () => 'ok';\n");
    complete("task-a");
    approveReview("task-a");
    expect((await integration.integrate(runId, "task-a")).status).toBe("committed");
    // A lead whose turn failed never decomposed the plan. The run has landed work, but it has
    // not delivered what the owner approved, so its branch is not ready.
    expect(governance.createTask(request("lead-task", {
      assignment: { taskId: "lead-task", role: "lead", paths: ["src"], dependencies: [] },
      outputs: [], permissions: [], sourceSession: "owner", destinationSession: "lead@rig", body: "Decompose the plan",
    }), currentBinding()).status).toBe("accepted");
    const lead = governance.findTask(runId, "lead-task")!;
    governance.recordAttempt(request("attempt-lead", { qitemId: lead.qitemId, role: "lead", provider: "claude",
      identity: { nativeSessionId: "native-lead", tmuxServer: "/tmp/tmux.sock", paneId: "%1", processId: 4242,
        processStart: "lead-start", generation: 1, policyFingerprint: governance.getRun(runId).binding.policyFingerprint },
      unknownReason: null, state: "running", usage: unusedUsage }), currentBinding());
    stopAttempt("attempt-lead");
    const failed = governance.recordTaskOutcome(request(lead.qitemId, {
      expectedTaskVersion: lead.entityVersion, state: "failed", actorSession: "lead@rig",
      attemptId: "attempt-lead", expectedAttemptVersion: governance.getAttempt("attempt-lead")!.entityVersion,
      evidence: { validated: false, reasonCode: "evidence_invalid" },
    }), { kind: "daemon", sessionId: "daemon" });
    expect(failed.status, JSON.stringify(failed)).toBe("observed");

    expect(governance.queueState(lead.qitemId)).toBe("failed");
    expect(integration.status(runId).merge).toEqual({ possible: false, merged: false, reason: "Task(s) failed: lead-task" });
    expect(integration.merge(runId)).toMatchObject({ status: "refused", code: "merge_not_ready" });
  });

  it.each([
    [null, "", true],
    ["lead-proposal.json", JSON.stringify([{ taskId: "follow-up", seat: "impl@rig", paths: ["src/next.ts"], dependencies: [], body: "Follow up" }]), true],
    ["lead-escalation.json", JSON.stringify({ question: "Extend the goal?", options: ["Keep it", "Extend it"] }), true],
    ["src/health.ts", "export const health = () => 'changed by lead';\n", false],
  ] as const)("judges only the delivery lead's turn after landing and restart: %s", async (path, content, valid) => {
    expect(governance.createTask(request("lead-task", {
      assignment: { taskId: "lead-task", role: "lead", paths: ["src"], dependencies: [] },
      outputs: [], permissions: [], sourceSession: "owner", destinationSession: "lead@rig", body: "Manage delivery",
    }), currentBinding()).status).toBe("accepted");
    const lead = governance.findTask(runId, "lead-task")!;
    const candidate = runtime.candidateFor(runId, "lead-task", "worker1");
    writeFileSync(join(candidate.root, "lead-proposal.json"), "[]");
    const startedAt = head();
    stage("task-a", "src/health.ts", "export const health = () => 'ok';\n");
    complete("task-a");
    approveReview("task-a");
    expect((await integration.integrate(runId, "task-a")).status).toBe("committed");
    expect(head()).not.toBe(startedAt);
    expect(git(candidate.root, "rev-parse", "HEAD").trim()).toBe(startedAt);
    compose();
    startAttempt("lead-task", "attempt-lead", "lead");
    const turnBase = head();
    expect(git(candidate.root, "rev-parse", "HEAD").trim()).toBe(turnBase);
    if (path) writeFileSync(join(candidate.root, path), content);
    // Another task can land while the lead runs. Recovery must keep the turn's own base.
    expect(admit("task-b", "implementer", "impl@rig").status).toBe("accepted");
    stage("task-b", "src/other.ts", "export const other = 1;\n");
    complete("task-b");
    approveReview("task-b");
    expect((await integration.integrate(runId, "task-b")).status).toBe("committed");
    compose();
    await composeAttemptCompletion({ db, governance, currentBinding, alive: () => false, log: () => {},
      sessions: { findResumeContextByName: () => null, updateStartupStatus: vi.fn() },
      candidateManifestFor: (id, taskId) => runtime.candidateManifestFor(id, taskId),
      readLeadProposal: (id, taskId) => runtime.leadProposalFor(id, taskId),
      readLeadEscalation: (id, taskId) => {
        const escalation = runtime.leadEscalationFor(id, taskId);
        return escalation && { optionCount: escalation.options.length };
      },
    }).sweep();
    expect(governance.getTask(lead.qitemId)?.evidence).toMatchObject({ validated: valid, baseIdentifier: turnBase,
      changedPaths: path ? [path] : [], outsideAssignment: valid ? [] : [path] });
    if (valid) expect(governance.queueState(lead.qitemId)).toBe("done");
    else expect(governance.getAttempt("attempt-lead")?.failure?.reasonCode).toBe("evidence_invalid");
    expect(integration.status(runId).merge.possible).toBe(valid);
  });

  it.each(["pending", "in-progress", "blocked"])("does not offer a merge while the delivery lead is %s", async state => {
    stage("task-a", "src/health.ts", "export const health = () => 'ok';\n");
    complete("task-a");
    approveReview("task-a");
    expect((await integration.integrate(runId, "task-a")).status).toBe("committed");
    expect(governance.createTask(request("lead-task", {
      assignment: { taskId: "lead-task", role: "lead", paths: ["src"], dependencies: [] },
      outputs: [], permissions: [], sourceSession: "owner", destinationSession: "lead@rig", body: "Manage delivery",
    }), currentBinding()).status).toBe("accepted");
    db.prepare("UPDATE queue_items SET state = ? WHERE qitem_id = ?").run(state, governance.findTask(runId, "lead-task")!.qitemId);
    expect(integration.status(runId).merge).toEqual({ possible: false, merged: false, reason: "Task(s) still open: lead-task" });
    expect(integration.merge(runId)).toMatchObject({ status: "refused", code: "merge_not_ready" });
  });

});
