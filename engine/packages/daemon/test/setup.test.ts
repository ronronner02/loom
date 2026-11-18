import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { initializeDatabase } from "../src/db/baseline.js";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";
import { OwnerSessions } from "../src/domain/owner-session.js";
import { createTestApp } from "./helpers/test-app.js";

/**
 * First-run setup: the owner reads the tools, the agent sign-in and the proxy the daemon just
 * observed, and saves the two settings the screen owns. Everything here is owner-only, because
 * the setup screen comes before GitHub sign-in and has no other credential to rely on.
 */
describe("owner setup read", () => {
  let directory: string, db: Database.Database, store: SettingsStore;
  let app: ReturnType<typeof createTestApp>["app"];
  const ownerToken = "owner-setup-fixture";
  const request = (method = "GET", body?: unknown, token: string | null = ownerToken, peer = "127.0.0.1") =>
    app.request("/api/team-control/setup", { method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, { incoming: { socket: { remoteAddress: peer } } });

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "team-setup-"));
    store = new SettingsStore(join(directory, "config.json"));
    store.set("daemon.port", "7433");
    db = createDb(); initializeDatabase(db);
    app = createTestApp(db, { appDeps: { settingsStore: store, ownerSessions: new OwnerSessions(db),
      teamControl: { credentials: { ownerToken, workers: [
        { token: "worker-setup-fixture", sessionId: "dev@fixture", runId: "other" },
      ] } },
    } }).app;
  });
  afterEach(() => { if (db?.open) db.close(); rmSync(directory, { recursive: true, force: true }); });

  it("reports every tool, the agent sign-in and the proxy on one owner read", async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(body.tools.map((row: { client: string }) => row.client)).toEqual(["claude", "codex", "gemini", "git", "gh"]);
    for (const row of body.tools) expect(typeof row.ok, row.client).toBe("boolean");
    expect(body.proxy).toBe("");
    expect(body.complete).toBe(false);
    // A client the resolver found is probed; one it did not is never reported as signed out.
    for (const row of body.signIn) {
      expect(["claude", "codex", "gemini"]).toContain(row.client);
      expect(["signed-in", "signed-out", "unknown"]).toContain(row.state);
      if (row.state === "signed-in") expect(row.signIn).toBeNull();
      else expect(row.signIn).toMatch(/^(claude auth login|codex login|gemini)$/);
    }
    // Gemini has no status subcommand, so its answer is the screen's honest one: unknown.
    expect(body.signIn.find((row: { client: string }) => row.client === "gemini") ?? { state: "unknown" })
      .toMatchObject({ state: "unknown", signIn: "gemini" });
  });

  it("saves and clears the one proxy, and refuses a value that is not an http(s) URL", async () => {
    const saved = await request("PUT", { proxy: "http://proxy.test:8080" });
    expect(saved.status).toBe(200);
    expect((await saved.json()).proxy).toBe("http://proxy.test:8080");
    expect(store.resolveOne("network.proxy").value).toBe("http://proxy.test:8080");

    const refused = await request("PUT", { proxy: "socks5://proxy.test:1080" });
    expect(refused.status).toBe(400);
    expect((await refused.json()).code).toBe("invalid_network_proxy");
    expect(store.resolveOne("network.proxy").value).toBe("http://proxy.test:8080");

    const cleared = await request("PUT", { proxy: "" });
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).proxy).toBe("");
    expect(store.resolveOne("network.proxy").source).toBe("default");
  });

  it("records setup complete and leaves it set", async () => {
    expect((await (await request("PUT", { complete: true })).json()).complete).toBe(true);
    expect((await (await request()).json()).complete).toBe(true);
    expect(new SettingsStore(store.configPath).resolveOne("ui.setup_complete").value).toBe(true);
  });

  it("rejects a field outside the screen's two settings without touching the file", async () => {
    const before = readFileSync(store.configPath, "utf8");
    for (const body of [{ key: "network.proxy", value: "x" }, { complete: "yes" }]) {
      expect((await request("PUT", body)).status).toBe(400);
    }
    expect(readFileSync(store.configPath, "utf8")).toBe(before);
  });

  it("denies worker, unpaired and non-loopback access", async () => {
    for (const method of ["GET", "PUT"]) {
      const body = method === "PUT" ? { proxy: "http://proxy.test:8080" } : undefined;
      expect((await request(method, body, "worker-setup-fixture")).status).toBe(403);
      expect((await request(method, body, null)).status).toBe(401);
      expect((await request(method, body, ownerToken, "203.0.113.9")).status).toBe(403);
    }
    expect(store.resolveOne("network.proxy").value).toBe("");
  });
});