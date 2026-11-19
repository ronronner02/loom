import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import Database from "better-sqlite3";
import { resolveDaemonDbPath } from "../src/daemon-db-path.js";
import { symlinkRefusal } from "./helpers/symlink.js";

/** A home path spelled the way this host spells paths; the answer carries the same spelling. */
const homeNamed = (...segments: string[]): string => join("/", "scratch", ...segments);
const dbUnder = (home: string): string => join(home, "loom.sqlite");

describe("resolveDaemonDbPath — D15: db derives from LOOM_HOME, never CWD-relative", () => {
  it("derives the db under LOOM_HOME when LOOM_DB is unset — NOT a bare CWD-relative filename", () => {
    const home = homeNamed("home");
    const p = resolveDaemonDbPath(undefined, home);
    // The tonight incident: a bare 'loom.sqlite' resolved against the process
    // CWD -> could land on the SHARED fleet db. The default must be home-anchored.
    expect(p).toBe(dbUnder(home));
    expect(p).not.toBe("loom.sqlite");
    expect(isAbsolute(p)).toBe(true); // absolute, CWD-independent
  });

  it("isolates two daemons with different LOOM_HOME even from the same CWD", () => {
    expect(resolveDaemonDbPath(undefined, homeNamed("iso-a"))).toBe(dbUnder(homeNamed("iso-a")));
    expect(resolveDaemonDbPath(undefined, homeNamed("fleet"))).toBe(dbUnder(homeNamed("fleet")));
  });

  it("honors an explicit LOOM_DB path verbatim", () => {
    expect(resolveDaemonDbPath(join("/", "iso", "custom.sqlite"), homeNamed("home")))
      .toBe(join("/", "iso", "custom.sqlite"));
  });

  it("treats an empty LOOM_DB as unset (falls back to home-anchored default)", () => {
    expect(resolveDaemonDbPath("", homeNamed("home"))).toBe(dbUnder(homeNamed("home")));
  });

  it.skipIf(symlinkRefusal !== null)("fails loud when the implicit database resolves through a symlink outside resolved LOOM_HOME", () => {
    const root = mkdtempSync(join(tmpdir(), "loom-db-home-guard-"));
    const home = join(root, "home");
    const outsideDb = join(root, "shared.sqlite");
    try {
      // The home-local filename is only lexical: following it reaches shared state.
      // An ambient implicit path must never gain that authority.
      mkdirSync(home);
      writeFileSync(outsideDb, "shared fleet sentinel");
      symlinkSync(outsideDb, join(home, "loom.sqlite"));
      let message = "";
      try {
        resolveDaemonDbPath(undefined, home);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toMatch(/outside|escape|LOOM_HOME/i);
      // The daemon canonicalises with the OS's long spelling; plain `realpathSync` can answer
      // with the 8.3 short form of the same directory on Windows.
      expect(message).toContain(realpathSync.native(home));
      expect(message).toContain(realpathSync.native(outsideDb));
      expect(readFileSync(outsideDb, "utf-8")).toBe("shared fleet sentinel");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps an explicit outside LOOM_DB as the deliberate split-path override", () => {
    const root = mkdtempSync(join(tmpdir(), "loom-db-explicit-"));
    const home = join(root, "home");
    const explicitDb = join(root, "shared", "fleet.sqlite");
    try {
      mkdirSync(home);
      mkdirSync(join(root, "shared"));
      const resolved = resolveDaemonDbPath(explicitDb, home);
      const db = new Database(resolved);
      db.exec("CREATE TABLE effect_evidence (value TEXT NOT NULL); INSERT INTO effect_evidence VALUES ('split path used')");
      db.close();

      expect(resolved).toBe(explicitDb);
      expect(existsSync(explicitDb)).toBe(true);
      const verify = new Database(explicitDb, { readonly: true });
      expect(verify.prepare("SELECT value FROM effect_evidence").pluck().get()).toBe("split path used");
      verify.close();
      expect(existsSync(join(home, "loom.sqlite"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not reinterpret a non-directory path component as a missing tail", () => {
    const root = mkdtempSync(join(tmpdir(), "loom-db-nondir-"));
    const notAHome = join(root, "not-a-directory");
    try {
      writeFileSync(notAHome, "not a directory");
      expect(() => resolveDaemonDbPath(undefined, notAHome)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
