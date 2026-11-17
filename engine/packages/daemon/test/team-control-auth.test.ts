import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TeamControlOptions } from "../src/routes/team-control.js";
import { createDb } from "../src/db/connection.js";
import { initializeDatabase } from "../src/db/baseline.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { PlanGovernance, hashBinding } from "../src/domain/plan-governance.js";
import { createTestApp } from "./helpers/test-app.js";
import type { PlanBinding } from "../src/contracts/team-control.js";

const binding: PlanBinding = {
  artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
  planRef: "docs/plan.md", planDigest: `sha256:${"a".repeat(64)}`,
  repository: { root: "/workspace/project", identity: `git:${"b".repeat(40)}` },
  readPaths: ["src"], writePaths: ["src"], roles: ["lead", "implementer", "reviewer"],
  policyRevision: 1, policyFingerprint: `sha256:${"c".repeat(64)}`,
  limits: { maxSessions: 3, maxActiveMs: 3600000, maxRetries: 1, maxReviewRounds: 2 },
};
const ownerToken = "owner-control-fixture";
const workerToken = "worker-control-fixture";
const capability = { policyRevision: binding.policyRevision, policyFingerprint: binding.policyFingerprint,
  verifiedProviders: ["claude", "codex"] as const };

describe("managed control authority on the shared application", () => {
  let db: Database.Database;
  let queue: QueueRepository;
  let governance: PlanGovernance;
  let app: ReturnType<typeof createTestApp>["app"];
  let key: number;
  let options: TeamControlOptions;
  beforeEach(() => {
    db = createDb(); initializeDatabase(db);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('managed-rig', 'managed')").run();
    const bus = new EventBus(db);
    queue = new QueueRepository(db, bus);
    governance = new PlanGovernance(db, bus, queue, undefined, () => capability);
    governance.createRun({ id: "run", rigId: "managed-rig", binding });
    options = { credentials: { ownerToken, workers: [{ token: workerToken, sessionId: "worker-session", runId: "run" }] },
      resolveBinding: () => binding, readPolicyCapability: () => capability };
    app = createTestApp(db, { appDeps: {
      queueRepo: queue, eventBus: bus, legacyBearerToken: "legacy-control-fixture",
      terminalBearerToken: "terminal-control-fixture", teamControl: options,
    } }).app;
    key = 0;
  });
  afterEach(() => { vi.unstubAllEnvs(); db.close(); });

  const command = (payload: unknown, actionId = "approval") => ({
    protocolVersion: "1.0", runId: "run", actionId, expectedEntityVersion: governance.getRun("run").entityVersion,
    idempotencyKey: `key-${++key}`, payload,
  });
  const request = (path: string, body?: unknown, token = ownerToken, headers: Record<string, string> = {}, peer = "127.0.0.1") =>
    app.request(`http://localhost${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Host: "localhost", Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, { incoming: { socket: { remoteAddress: peer } } });


  it.each(["", "unknown", "legacy-control-fixture", "terminal-control-fixture"])("does not treat %j as an owner credential", async (token) => {
    expect((await request("/api/team-control/runs/run", undefined, token)).status).toBe(401);
  });

  it.each([{ Origin: "http://localhost" }, { Cookie: "owner=claimed" }, { "Sec-Fetch-Site": "same-origin" }])(
    "does not turn browser credentials into owner authority: %j", async (headers) => {
      expect((await request("/api/team-control/runs/run/cancel", command({ reason: "Stop requested", owner: true }), ownerToken, headers)).status).toBe(403);
      expect(governance.getRun("run").state).toBe("pending");
    });

  it("checks the socket peer rather than forwarded headers or the Host", async () => {
    expect((await request("/api/team-control/runs/run", undefined, ownerToken,
      { "X-Forwarded-For": "127.0.0.1" }, "192.0.2.1")).status).toBe(403);
  });

  it("closes legacy WebSocket and read-with-side-effect paths as well", async () => {
    expect((await request("/api/terminal/ws?token=terminal-control-fixture")).status).toBe(403);
    expect((await request("/api/terminal/open")).status).toBe(403);
  });


  it("never carries the terminal bearer token into a served page", async () => {
    const dir = mkdtempSync(join(tmpdir(), "team-control-ui-"));
    const localDb = createDb(); initializeDatabase(localDb);
    try {
      mkdirSync(join(dir, "assets"));
      writeFileSync(join(dir, "index.html"), "<html><head></head><body>Legacy administration</body></html>");
      writeFileSync(join(dir, "assets", "app.js"), "legacyAdministration();");
      const bus = new EventBus(localDb);
      const localApp = createTestApp(localDb, { appDeps: {
        queueRepo: new QueueRepository(localDb, bus), eventBus: bus, webUiEnabled: true, uiDistDir: dir,
        terminalBearerToken: "legacy-page-secret",
      } }).app;
      for (const path of ["/", "/index.html", "/assets/app.js"]) {
        const response = await localApp.request(path);
        const body = await response.text();
        // This bare database carries no run authority, so the team bundle is served as it
        // always was — and no page body carries a terminal token into the browser.
        expect(response.status, path).toBe(200);
        expect(body, path).not.toContain("legacy-page-secret");
      }
    } finally { localDb.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("accepts dedicated owner authentication on an actual loopback socket", async () => {
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    try {
      if (!server.listening) await new Promise<void>(resolve => server.once("listening", resolve));
      const port = (server.address() as AddressInfo).port;
      const response = await fetch(`http://127.0.0.1:${port}/api/team-control/runs/run`,
        { headers: { Authorization: `Bearer ${ownerToken}` } });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ run: expect.objectContaining({ id: "run" }) });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("rejects an incompatible read protocol, query token and absent socket identity", async () => {
    expect((await request("/api/team-control/runs/run", undefined, ownerToken, { "X-Team-Control-Version": "2.0" })).status).toBe(400);
    expect((await request(`/api/team-control/runs/run?token=${ownerToken}`, undefined, "")).status).toBe(401);
    expect((await app.request("http://localhost/api/team-control/runs/run",
      { headers: { Authorization: `Bearer ${ownerToken}` } })).status).toBe(403);
  });

  it("fails closed when credentials are absent, revoked or shared across roles", async () => {
    options.credentials.ownerToken = null;
    expect((await request("/api/team-control/runs/run")).status).toBe(401);
    options.credentials.ownerToken = workerToken;
    expect((await request("/api/team-control/runs/run", undefined, workerToken)).status).toBe(503);
    options.credentials.ownerToken = "legacy-control-fixture";
    expect((await request("/api/team-control/runs/run", undefined, "legacy-control-fixture")).status).toBe(503);
  });

  it("keeps cancellation owner-only and reports intent rather than a stopped outcome", async () => {
    const cancel = command({ reason: "Stop requested", owner: true });
    expect((await request("/api/team-control/runs/run/cancel", cancel, workerToken)).status).toBe(403);
    const response = await request("/api/team-control/runs/run/cancel", cancel);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: "pending-execution", effectMayStart: false });
    expect(governance.getRun("run").state).toBe("cancel_requested");
  });

  it("refuses direct queue writes without a control grant", async () => {
    await expect(queue.create({ sourceSession: "lead@managed", destinationSession: "worker@managed", body: "unapproved", nudge: false }))
      .rejects.toThrow(/managed/i);
    expect(db.prepare("SELECT count(*) AS count FROM queue_items").get()).toEqual({ count: 0 });
  });
});
