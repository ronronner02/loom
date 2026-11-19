import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASELINE_VERSION, initializeDatabase, LegacyDatabaseError, NewerDatabaseError, UpgradeFailedError } from "../src/db/baseline.js";
import { openDatabase } from "../src/db/connection.js";
import { SCHEMA_UPGRADES, type SchemaUpgrade } from "../src/db/upgrades.js";

/**
 * A database the shipped app created must open on every later daemon. A schema change is a
 * baseline edit plus one additive upgrade step, so a user's data is carried forward instead of
 * being refused as `legacy_database`.
 */

const roots: string[] = [];
const connections: Database.Database[] = [];
const directory = () => { const root = mkdtempSync(join(tmpdir(), "team-upgrade-")); roots.push(root); return root; };
const track = (db: Database.Database) => { connections.push(db); return db; };
const schema = (db: Database.Database) => db.prepare(
  "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name",
).all();
const fileHash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** A database marked one version below the daemon, holding a row the upgrade must keep. */
function previousVersion(file: string): Database.Database {
  const db = track(new Database(file));
  db.pragma("journal_mode = WAL");
  initializeDatabase(db, file);
  db.exec("INSERT INTO rigs (id, name) VALUES ('team', 'Project')");
  db.exec("DROP TABLE team_soul_versions");
  db.pragma(`user_version = ${BASELINE_VERSION - 1}`);
  return db;
}

/** The step that brings `previousVersion` back to today's schema. */
function restoreSouls(db: Database.Database): SchemaUpgrade {
  const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'team_soul_versions'").get() as { sql?: string } | undefined)?.sql;
  const fresh = track(new Database(":memory:"));
  initializeDatabase(fresh);
  const table = (fresh.prepare("SELECT sql FROM sqlite_master WHERE name = 'team_soul_versions'").get() as { sql: string }).sql;
  const indexes = (fresh.prepare("SELECT sql FROM sqlite_master WHERE tbl_name = 'team_soul_versions' AND type = 'index' AND sql IS NOT NULL").all() as { sql: string }[])
    .map(row => row.sql);
  expect(sql).toBeUndefined();
  return { from: BASELINE_VERSION - 1, to: BASELINE_VERSION, sql: [table, ...indexes].join(";\n") };
}

afterEach(() => {
  for (const db of connections.splice(0)) if (db.open) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("schema upgrades from a shipped baseline", () => {
  it("upgrades an older marked database in place, keeps its rows and leaves a backup beside it", () => {
    const root = directory(), file = join(root, "loom.sqlite");
    const db = previousVersion(file);
    const step = restoreSouls(db);
    initializeDatabase(db, file, { upgrades: [step] });
    expect(db.pragma("user_version", { simple: true })).toBe(BASELINE_VERSION);
    expect(db.prepare("SELECT id, name FROM rigs").all()).toEqual([{ id: "team", name: "Project" }]);
    const fresh = track(new Database(":memory:")); initializeDatabase(fresh);
    expect(schema(db)).toEqual(schema(fresh));
    const backups = readdirSync(root).filter(name => name.endsWith(".bak"));
    expect(backups).toHaveLength(1);
    const backup = track(new Database(join(root, backups[0]!), { readonly: true }));
    expect(backup.pragma("user_version", { simple: true })).toBe(BASELINE_VERSION - 1);
    expect(backup.prepare("SELECT id FROM rigs").all()).toEqual([{ id: "team" }]);
  });

  it("leaves the older version intact and names the backup when a step fails", () => {
    const root = directory(), file = join(root, "loom.sqlite");
    const db = previousVersion(file);
    const step = restoreSouls(db);
    let caught: unknown;
    try {
      initializeDatabase(db, file, { upgrades: [step], injectFailure: () => { throw new Error("injected upgrade failure"); } });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(UpgradeFailedError);
    const failure = caught as UpgradeFailedError;
    expect(failure.code).toBe("upgrade_failed");
    expect(existsSync(failure.backupPath)).toBe(true);
    expect(db.pragma("user_version", { simple: true })).toBe(BASELINE_VERSION - 1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'team_soul_versions'").all()).toEqual([]);
    expect(db.prepare("SELECT id FROM rigs").all()).toEqual([{ id: "team" }]);
  });

  it("refuses a database from a newer daemon without changing its bytes", () => {
    const file = join(directory(), "loom.sqlite");
    const newer = new Database(file);
    newer.exec("CREATE TABLE rigs (id TEXT PRIMARY KEY)");
    newer.pragma(`user_version = ${BASELINE_VERSION + 1}`);
    newer.close();
    const before = fileHash(file);
    expect(() => openDatabase(file)).toThrow(NewerDatabaseError);
    expect(() => openDatabase(file)).toThrow(`newer_database: version ${BASELINE_VERSION + 1}`);
    expect(fileHash(file)).toBe(before);
  });

  it("still refuses an older version no upgrade step reaches", () => {
    const file = join(directory(), "loom.sqlite");
    const old = track(new Database(file));
    old.exec("CREATE TABLE rigs (id TEXT PRIMARY KEY)");
    old.pragma(`user_version = ${BASELINE_VERSION - 1}`);
    expect(() => initializeDatabase(old, file, { upgrades: [] })).toThrow(LegacyDatabaseError);
  });

  it("upgrades a v0.1.0-shaped database (schema 9), drops the dead tables and keeps live data", () => {
    // v0.1.0 shipped at schema 9. A database from it holds rows in tables this baseline no
    // longer creates, and the upgrade must drop those tables while every row a live path
    // reads or writes survives.
    const shipped = readFileSync(new URL("./fixtures/schema-v2.sql", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const db = track(new Database(":memory:"));
    db.exec(shipped);
    db.pragma("user_version = 2");
    // Walk the shipped chain to schema 9 — the version v0.1.0 shipped — so this is a real v9
    // database rather than a v2 one wearing a v9 marker.
    for (const step of SCHEMA_UPGRADES.filter(step => step.from >= 2 && step.to <= 9)) {
      db.exec(step.sql);
      db.pragma(`user_version = ${step.to}`);
    }
    expect(db.pragma("user_version", { simple: true })).toBe(9);
    db.exec("INSERT INTO rigs (id, name) VALUES ('team', 'Project')");
    db.exec("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n1', 'team', 'dev.worker')");
    db.exec("INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s1', 'n1', 'dev-worker@team', 'running')");
    db.exec("INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body) VALUES ('q1', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', 'a@team', 'dev-worker@team', 'pending', 'work')");
    db.exec("INSERT INTO events (rig_id, node_id, type, payload) VALUES ('team', 'n1', 'node.ready', '{}')");
    // A row in a table this baseline drops: the upgrade removes the table with it.
    db.exec("INSERT INTO watchdog_jobs (job_id, policy, spec_yaml, target_session, interval_seconds, registered_by_session, registered_at, state) VALUES ('job1', 'periodic-reminder', '', 'dev-worker@team', 60, 'peer@team', '2026-11-01T00:00:00.000Z', 'active')");

    initializeDatabase(db, ":memory:", { upgrades: SCHEMA_UPGRADES });

    expect(db.pragma("user_version", { simple: true })).toBe(BASELINE_VERSION);
    for (const dropped of ["watchdog_jobs", "views_custom", "classifier_leases", "context_usage",
      "inbox_entries", "outbox_entries", "workflow_instances", "workflow_specs", "queue_transition_wakes"]) {
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(dropped), dropped).toBeUndefined();
    }
    // The live rows are intact, and the upgraded schema matches a fresh install exactly.
    expect(db.prepare("SELECT id, name FROM rigs").all()).toEqual([{ id: "team", name: "Project" }]);
    expect(db.prepare("SELECT qitem_id, body FROM queue_items").all()).toEqual([{ qitem_id: "q1", body: "work" }]);
    expect(db.prepare("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 1 });
    const fresh = track(new Database(":memory:")); initializeDatabase(fresh);
    expect(schema(db)).toEqual(schema(fresh));
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("upgrades a Gemini-era database (schema 12, rebuilt team_attempts) and keeps a gemini attempt", () => {
    // The installed app was built from a branch that shipped schema 12: it rebuilt team_attempts
    // and team_bootstraps so the provider and lead-client checks admit "gemini". A database from
    // it upgrades to today's baseline and a row written under that schema survives unchanged.
    const shipped = readFileSync(new URL("./fixtures/schema-v2.sql", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const db = track(new Database(":memory:"));
    db.exec(shipped);
    db.pragma("user_version = 2");
    for (const step of SCHEMA_UPGRADES.filter(step => step.from >= 2 && step.to <= 12)) {
      if (step.rebuildsTables) db.pragma("foreign_keys = OFF");
      db.exec(step.sql);
      db.pragma(`user_version = ${step.to}`);
      if (step.rebuildsTables) db.pragma("foreign_keys = ON");
    }
    expect(db.pragma("user_version", { simple: true })).toBe(12);
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'team_attempts'").get()).toMatchObject({
      sql: expect.stringContaining("'gemini'"),
    });

    db.exec("INSERT INTO rigs (id, name) VALUES ('team', 'Project')");
    db.exec("INSERT INTO team_runs (id, rig_id, binding_json, binding_digest, state, created_at, updated_at) VALUES ('run', 'team', '{}', 'digest', 'approved', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')");
    db.exec(`INSERT INTO team_attempts (id, run_id, role, provider, identity_json, state, usage_json, active_ms, created_at, updated_at)
      VALUES ('attempt-gemini', 'run', 'implementer', 'gemini', '{"nativeSessionId":"g1"}', 'stopped', '{"activeMs":0}', 0, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`);

    initializeDatabase(db, ":memory:", { upgrades: SCHEMA_UPGRADES });

    expect(db.pragma("user_version", { simple: true })).toBe(BASELINE_VERSION);
    expect(db.prepare("SELECT id, provider FROM team_attempts").all()).toEqual([{ id: "attempt-gemini", provider: "gemini" }]);
    const fresh = track(new Database(":memory:")); initializeDatabase(fresh);
    expect(schema(db)).toEqual(schema(fresh));
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("brings the first shipped schema to today's baseline through the recorded steps", () => {
    // The shipped schema is frozen in this fixture. Editing the baseline without adding the
    // step that carries a shipped database forward makes the two schemas differ here.
    // A Windows checkout may turn the fixture's line endings into CRLF; SQLite stores the SQL
    // text as written, so normalize it to the LF the baseline source uses.
    const shipped = readFileSync(new URL("./fixtures/schema-v2.sql", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const db = track(new Database(":memory:"));
    db.exec(shipped);
    db.pragma("user_version = 2");
    initializeDatabase(db, ":memory:", { upgrades: SCHEMA_UPGRADES });
    const fresh = track(new Database(":memory:")); initializeDatabase(fresh);
    expect(db.pragma("user_version", { simple: true })).toBe(BASELINE_VERSION);
    expect(schema(db)).toEqual(schema(fresh));
  });
});
