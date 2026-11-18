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
  it("preserves the lead candidate and refuses admission while another stop is being finalized", () => {
    readyTaskA();
    expect(governance.createTask(request("lead", { assignment: { taskId: "lead", role: "lead", paths: ["src"], dependencies: [] },
      outputs: [], permissions: ["request-assignment"], sourceSession: "owner", destinationSession: "lead@rig", body: "Manage delivery" }), currentBinding()).status).toBe("accepted");
    const candidate = runtime.candidateFor(runId, "lead", "worker1");
    const sentinel = join(candidate.root, "src", "evidence.txt");
    writeFileSync(sentinel, "Unfinished turn evidence");
    db.prepare("INSERT INTO team_attempt_finalizations (attempt_id, progress_json) VALUES (?, ?)").run("attempt-task-a", '{"completed":[]}');
    expect(() => runtime.prepareDeliveryLeadTurn(runId, "lead")).toThrow("managed_finalization_pending");
    expect(readFileSync(sentinel, "utf8")).toBe("Unfinished turn evidence");
    const task = governance.findTask(runId, "task-a")!;
    expect(() => runtime.admitForLaunch(runId, { attemptId: "new-attempt", worker: "worker1", assignment: task.assignment,
      outputs: task.outputs!, permissions: task.permissions!, context: { runId, role: "implementer", binding: currentBinding() } as ContextManifest }))
      .toThrow("managed_finalization_pending");
    expect(integration.status(runId).merge).toMatchObject({ possible: false });
  });

  it.each([false, true])("recovers a committed intent without rereading its candidate (later commit: %s)", async laterCommit => {
    readyTaskA();
    const root = governance.getRun(runId).binding.repository.root;
    const parent = head();
    const fault = vi.spyOn(governance, "recordIntegrationCommit").mockImplementationOnce(() => { throw new Error("fault: before integration database record"); });
    await expect(integration.integrate(runId, "task-a")).rejects.toThrow("fault: before integration database record");
    fault.mockRestore();
    const landed = head();
    expect(landed).not.toBe(parent);
    expect(governance.integrationRecord(runId).commits).toHaveLength(0);
    if (laterCommit) git(root, "commit", "--quiet", "--allow-empty", "-m", "Later branch work");
    const tip = head();
    db.prepare("UPDATE team_runs SET display_name = ? WHERE id = ?").run("Renamed run", runId);
    db.prepare("UPDATE team_queue_authority SET display_name = ? WHERE run_id = ? AND task_id = ?").run("Renamed task", runId, "task-a");
    const candidate = restartWithoutCandidateReads();
    const recovered = await integration.integrate(runId, "task-a");
    expect(recovered).toMatchObject({ status: "committed", commitSha: landed });
    expect(head()).toBe(tip);
    expect(governance.integrationRecord(runId).commits).toMatchObject([{ taskId: "task-a", commitSha: landed }]);
    expect(candidate).not.toHaveBeenCalled();
    await expect(integration.integrate(runId, "task-a")).resolves.toMatchObject({ status: "already-integrated" });
    expect(head()).toBe(tip);
  });

  it("keeps a failed branch probe retryable without changing the saved intent", async () => {
    readyTaskA();
    const fault = vi.spyOn(governance, "recordIntegrationCommit").mockImplementationOnce(() => {
      throw new Error("fixture receipt unavailable");
    });
    await expect(integration.integrate(runId, "task-a")).rejects.toThrow("fixture receipt unavailable");
    fault.mockRestore();
    const landed = head();
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const command = vi.mocked(execFileSync);
    command.mockImplementation((file, args, options) => {
      if (file === "git" && args?.includes("--abbrev-ref")) throw new Error("fixture branch probe unavailable");
      return actual.execFileSync(file, args, options);
    });
    try {
      await expect(integration.integrate(runId, "task-a")).rejects.toThrow("fixture branch probe unavailable");
      expect(db.prepare("SELECT repair_reason AS reason FROM team_integration_intents WHERE run_id = ? AND task_id = ?")
        .get(runId, "task-a")).toEqual({ reason: null });
    } finally { command.mockImplementation(actual.execFileSync); }
    const candidate = restartWithoutCandidateReads();
    await expect(integration.integrate(runId, "task-a")).resolves.toMatchObject({ status: "committed", commitSha: landed });
    expect(head()).toBe(landed);
    expect(candidate).not.toHaveBeenCalled();
  });

  it("uses the completed record when the caller fails after the database commit", async () => {
    readyTaskA();
    const record = governance.recordIntegrationCommit.bind(governance);
    const fault = vi.spyOn(governance, "recordIntegrationCommit").mockImplementationOnce((...args) => {
      record(...args); throw new Error("fault: after integration database commit");
    });
    await expect(integration.integrate(runId, "task-a")).rejects.toThrow("fault: after integration database commit");
    fault.mockRestore();
    const landed = head();
    const candidate = restartWithoutCandidateReads();
    await expect(integration.integrate(runId, "task-a")).resolves.toMatchObject({ status: "already-integrated" });
    expect(head()).toBe(landed);
    expect(governance.integrationRecord(runId).commits).toHaveLength(1);
    expect(candidate).not.toHaveBeenCalled();
  });

  it("records the checked-out branch rather than a newly derived run slug", async () => {
    readyTaskA();
    const root = governance.getRun(runId).binding.repository.root;
    const actual = "team/actual-integration-target";
    git(root, "branch", "-m", actual);
    const result = await integration.integrate(runId, "task-a");
    expect(result.status).toBe("committed");
    expect(governance.integrationRecord(runId).branch).toBe(actual);
    expect(git(root, "symbolic-ref", "--short", "HEAD").trim()).toBe(actual);
  });

});
