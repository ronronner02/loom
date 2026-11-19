import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { initializeDatabase } from "../src/db/baseline.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { PlanGovernance, hashBytes } from "../src/domain/plan-governance.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import type { LeadRosterSeat } from "../src/domain/lead-roster.js";
import { addTeamSeats, createTeam } from "../src/domain/team-setup.js";
import { continuationNote } from "../src/domain/agent-turn.js";
import { appendChatMessage, takeOwnerMessages } from "../src/domain/lead-chat.js";
import { unisolatedPolicyCapability } from "../src/routes/team-start.js";
import { createTestApp } from "./helpers/test-app.js";
import { symlinkRefusal } from "./helpers/symlink.js";

const seats: LeadRosterSeat[] = [{ role: "implementer", client: "claude-code" }, { role: "implementer", client: "codex" },
  { role: "reviewer", client: "codex" }];
const policy = unisolatedPolicyCapability(4);
const peer = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };

describe("planning roster approval", () => {
  let root: string, repository: string, candidate: string, runId: string;
  let db: Database.Database, governance: PlanGovernance, app: ReturnType<typeof createTestApp>["app"];
  let cap: number, concurrency: number;
  const dispatch = vi.fn(async () => {});
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const call = (path: string, payload?: unknown, token = "fixture-owner") => app.request(`/api/team-control${path}`, {
    method: payload === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  }, peer);
  const command = (payload: unknown) => ({ protocolVersion: "1.0", runId, actionId: "approve-plan",
    expectedEntityVersion: governance.getRun(runId).entityVersion, idempotencyKey: "approve-" + Math.random(), payload });
  const rosterDigest = () => hashBytes(readFileSync(join(candidate, "lead-roster.json")));
  const writeRoster = (value: unknown) => writeFileSync(join(candidate, "lead-roster.json"), JSON.stringify(value));
  const recordedSeats = () => db.prepare(`SELECT n.role, n.runtime AS client, s.session_name AS member
    FROM nodes n JOIN sessions s ON s.node_id = n.id ORDER BY n.logical_id`).all() as Array<{ role: string; client: string; member: string }>;
  const start = async (planRef?: string) => {
    const response = await call("/runs", { goal: "Add a health endpoint", planning: true, writePaths: ["src"],
      ...(planRef === undefined ? {} : { repository: { planRef } }) });
    expect(response.status, await response.clone().text()).toBe(201);
    runId = (await response.json() as { runId: string }).runId;
    // The candidate plan and roster represent a completed turn, including consumption of the owner's goal.
    takeOwnerMessages(db, runId, "completed-roster-fixture");
  };
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "roster-approval-"));
    repository = join(root, "repo"); candidate = join(root, "candidate");
    mkdirSync(repository); mkdirSync(candidate); mkdirSync(join(repository, "src"));
    git(repository, "init", "--quiet", "--initial-branch=main");
    git(repository, "config", "user.name", "Fixture"); git(repository, "config", "user.email", "fixture@example.invalid");
    writeFileSync(join(repository, "src/base.ts"), "export const base = 1;\n");
    git(repository, "add", "src/base.ts"); git(repository, "commit", "--quiet", "-m", "base");
    db = createDb(); initializeDatabase(db);
    createTeam(db, { repository, name: "demo" });
    const bus = new EventBus(db), queue = new QueueRepository(db, bus);
    governance = new PlanGovernance(db, bus, queue, undefined, () => policy);
    cap = 6; concurrency = 3; dispatch.mockClear();
    // Tree acquisition is a fixture seam; the actual bounded worker-file reader is unchanged.
    const runtime = Object.create(WorkflowRuntime.prototype) as WorkflowRuntime;
    runtime.candidateFor = () => ({ root: candidate }) as never;
    runtime.forgetCandidate = vi.fn();
    app = createTestApp(db, { appDeps: { eventBus: bus, queueRepo: queue, teamGovernance: governance,
      workflowRuntime: runtime, settingsStore: { resolveOne: (key: string) => ({
        value: key === "team.maxConcurrentAgents" ? concurrency : cap }) } as never,
      teamControl: { credentials: { ownerToken: "fixture-owner", workers: [{ token: "fixture-worker", sessionId: "worker", runId: "other" }] },
        readPolicyCapability: () => policy, planWorktreeRoot: () => join(root, "plans"), dispatch } } }).app;
    await start();
    writeFileSync(join(candidate, "plan.md"), "# Plan\n\nAdd the health endpoint and its tests in src/.\n");
    writeRoster({ seats });
  });
  afterEach(() => { if (db?.open) db.close(); rmSync(root, { recursive: true, force: true }); });

  it("holds roster approval while a later owner message awaits a lead turn", async () => {
    appendChatMessage(db, { id: "pending-roster-discussion", runId, body: "Explain the proposed staffing.",
      createdAt: new Date().toISOString() });
    const before = git(governance.getRun(runId).binding.repository.root, "rev-parse", "HEAD");
    const response = await call(`/runs/${runId}/plan/approve`, command({ rosterDigest: rosterDigest() }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "plan_not_awaiting_approval" });
    expect(recordedSeats()).toHaveLength(1);
    expect(git(governance.getRun(runId).binding.repository.root, "rev-parse", "HEAD")).toBe(before);
  });

  it("publishes the exact roster digest and creates its seats with plan approval", async () => {
    const read = await (await call(`/runs/${runId}/chat`)).json() as { planApproval: unknown };
    expect(read.planApproval).toEqual({ plan: { content: readFileSync(join(candidate, "plan.md"), "utf8"),
      hash: hashBytes(readFileSync(join(candidate, "plan.md"))) }, roster: { seats, digest: rosterDigest() }, error: null });
    expect(recordedSeats()).toHaveLength(1);
    const response = await call(`/runs/${runId}/plan/approve`, command({ rosterDigest: rosterDigest() }));
    expect(response.status, await response.clone().text()).toBe(200);
    expect(recordedSeats()).toEqual([
      { role: "implementer", client: "claude-code", member: "impl-1@demo" },
      { role: "implementer", client: "codex", member: "impl-2@demo" },
      { role: "lead", client: "claude-code", member: "lead-1@demo" },
      { role: "reviewer", client: "codex", member: "review-1@demo" },
    ]);
    expect(governance.getRun(runId)).toMatchObject({ phase: "delivery", reviewerSeat: "review-1@demo",
      binding: { limits: { maxSessions: 3 } } });
    expect(dispatch).toHaveBeenLastCalledWith(runId, "task-1");
    expect(() => readFileSync(join(repository, "plan.md"))).toThrow();
  });

  it.each([
    ["cap", { seats: Array.from({ length: 7 }, () => seats[0]) }],
    ["two reviewers", { seats: [seats[0], seats[2], seats[2]] }],
    ["no implementer", { seats: [seats[2]] }],
    ["unknown client", { seats: [{ role: "implementer", client: "other" }] }],
    ["lead role", { seats: [{ role: "lead", client: "codex" }] }],
    ["extra field", { seats, unexpected: true }],
  ])("returns %s to the planning lead without committing or creating seats", async (_name, roster) => {
    writeRoster(roster);
    const run = governance.getRun(runId), before = git(run.binding.repository.root, "rev-parse", "HEAD");
    const response = await call(`/runs/${runId}/plan/approve`, command({ rosterDigest: rosterDigest() }));
    expect(response.status, await response.clone().text()).toBe(409);
    expect(await response.json()).toMatchObject({ code: "lead_roster_refused", status: "denied", effectMayStart: true });
    expect(recordedSeats()).toHaveLength(1);
    expect(governance.getRun(runId).phase).toBe("planning");
    expect(git(run.binding.repository.root, "rev-parse", "HEAD")).toBe(before);
    expect(continuationNote(db, runId, "task-1", "lead")).toContain("lead-roster.json");
    expect((await call(`/runs/${runId}/chat`)).status).toBe(200);
  });

  it("refuses changed or missing roster evidence before advancing the plan commit", async () => {
    const digest = rosterDigest(), run = governance.getRun(runId), before = git(run.binding.repository.root, "rev-parse", "HEAD");
    writeRoster({ seats: [seats[0]] });
    const stale = await call(`/runs/${runId}/plan/approve`, command({ rosterDigest: digest }));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "lead_roster_refused", reason: expect.stringContaining("changed") });
    rmSync(join(candidate, "lead-roster.json"));
    expect((await call(`/runs/${runId}/chat`)).status).toBe(200);
    expect((await call(`/runs/${runId}/plan/approve`, command({ rosterDigest: digest }))).status).toBe(409);
    expect(git(run.binding.repository.root, "rev-parse", "HEAD")).toBe(before);
    expect(recordedSeats()).toHaveLength(1);
  });

  it("reads and approves the roster beside a nested plan, not the root roster", async () => {
    await start("docs/plans/plan.md");
    mkdirSync(join(candidate, "docs/plans"), { recursive: true });
    writeFileSync(join(candidate, "docs/plans/plan.md"), "# Nested plan");
    const nested = JSON.stringify({ seats: [seats[0]] });
    writeFileSync(join(candidate, "docs/plans/lead-roster.json"), nested);
    const response = await call("/runs/" + runId + "/chat");
    const read = await response.json() as { planApproval: { roster: { seats: unknown; digest: string }; error: unknown } };
    expect(read.planApproval).toMatchObject({ roster: { seats: [seats[0]], digest: hashBytes(nested) }, error: null });
    expect((await call("/runs/" + runId + "/plan/approve", command({ rosterDigest: read.planApproval.roster.digest }))).status).toBe(200);
    expect(recordedSeats()).toHaveLength(2);
    expect(governance.getRun(runId).phase).toBe("delivery");
  });

  it.skipIf(symlinkRefusal !== null)("refuses a symlinked roster through the real bounded reader without exposing its target", async () => {
    const outside = join(root, "outside-roster.json");
    writeFileSync(outside, "outside-roster-bytes");
    rmSync(join(candidate, "lead-roster.json"));
    symlinkSync(outside, join(candidate, "lead-roster.json"));
    const before = git(governance.getRun(runId).binding.repository.root, "rev-parse", "HEAD");
    const read = await (await call(`/runs/${runId}/chat`)).json() as { planApproval: { roster: unknown; error: string } };
    expect(read.planApproval.roster).toBeNull();
    // The bounded reader refuses the link by naming what it found; the errno is the host's.
    expect(read.planApproval.error).toMatch(/ELOOP|became a symlink/);
    expect(read.planApproval.error).not.toContain("outside-roster-bytes");
    const response = await call(`/runs/${runId}/plan/approve`, command({ rosterDigest: "unread" }));
    expect(response.status).toBe(409);
    expect(governance.getRun(runId).phase).toBe("planning");
    expect(recordedSeats()).toHaveLength(1);
    expect(git(governance.getRun(runId).binding.repository.root, "rev-parse", "HEAD")).toBe(before);
  });

});
