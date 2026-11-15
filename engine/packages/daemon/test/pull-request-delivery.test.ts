import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { initializeDatabase } from "../src/db/baseline.js";
import { composePullRequestDelivery, githubIdentity, readPullRequest, type AgentHost, type OwnerHost } from "../src/domain/pull-request-delivery.js";
import type { Integration, IntegrationStatus } from "../src/domain/integration-branch.js";
import type { PlanGovernance } from "../src/domain/plan-governance.js";
import { teamMergeRoutes } from "../src/routes/team-merge.js";

/**
 * Plan R17 / KTD13 — a GitHub project's finished run becomes one pull request opened by the agent
 * account, updated by later commits, and merged by the owner's account at the head they saw.
 */
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8",
  env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } }).trim();

describe("pull request delivery", () => {
  let repo: string, db: Database.Database, clock: number;
  let status: IntegrationStatus, calls: string[], agentLogin: string | null, pushOk: boolean;
  const agent: AgentHost = {
    status: async () => ({ signedIn: agentLogin !== null, login: agentLogin }),
    repositoryAccess: async identity => { calls.push(`access ${identity}`); return { push: true, defaultBranch: "main" }; },
    pushBranch: async (_repository, branch) => { calls.push(`push ${branch}`); if (!pushOk) throw new Error("network"); },
    findPullRequest: async () => { calls.push("find"); return null; },
    createPullRequest: async (identity, branch, base, title) => { calls.push(`create ${identity} ${branch}->${base} ${title}`); return { number: 7, url: `https://github.com/${identity}/pull/7` }; },
  };
  const owner: OwnerHost = {
    status: async () => ({ signedIn: true, login: "owner-login" }),
    mergePullRequest: async (identity, number, head) => { calls.push(`merge ${identity}#${number}@${head.slice(0, 7)}`); },
  };
  const delivery = () => composePullRequestDelivery({ db, agent, owner, log: () => undefined, now: () => new Date(clock),
    governance: { getRun: () => ({ id: "run", displayName: "Dark mode", phase: "delivery", binding: {} }) } as unknown as PlanGovernance,
    integration: { status: () => status, merge: () => { throw new Error("local merge not expected"); } } as unknown as Integration });
  const commit = (message: string) => { writeFileSync(join(repo, "f.txt"), message); git(repo, "add", "f.txt"); git(repo, "commit", "-qm", message); };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "pr-delivery-"));
    git(repo, "init", "-q", "-b", "main"); commit("base");
    git(repo, "checkout", "-q", "-b", "team/dark-mode"); commit("Add the toggle"); git(repo, "checkout", "-q", "main");
    git(repo, "remote", "add", "origin", "https://github.com/owner-login/app.git");
    db = createDb(":memory:"); initializeDatabase(db);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'App')").run();
    db.prepare(`INSERT INTO team_runs (id, rig_id, binding_json, binding_digest, state, created_at, updated_at)
      VALUES ('run', 'rig', '{}', 'sha256:x', 'approved', '2026-11-14T00:00:00Z', '2026-11-14T00:00:00Z')`).run();
    clock = Date.parse("2026-11-14T00:00:00Z"); calls = []; agentLogin = "team-agent"; pushOk = true;
    status = { runId: "run", branch: "team/dark-mode", repository: repo, worktree: null, tasksDone: true,
      commits: [{ hash: "abc1234", subject: "Add the toggle", task: "impl" }], merge: { possible: true, reason: null, merged: false } };
  });
  afterEach(() => { db.close(); rmSync(repo, { recursive: true, force: true }); });

  it("reads owner/name from GitHub remotes only", () => {
    expect(githubIdentity("https://github.com/owner/app.git")).toBe("owner/app");
    expect(githubIdentity("git@github.com:owner/app.git")).toBe("owner/app");
    expect(githubIdentity("https://github.com/owner/app")).toBe("owner/app");
    expect(githubIdentity("https://gitlab.com/owner/app.git")).toBeNull();
    expect(githubIdentity("D:/repos/app")).toBeNull();
  });

  it("opens one pull request as the agent once every task is done, and pushes again only when the branch moves", async () => {
    const service = delivery();
    await service.sweep();
    expect(calls).toEqual(["access owner-login/app", "push team/dark-mode", "find", "create owner-login/app team/dark-mode->main Dark mode"]);
    const record = readPullRequest(db, "run")!;
    expect(record).toMatchObject({ number: 7, url: "https://github.com/owner-login/app/pull/7", state: "open" });
    calls = [];
    await service.sweep();
    expect(calls).toEqual([]);
    git(repo, "checkout", "-q", "team/dark-mode"); commit("Follow-up: rename"); git(repo, "checkout", "-q", "main");
    await service.sweep();
    expect(calls).toEqual(["access owner-login/app", "push team/dark-mode"]);
    expect(readPullRequest(db, "run")!.headSha).not.toBe(record.headSha);
  });

  it("keeps the local merge when tasks are open, the origin is not GitHub, or the agent is missing or the owner", async () => {
    status = { ...status, tasksDone: false };
    await delivery().sweep();
    status = { ...status, tasksDone: true };
    git(repo, "remote", "set-url", "origin", "https://gitlab.com/owner-login/app.git");
    await delivery().sweep();
    git(repo, "remote", "set-url", "origin", "https://github.com/owner-login/app.git");
    agentLogin = null;
    await delivery().sweep();
    agentLogin = "owner-login";
    await delivery().sweep();
    expect(calls).toEqual([]);
    expect(readPullRequest(db, "run")).toBeNull();
    expect(await delivery().merge("run")).toBeNull();
  });

  it("backs off after a failed push instead of calling GitHub every sweep", async () => {
    pushOk = false;
    const service = delivery();
    await service.sweep();
    expect(calls.filter(call => call.startsWith("push"))).toHaveLength(1);
    clock += 30_000; await service.sweep();
    expect(calls.filter(call => call.startsWith("push"))).toHaveLength(1);
    clock += 31_000; pushOk = true; await service.sweep();
    expect(calls.filter(call => call.startsWith("push"))).toHaveLength(2);
    expect(readPullRequest(db, "run")?.state).toBe("open");
  });

  it("merges the open pull request with the owner's account at the recorded head", async () => {
    const service = delivery();
    await service.sweep();
    const head = readPullRequest(db, "run")!.headSha;
    const outcome = await service.merge("run");
    expect(outcome).toMatchObject({ status: "merged", mode: "pull-request", head, branch: "team/dark-mode" });
    expect(calls.at(-1)).toBe(`merge owner-login/app#7@${head.slice(0, 7)}`);
    expect(readPullRequest(db, "run")!.state).toBe("merged");
    calls = [];
    await service.sweep();
    expect(calls).toEqual([]);
  });

  const task = (taskId: string, role: "lead" | "implementer" | "reviewer", state: string) => {
    db.prepare(`INSERT INTO queue_items
      (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body)
      VALUES (?, ?, ?, 'owner', 'worker', ?, 'Fixture task')`).run(taskId, new Date(clock).toISOString(), new Date(clock).toISOString(), state);
    db.prepare(`INSERT INTO team_queue_authority (qitem_id, run_id, task_id, assignment_json)
      VALUES (?, 'run', ?, ?)`).run(taskId, taskId, JSON.stringify({ taskId, role, paths: ["src"], dependencies: [] }));
  };

  it.each(["pending", "in-progress", "blocked", "failed"])("refuses an open PR merge after a task becomes %s", async state => {
    const service = delivery();
    await service.sweep();
    calls = [];
    task("followup", "implementer", state);
    expect(await service.merge("run")).toMatchObject({ status: "refused", code: "merge_tasks_open" });
    expect(calls).toEqual([]);
    expect(readPullRequest(db, "run")!.state).toBe("open");
  });

  it.each(["pending", "failed"])("refuses an open PR merge while the lead is %s", async state => {
    const service = delivery();
    await service.sweep();
    calls = [];
    task("lead", "lead", state);
    expect(await service.merge("run")).toMatchObject({ status: "refused", code: "merge_not_ready" });
    expect(calls).toEqual([]);
  });

  it("does not create a PR while the delivery lead has failed", async () => {
    task("lead", "lead", "failed");
    await delivery().sweep();
    expect(calls).toEqual([]);
    expect(readPullRequest(db, "run")).toBeNull();
  });

  it("waits until the latest integrated branch head is delivered before merging", async () => {
    const service = delivery();
    await service.sweep();
    const previousHead = readPullRequest(db, "run")!.headSha;
    git(repo, "checkout", "-q", "team/dark-mode"); commit("Reviewed follow-up"); git(repo, "checkout", "-q", "main");
    calls = [];
    expect(await service.merge("run")).toMatchObject({ status: "refused", code: "merge_delivery_pending" });
    expect(calls).toEqual([]);
    expect(readPullRequest(db, "run")!.headSha).toBe(previousHead);
    await service.sweep();
    const delivered = readPullRequest(db, "run")!;
    expect(delivered.headSha).not.toBe(previousHead);
    expect(await service.merge("run")).toMatchObject({ status: "merged", head: delivered.headSha });
  });

  it("does not apply local checkout restrictions to GitHub merge", async () => {
    const service = delivery();
    await service.sweep();
    status = { ...status, merge: { possible: false, reason: "The owner's checkout has uncommitted changes.", merged: false } };
    calls = [];
    expect(await service.merge("run")).toMatchObject({ status: "merged", mode: "pull-request" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^merge /);
  });

  it("returns HTTP 409 when an open pull request fails the shared readiness gate", async () => {
    const service = delivery();
    await service.sweep();
    task("followup", "reviewer", "pending");
    const app = teamMergeRoutes({ credentials: { ownerToken: "fixture-owner" }, legacyTokens: [],
      integration: { status: () => status } as unknown as Integration, delivery: () => service });
    const response = await app.request("/runs/run/merge", { method: "POST", headers: {
      Authorization: "Bearer fixture-owner", "Content-Type": "application/json",
    }, body: JSON.stringify({ protocolVersion: "1.0", runId: "run", actionId: "run",
      expectedEntityVersion: 1, idempotencyKey: "fixture-merge", payload: {} }) },
      { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ status: "refused", code: "merge_tasks_open" });
  });

  const recovering = (kind: string) => {
    if (kind === "repair") {
      db.prepare(`INSERT INTO team_integration_intents
        (run_id, task_id, repository, worktree, branch, parent_sha, tree_sha, subject, message, repair_reason, created_at)
        VALUES ('run', 'impl', ?, ?, 'team/dark-mode', 'parent', 'tree', 'work', 'work', 'Moved tree', ?)`)
        .run(repo, repo, new Date(clock).toISOString());
    } else {
      task("impl", "implementer", "done");
      db.prepare(`INSERT INTO team_attempts
        (id, run_id, qitem_id, role, provider, identity_json, state, usage_json, active_ms, created_at, updated_at)
        VALUES ('attempt', 'run', 'impl', 'implementer', 'codex', '{}', 'stopped', '{}', 1, ?, ?)`)
        .run(new Date(clock).toISOString(), new Date(clock).toISOString());
      db.prepare("INSERT INTO team_attempt_finalizations (attempt_id, progress_json) VALUES ('attempt', ?)")
        .run(JSON.stringify({ completed: [] }));
    }
  };

  it.each(["finalization", "repair"])("does not publish while %s is pending", async kind => {
    recovering(kind);
    await delivery().sweep();
    expect(calls).toEqual([]);
    expect(readPullRequest(db, "run")).toBeNull();
  });

  it.each(["finalization", "repair"])("does not merge an existing PR while %s is pending", async kind => {
    const service = delivery();
    await service.sweep();
    calls = [];
    recovering(kind);
    expect(await service.merge("run")).toMatchObject({ status: "refused", code: "merge_not_ready" });
    expect(calls).toEqual([]);
    expect(readPullRequest(db, "run")!.state).toBe("open");
  });

});
