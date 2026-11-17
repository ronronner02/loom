import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createDb } from "../src/db/connection.js";
import { initializeDatabase } from "../src/db/baseline.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { rigMemberExists } from "../src/domain/workflow-role-context.js";

// The structural member probe: does a rig have a member that derives the canonical
// coordinate a target names? Existence at any lifecycle state and node kind, so a
// declared-but-not-yet-launched seat and a terminal member both count.
describe("rigMemberExists: the structural member probe", () => {
  function seeded() {
    const db = createDb();
    initializeDatabase(db);
    const rigRepo = new RigRepository(db);
    const rig = rigRepo.createRig("acme-build");
    for (const [logicalId, runtime] of [["dev.builder1", "claude-code"], ["dev.cold1", "claude-code"], ["ops.term1", "terminal"]] as const) {
      rigRepo.addNode(rig.id, logicalId, { runtime, cwd: "/tmp" });
    }
    // Only builder1 gets a session; cold1 and term1 exist as declarations only.
    const node = db.prepare("SELECT id FROM nodes WHERE logical_id = 'dev.builder1'").get() as { id: string };
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s-0001', ?, 'dev-builder1@acme-build', 'running')").run(node.id);
    return { db, bus: new EventBus(db) };
  }

  it("true for real, cold and terminal members; false for a typo member or an unknown rig", () => {
    const { db } = seeded();
    try {
      expect(rigMemberExists(db, "acme-build", "dev-builder1@acme-build")).toBe(true);
      expect(rigMemberExists(db, "acme-build", "dev-cold1@acme-build")).toBe(true);
      expect(rigMemberExists(db, "acme-build", "ops-term1@acme-build")).toBe(true);
      expect(rigMemberExists(db, "acme-build", "dev-typo1@acme-build")).toBe(false);
      expect(rigMemberExists(db, "ghost-rig", "dev-x@ghost-rig")).toBe(false);
      // The compare is the DERIVED canonical coordinate: a raw string that is not a
      // coordinate of any member misses even when a session by that name might exist.
      expect(rigMemberExists(db, "acme-build", "not-a-coordinate")).toBe(false);
    } finally { db.close(); }
  });

  it("a seat-read failure throws, so the caller can treat it as cannot-vouch", () => {
    const { db } = seeded();
    try {
      db.exec("DROP TABLE sessions");
      expect(() => rigMemberExists(db, "acme-build", "dev-typo1@acme-build")).toThrow();
    } finally { db.close(); }
  });

  it("purity: sync SQL only — no async/await, no clock, no randomness, no tmux", () => {
    const source = readFileSync(new URL("../src/domain/workflow-role-context.ts", import.meta.url), "utf-8");
    const start = source.indexOf("export function rigMemberExists");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\n}", start);
    const body = source.slice(start, end);
    expect(body).not.toMatch(/\basync\b|\bawait\b/);
    expect(body).not.toMatch(/Date\.now|new Date|setTimeout|setInterval/);
    expect(body).not.toMatch(/Math\.random/);
    expect(body).not.toMatch(/tmux|attachAgentActivity|SeatActivityService/);
  });
});