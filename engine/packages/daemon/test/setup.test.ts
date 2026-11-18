import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { initializeDatabase } from "../src/db/baseline.js";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";
import { OwnerSessions } from "../src/domain/owner-session.js";
import type { Resolution } from "../src/domain/executable-resolver.js";
import type { SignInProbe } from "../src/domain/agent-sign-in.js";
import { createTestApp } from "./helpers/test-app.js";
import { setupRoutes } from "../src/routes/setup.js";

/**
 * First-run setup: the owner reads the tools, the agent sign-in and the proxy the daemon just
 * observed, and saves the two settings the screen owns. Everything here is owner-only, because
 * the setup screen comes before GitHub sign-in and has no other credential to rely on.
 *
 * The host questions are injected, so the read's shape is the same on a runner with no client
 * installed and on one with every client installed.
 */

const found = (client: Resolution["client"], path = "C:\\fixture\\" + client + ".exe"): Resolution =>
  ({ ok: true, client, path, source: "path" });
const missing = (client: Resolution["client"]): Resolution =>
  ({ ok: false, client, reason: "not-found", tried: [] });
/** Every dependency present, and every client answering like an installed one. */
const allInstalled: Resolution[] = [found("claude"), found("codex"),
  { ok: true, client: "gemini", path: process.execPath, args: ["C:\\fixture\\gemini.js"], source: "shim" },
  found("git"), found("gh")];
const probeFor = (state: SignInProbe["state"]): SignInProbe["state"] => state;
const signInAnswers: Record<string, SignInProbe> = {
  claude: { client: "claude", state: probeFor("signed-in"), signIn: null },
  codex: { client: "codex", state: probeFor("signed-out"), signIn: "codex login" },
  gemini: { client: "gemini", state: probeFor("unknown"), signIn: "gemini" },
};

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

  /** The setup read with its two host questions answered by the fixture above. */
  const readWith = (resolutions: Resolution[], probe: (client: SignInProbe["client"], executable: string) => SignInProbe) => {
    const credentials = { ownerToken };
    const route = setupRoutes(store, credentials, [], {
      resolveClients: () => resolutions,
      probeSignIn: async (client, executable) => { expect(executable.length).toBeGreaterThan(0); return probe(client, executable); },
    });
    return async (method = "GET", body?: unknown) => route.request("/setup", { method,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + ownerToken },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
  };

  it("reports every tool, the agent sign-in and the proxy on one owner read", async () => {
    const requestWithFixture = readWith(allInstalled, client => signInAnswers[client]!);
    const response = await requestWithFixture();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(body.tools.map((row: { client: string }) => row.client)).toEqual(["claude", "codex", "gemini", "git", "gh"]);
    for (const row of body.tools) expect(row.ok, row.client).toBe(true);
    // A client that runs through Node reports the entry the owner installed, not the runner.
    expect(body.tools.find((row: { client: string }) => row.client === "gemini").path).toBe("C:\\fixture\\gemini.js");
    expect(body.proxy).toBe("");
    expect(body.complete).toBe(false);
    // Each installed client is asked, and each answer is carried through unchanged.
    expect(body.signIn).toEqual([
      { client: "claude", state: "signed-in", signIn: null },
      { client: "codex", state: "signed-out", signIn: "codex login" },
      // Gemini has no status subcommand, so its answer is the screen's honest one: unknown.
      { client: "gemini", state: "unknown", signIn: "gemini" },
    ]);
    // A signed-in client offers no command; one that is not offers exactly one.
    for (const row of body.signIn) {
      if (row.state === "signed-in") expect(row.signIn).toBeNull();
      else expect(row.signIn).toMatch(/^(claude auth login|codex login|gemini)$/);
    }
  });

  it("reports every tool as missing and omits the sign-in rows when nothing is installed", async () => {
    const requestWithFixture = readWith(allInstalled.map(resolution => missing(resolution.client)),
      () => { throw new Error("no installed client should be probed"); });
    const body = await (await requestWithFixture()).json();
    // The tools block names all five and each one's reason, so the screen still says what to do.
    expect(body.tools).toEqual(["claude", "codex", "gemini", "git", "gh"]
      .map(client => ({ client, ok: false, reason: "not-found" })));
    // No client is installed, so there is nothing to sign in to: no rows, not rows saying so.
    expect(body.signIn).toEqual([]);
  });

  it("never probes a client the resolver did not find", async () => {
    // The installed set is the probe set: a missing client contributes a tools row and nothing else.
    const probed: string[] = [];
    const resolutions = [missing("claude"), found("codex"), missing("gemini"), found("git"), found("gh")];
    const requestWithFixture = readWith(resolutions, client => { probed.push(client); return signInAnswers[client]!; });
    const body = await (await requestWithFixture()).json();
    expect(probed).toEqual(["codex"]);
    expect(body.signIn).toEqual([signInAnswers.codex]);
  });

  it("re-checks the tools on every read, so a new install shows up", async () => {
    let installed: Resolution[] = [missing("gemini"), found("git")];
    const credentials = { ownerToken };
    const route = setupRoutes(store, credentials, [], { resolveClients: () => installed,
      probeSignIn: async client => signInAnswers[client]! });
    const read = () => route.request("/setup", { headers: { Authorization: "Bearer " + ownerToken } },
      { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
    expect((await (await read()).json()).tools.find((row: { client: string }) => row.client === "gemini").ok).toBe(false);
    installed = [found("gemini"), found("git")];
    const after = await (await read()).json();
    expect(after.tools.find((row: { client: string }) => row.client === "gemini").ok).toBe(true);
    expect(after.signIn.map((row: { client: string }) => row.client)).toEqual(["gemini"]);
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