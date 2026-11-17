import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import {
  rigDeclaresRole,
  rigMemberExists,
  roleResolutionContext,
  tryResolveRoleByCapability,
} from "../src/domain/workflow-role-context.js";
import { selectRoleSeat, type RoleSeatCandidateFacts } from "../src/domain/workflow-role-resolver.js";

// The role policy and the seat read behind it. The policy is pure over a fact array; the
// context materializes that array from one rig's seats and their pending backlog.

function facts(over: Partial<RoleSeatCandidateFacts>): RoleSeatCandidateFacts {
  return {
    logicalId: "dev.x",
    role: "driver",
    nodeKind: "agent",
    lifecycleState: "running",
    runtime: "claude-code",
    pendingWorkCount: 0,
    coordinate: "dev-x@factory-a",
    rawSessionName: "dev-x@factory-a",
    ...over,
  };
}

describe("selectRoleSeat (pure policy)", () => {
  it("selects the qualified seat and names every decoy's disqualifier", () => {
    const result = selectRoleSeat({
      role: "driver",
      candidates: [
        facts({ logicalId: "dev.dead", coordinate: "dev-dead@f", rawSessionName: "dev-dead@f", lifecycleState: "detached" }),
        facts({ logicalId: "dev.wrongrt", coordinate: "dev-wrongrt@f", rawSessionName: "dev-wrongrt@f", runtime: "codex" }),
        facts({ logicalId: "dev.roleless", coordinate: "dev-roleless@f", rawSessionName: "dev-roleless@f", role: null }),
        facts({ logicalId: "dev.adopted", coordinate: "dev-adopted@f", rawSessionName: "my-raw-tmux" }),
        facts({ logicalId: "dev.good", coordinate: "dev-good@f", rawSessionName: "dev-good@f" }),
      ],
      harness: "claude-code",
    });
    expect(result.seat).toBe("dev-good@f");
    const byId = new Map(result.disqualified.map((d) => [d.logicalId, d.disqualifier]));
    expect(byId.get("dev.dead")).toBe("not_live(lifecycleState=detached)");
    expect(byId.get("dev.wrongrt")).toBe("runtime_mismatch(codex≠claude-code)");
    expect(byId.get("dev.roleless")).toBe("role_not_declared");
    expect(byId.get("dev.adopted")).toBe("adopted_seat_not_role_resolvable_v1");
  });

  it("least pending backlog wins; the coordinate breaks a tie by codepoint", () => {
    const result = selectRoleSeat({
      role: "driver",
      candidates: [
        facts({ logicalId: "a", coordinate: "dev-b@f", rawSessionName: "dev-b@f", pendingWorkCount: 2, runtime: "codex" }),
        facts({ logicalId: "b", coordinate: "dev-c@f", rawSessionName: "dev-c@f", pendingWorkCount: 0 }),
        facts({ logicalId: "c", coordinate: "dev-a@f", rawSessionName: "dev-a@f", pendingWorkCount: 0 }),
      ],
    });
    expect(result.seat).toBe("dev-a@f");
    expect(result.qualified.map((q) => q.coordinate)).toEqual(["dev-a@f", "dev-c@f", "dev-b@f"]);
  });

  it("returns null with the disqualified list when nothing qualifies", () => {
    const result = selectRoleSeat({ role: "qa", candidates: [facts({ role: "qa", lifecycleState: "detached" })] });
    expect(result.seat).toBeNull();
    expect(result.disqualified).toHaveLength(1);
  });

  it("infrastructure seats are out of scope entirely", () => {
    const result = selectRoleSeat({ role: "driver", candidates: [facts({ nodeKind: "infrastructure" })] });
    expect(result.seat).toBeNull();
    expect(result.disqualified).toHaveLength(0);
  });
});

describe("the seat read behind the policy", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queue: QueueRepository;
  let rigRepo: RigRepository;
  let rigId: string;
  let sessionSeq = 0;

  function seedSeat(pod: string, member: string, opts: { role?: string; runtime?: string; sessionStatus?: string | null }): string {
    const node = rigRepo.addNode(rigId, `${pod}.${member}`, {
      role: opts.role,
      runtime: opts.runtime ?? "claude-code",
      cwd: "/tmp",
    });
    const coordinate = `${pod}-${member}@factory-a`;
    if (opts.sessionStatus !== null) {
      sessionSeq += 1;
      db.prepare(`INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, ?, ?, ?)`).run(
        `s-${String(sessionSeq).padStart(4, "0")}`, node.id, coordinate, opts.sessionStatus ?? "running",
      );
    }
    return coordinate;
  }

  beforeEach(() => {
    db = createFullTestDb();
    bus = new EventBus(db);
    queue = new QueueRepository(db, bus, { validateRig: () => true });
    rigRepo = new RigRepository(db);
    rigId = rigRepo.createRig("factory-a").id;
  });

  afterEach(() => { db.close(); });

  it("resolves a live capable seat, skipping dead, wrong-runtime, role-less and loaded decoys", async () => {
    seedSeat("dev", "dead1", { role: "driver", sessionStatus: "stopped" });
    seedSeat("dev", "wrongrt", { role: "driver", runtime: "codex" });
    seedSeat("dev", "roleless", {});
    const loaded = seedSeat("dev", "driver1", { role: "driver" });
    const idle = seedSeat("dev", "driver2", { role: "driver" });
    await queue.create({ sourceSession: "orch@factory-a", destinationSession: loaded, body: "busywork" });

    const ctx = roleResolutionContext(db, "factory-a");
    expect(tryResolveRoleByCapability(ctx, "driver")).toBe(idle);
  });

  it("an unbound instance builds no context, and a vanished rig resolves to null", () => {
    expect(roleResolutionContext(db, null)).toBeUndefined();
    const ctx = roleResolutionContext(db, "ghost-rig");
    expect(ctx?.candidatesForRig()).toBeNull();
    expect(tryResolveRoleByCapability(ctx, "driver")).toBeNull();
  });

  it("structural probes: role coverage and member existence read every lifecycle state", () => {
    seedSeat("dev", "builder1", { role: "builder" });
    seedSeat("dev", "cold1", { sessionStatus: null });
    seedSeat("ops", "term1", { runtime: "terminal", sessionStatus: null });

    expect(rigDeclaresRole(db, "factory-a", "builder")).toBe(true);
    expect(rigDeclaresRole(db, "factory-a", "nobody")).toBe(false);
    expect(rigMemberExists(db, "factory-a", "dev-builder1@factory-a")).toBe(true);
    expect(rigMemberExists(db, "factory-a", "dev-cold1@factory-a")).toBe(true);
    expect(rigMemberExists(db, "factory-a", "ops-term1@factory-a")).toBe(true);
    expect(rigMemberExists(db, "factory-a", "dev-typo1@factory-a")).toBe(false);
    expect(rigMemberExists(db, "ghost-rig", "dev-x@ghost-rig")).toBe(false);
  });

  it("a running seat whose startup asked for attention is not live", async () => {
    const seat = seedSeat("dev", "driver1", { role: "driver" });
    db.prepare("UPDATE sessions SET startup_status = 'attention_required' WHERE session_name = ?").run(seat);
    const ctx = roleResolutionContext(db, "factory-a");
    expect(tryResolveRoleByCapability(ctx, "driver")).toBeNull();
  });
});