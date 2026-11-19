import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

const UI_INDEX_HTML = "<!doctype html><html><body><div id=\"root\">Loom UI</div></body></html>";

function createTempUiDist(): string {
  const dir = mkdtempSync(join(tmpdir(), "u22-ui-dist-"));
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), UI_INDEX_HTML, "utf8");
  writeFileSync(join(dir, "assets", "app.js"), "console.log('loom');", "utf8");
  return dir;
}

function appWithUi(db: ReturnType<typeof createFullTestDb>, uiDistDir: string) {
  return createTestApp(db, { appDeps: { uiDistDir, webUiEnabled: true } }).app;
}

describe("Hono server (production app)", () => {
  it("GET /healthz returns 200 with status ok", async () => {
    const db = createFullTestDb();
    try {
      const { app } = createTestApp(db);
      const res = await app.request("/healthz");
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: "ok", pid: process.pid });
    } finally {
      db.close();
    }
  });

  it("GET /healthz publishes no self-host identity: this daemon has none to resolve", async () => {
    // The field was only ever written by a boot reconcile that no longer exists, so it is
    // always absent. A reader that waited for it (the CLI's locality probe, the queue's
    // host-qualified sender) failed open forever; the field and its readers are gone.
    const db = createFullTestDb();
    try {
      const { app } = createTestApp(db);
      const body = await (await app.request("/healthz")).json() as Record<string, unknown>;
      expect(body).not.toHaveProperty("selfHostId");
      expect(body).not.toHaveProperty("selfHostIdSource");
    } finally {
      db.close();
    }
  });

  it("unknown API routes return the JSON 404 contract for every method", async () => {
    const db = createFullTestDb();
    const uiDistDir = createTempUiDist();
    try {
      const app = appWithUi(db, uiDistDir);
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) {
        for (const requestPath of ["/api/unknown", "/api/unknown/deep"]) {
          const res = await app.request(requestPath, { method });
          expect(res.status, `${method} ${requestPath}`).toBe(404);
          expect(res.headers.get("content-type"), `${method} ${requestPath}`).toContain("application/json");
          const text = await res.text();
          expect(text).not.toContain("Loom UI");
          if (method === "HEAD") expect(text).toBe("");
          else expect(JSON.parse(text)).toEqual({ error: "not_found", path: requestPath });
        }
      }
    } finally {
      rmSync(uiDistDir, { recursive: true, force: true });
      db.close();
    }
  });

  it("serves index.html for root and SPA deep links when a UI bundle exists", async () => {
    const db = createFullTestDb();
    const uiDistDir = createTempUiDist();
    try {
      const app = appWithUi(db, uiDistDir);
      for (const requestPath of ["/", "/team", "/team/tasks", "/api", "/apiX", "/healthz-adjacent"]) {
        const res = await app.request(requestPath);
        expect(res.status, requestPath).toBe(200);
        expect(res.headers.get("content-type"), requestPath).toContain("text/html");
        expect(await res.text(), requestPath).toBe(UI_INDEX_HTML);
      }
    } finally {
      rmSync(uiDistDir, { recursive: true, force: true });
      db.close();
    }
  });

  it("serves built assets directly when a UI bundle exists", async () => {
    const db = createFullTestDb();
    const uiDistDir = createTempUiDist();
    try {
      const app = appWithUi(db, uiDistDir);
      const res = await app.request("/assets/app.js");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/javascript");
      expect(await res.text()).toContain("console.log('loom');");
    } finally {
      rmSync(uiDistDir, { recursive: true, force: true });
      db.close();
    }
  });

  it("serves character assets with their own content types", async () => {
    const db = createFullTestDb();
    const uiDistDir = createTempUiDist();
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const webm = Buffer.from("1a45dfa3", "hex");
    const assets = [
      ["avatars/vendors/chatgpt_master.webm", webm, "video/webm"],
      ["avatars/pomo/master.png", png, "image/png"],
    ] as const;
    try {
      for (const [file, body] of assets) {
        mkdirSync(join(uiDistDir, file, ".."), { recursive: true });
        writeFileSync(join(uiDistDir, file), body);
      }
      const app = appWithUi(db, uiDistDir);
      for (const [file, body, type] of assets) {
        const response = await app.request(`/${file}`);
        expect(response.status, file).toBe(200);
        expect(response.headers.get("content-type"), file).toBe(type);
        expect(Buffer.from(await response.arrayBuffer()), file).toEqual(body);
      }
      expect((await app.request("/avatars/vendors/missing.webm")).status).toBe(404);
      // A run-carrying database serves only the team pages, never the bundle's index.
      db.prepare("INSERT INTO rigs (id, name) VALUES ('managed', 'managed')").run();
      db.prepare(`INSERT INTO team_runs (id, rig_id, binding_json, binding_digest, state, created_at, updated_at)
        VALUES ('managed', 'managed', '{}', 'digest', 'approved', '2026-11-09', '2026-11-09')`).run();
      expect((await app.request("/index.html")).status).toBe(404);
    } finally {
      rmSync(uiDistDir, { recursive: true, force: true });
      db.close();
    }
  });
});
