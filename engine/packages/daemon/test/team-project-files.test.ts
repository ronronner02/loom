import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixDaemonMode } from "../src/domain/plan-governance.js";
import { addTeamSeats } from "../src/domain/team-setup.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

describe("existing project files", () => {
  let directory: string, repository: string, teamId: string;
  let fixture: ReturnType<typeof createTestApp>;
  beforeEach(() => {
    directory = realpathSync.native(mkdtempSync(join(tmpdir(), "project-files-")));
    repository = join(directory, "project");
    mkdirSync(join(repository, "src"), { recursive: true });
    mkdirSync(join(repository, "empty"));
    mkdirSync(join(repository, ".git"));
    writeFileSync(join(repository, "README.md"), "# Existing project\n");
    writeFileSync(join(repository, "src", "hello.ts"), 'export const hello = "Hello";\n');
    writeFileSync(join(repository, ".env"), "PRIVATE_TOKEN=fixture-only\n");
    writeFileSync(join(directory, "outside.txt"), "outside fixture\n");
    const db = createFullTestDb();
    fixDaemonMode(db, true);
    fixture = createTestApp(db, { appDeps: { teamControl: { credentials: { ownerToken: "owner-files-fixture",
      workers: [{ token: "worker-files-fixture", sessionId: "worker@fixture", runId: "other" }] } } } });
    teamId = fixture.rigRepo.createRig("existing-project", repository).id;
    addTeamSeats(db, teamId, [{ role: "lead", client: "codex" }]);
  });
  afterEach(() => { fixture.db.close(); rmSync(directory, { recursive: true, force: true }); });
  const call = (path = "", token: string | null = "owner-files-fixture", project?: string) =>
    fixture.app.request("/api/team-control/teams/" + (project ?? teamId) + "/files" + path,
      { headers: token ? { Authorization: "Bearer " + token } : {} },
      { incoming: { socket: { remoteAddress: "127.0.0.1" } } });

  it("lists an existing project's files before any run, without changing the repository", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ kind: "directory", path: "", entries: [
      { name: "empty", kind: "directory" }, { name: "README.md", kind: "file" }, { name: "src", kind: "directory" },
    ] });
    expect(fixture.db.prepare("SELECT count(*) AS count FROM team_runs").get()).toEqual({ count: 0 });
    expect(readFileSync(join(repository, "README.md"), "utf8")).toBe("# Existing project\n");
  });

  it("reads nested text and reports an empty directory as empty", async () => {
    const response = await call("?path=src%2Fhello.ts");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: "file", path: "src/hello.ts", content: 'export const hello = "Hello";\n' });
    expect(await (await call("?path=empty")).json()).toMatchObject({ kind: "directory", entries: [] });
  });

  it("requires the owner and rejects unknown projects, extra query fields and protected paths", async () => {
    expect((await call("", null)).status).toBe(401);
    expect((await call("", "worker-files-fixture")).status).toBe(403);
    expect((await call("", "owner-files-fixture", "missing-project")).status).toBe(404);
    for (const query of ["?root=/", "?path=..%2Foutside.txt", "?path=.env", "?path=.git", "?path=missing.txt"]) {
      const response = await call(query);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("fixture-only");
    }
  });

  it("keeps symlinks and unsupported binary or oversized previews out of the reader", async () => {
    symlinkSync(directory, join(repository, "outside"), "junction");
    writeFileSync(join(repository, "image.bin"), Buffer.from([0, 1, 2]));
    writeFileSync(join(repository, "large.txt"), "x".repeat(262145));
    for (const path of ["outside/outside.txt", "image.bin", "large.txt"]) {
      expect((await call("?path=" + encodeURIComponent(path))).status).toBe(404);
    }
    const response = await call();
    expect(response.status).toBe(200);
    expect((await response.json() as { entries: { name: string }[] }).entries.some(entry => entry.name === "outside")).toBe(false);
  });
});
