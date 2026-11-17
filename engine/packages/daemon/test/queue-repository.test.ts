import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { initializeDatabase } from "../src/db/baseline.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, QueueRepositoryError, isBlockerLive, isTerminalState, newQitemId, isQitemPrimaryKeyConflict } from "../src/domain/queue-repository.js";

const codeOf = (fn: () => unknown): string | null => {
  try { fn(); return null; } catch (err) { return err instanceof QueueRepositoryError ? err.code : `not-a-queue-error: ${String(err)}`; }
};
import type { PersistedEvent } from "../src/domain/types.js";

// The queue store the daemon actually runs on: create, update, read, the closure and
// blocked-on contracts, the transition log and the generation-scoped release.
describe("QueueRepository", () => {
  let db: Database.Database;
  let bus: EventBus;
  let repo: QueueRepository;
  let captured: PersistedEvent[];

  beforeEach(() => {
    db = createDb();
    initializeDatabase(db);
    bus = new EventBus(db);
    repo = new QueueRepository(db, bus);
    captured = [];
    bus.subscribe((event) => captured.push(event));
  });

  afterEach(() => db.close());

  it("create stamps qitem_id, a transition and a queue.created event", async () => {
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "do the thing" });
    expect(item.qitemId).toMatch(/^qitem-/);
    expect(item.state).toBe("pending");
    expect(repo.listTransitions(item.qitemId).map((t) => t.transitionNote)).toEqual(["created"]);
    expect(captured.filter((e) => e.type === "queue.created")).toHaveLength(1);
  });

  it("create rejects an unknown rig when validateRig denies", async () => {
    const strict = new QueueRepository(db, bus, { validateRig: () => false });
    await expect(strict.create({ sourceSession: "alice@rig", destinationSession: "ghost@rig", body: "x" }))
      .rejects.toMatchObject({ code: "unknown_destination_rig" });
  });

  it("an explicit qitemId retried with the same identity returns the stored row (idempotent re-delivery)", async () => {
    const qitemId = newQitemId();
    const first = await repo.create({ qitemId, sourceSession: "a@rig", destinationSession: "b@rig", body: "once" });
    const again = await repo.create({ qitemId, sourceSession: "a@rig", destinationSession: "b@rig", body: "once" });
    expect(again.qitemId).toBe(first.qitemId);
    expect(db.prepare("SELECT count(*) AS n FROM queue_items").get()).toEqual({ n: 1 });
  });

  it("the same qitemId with a different body warns instead of implying the new body was saved", async () => {
    const qitemId = newQitemId();
    await repo.create({ qitemId, sourceSession: "a@rig", destinationSession: "b@rig", body: "original" });
    const again = await repo.create({ qitemId, sourceSession: "a@rig", destinationSession: "b@rig", body: "different" });
    expect(again.createWarning?.code).toBe("qitem_body_not_saved");
    expect(again.body).toBe("original");
  });

  it("update emits queue.updated carrying fromState, toState and the closure metadata", async () => {
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "x" });
    captured.length = 0;
    repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "done", closureReason: "no-follow-on", transitionNote: "wrapping up" });
    const events = captured.filter((e) => e.type === "queue.updated");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      qitemId: item.qitemId, fromState: "pending", toState: "done", closureReason: "no-follow-on", actorSession: "bob@rig",
    });
  });

  it("a note-only append is admitted and carries no state change", async () => {
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "x" });
    repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", transitionNote: "progress note" });
    expect(repo.getById(item.qitemId)!.state).toBe("pending");
    expect(repo.listTransitions(item.qitemId).at(-1)?.transitionNote).toBe("progress note");
  });

  it("a note append refuses the state-write fields rather than silently dropping them", async () => {
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "x" });
    expect(codeOf(() => repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", closureReason: "no-follow-on", transitionNote: "n" }))).toBe("note_append_fields_not_admitted");
  });

  it("exiting blocked clears blocked_on — a non-blocked row never carries a stale blocker", async () => {
    const blocker = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "blocker" });
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "work" });
    repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "blocked", blockedOn: blocker.qitemId });
    expect(repo.getById(item.qitemId)!.blockedOn).toBe(blocker.qitemId);
    repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "pending" });
    expect(repo.getById(item.qitemId)!.blockedOn, "a non-blocked row must not carry a blocker").toBeNull();
  });

  it("parking on a nonexistent or terminal qitem blocker is refused", async () => {
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "work" });
    expect(codeOf(() => repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "blocked", blockedOn: "qitem-19990101000000-deadbeef" }))).toBe("blocker_not_found");
    const done = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "closed" });
    repo.update({ qitemId: done.qitemId, actorSession: "bob@rig", state: "done", closureReason: "no-follow-on" });
    expect(codeOf(() => repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "blocked", blockedOn: done.qitemId }))).toBe("blocker_not_live");
  });

  it("a well-formed typed non-qitem blocker is accepted; a bare prefix is refused", async () => {
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "gated" });
    repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "blocked", blockedOn: "fold:one-home+attestation" });
    expect(repo.getById(item.qitemId)!.blockedOn).toBe("fold:one-home+attestation");
    expect(codeOf(() => repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "blocked", blockedOn: "fold:" }))).toBe("blocker_malformed");
  });

  it("a supersession-cancel records its successor; a plain cancel stays abandoned", async () => {
    const successor = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "successor" });
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "original" });
    repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "canceled", closureReason: "superseded", closureTarget: successor.qitemId });
    const original = repo.getById(item.qitemId)!;
    expect(original.closureReason).toBe("superseded");
    expect(original.closureTarget).toBe(successor.qitemId);

    const plain = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "plain" });
    repo.update({ qitemId: plain.qitemId, actorSession: "bob@rig", state: "canceled" });
    expect(repo.getById(plain.qitemId)!.closureReason).toBeNull();
  });

  it("a supersession without a successor target is refused, and the row is untouched", async () => {
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "original" });
    expect(codeOf(() => repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "canceled", closureReason: "superseded" }))).toBe("missing_closure_target");
    expect(repo.getById(item.qitemId)!.state).toBe("pending");
  });

  it("a successor records handedOffFrom so a supersession is traversable both ways", async () => {
    const original = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "original" });
    const successor = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "corrected", handedOffFrom: original.qitemId });
    expect(successor.handedOffFrom).toBe(original.qitemId);
  });

  it("done without a closure reason is refused with the valid reason set", async () => {
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "x" });
    try {
      repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "done" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QueueRepositoryError);
      expect((err as QueueRepositoryError).code).toBe("missing_closure_reason");
    }
  });

  it("a closure reason outside the admitted forms is refused before any write", async () => {
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "x" });
    expect(codeOf(() => repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "pending", closureReason: "no-follow-on" }))).toBe("closure_fields_not_admitted");
    expect(repo.getById(item.qitemId)!.state).toBe("pending");
  });

  it("reopening a terminal row requires --reopen and a note", async () => {
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "x" });
    repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "done", closureReason: "no-follow-on" });
    expect(codeOf(() => repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "pending", transitionNote: "again" }))).toBe("terminal_reopen_requires_ack");
    expect(codeOf(() => repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "pending", reopen: true }))).toBe("reopen_note_required");
    const reopened = repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "pending", reopen: true, transitionNote: "owner asked again" });
    expect(reopened.state).toBe("pending");
    expect(repo.listTransitions(item.qitemId).at(-1)?.transitionNote).toBe("reopen acknowledged: owner asked again");
  });

  it("transitions are append-only: every state change adds a row", async () => {
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "x" });
    repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "blocked", blockedOn: "external:host/x" });
    repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "done", closureReason: "no-follow-on" });
    expect(repo.listTransitions(item.qitemId).map((t) => t.state)).toEqual(["pending", "blocked", "done"]);
  });

  it("list filters by destination, source and state", async () => {
    const mine = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "mine" });
    const theirs = await repo.create({ sourceSession: "carol@rig", destinationSession: "dave@rig", body: "theirs" });
    expect(repo.list({ destinationSession: "bob@rig" }).map((i) => i.qitemId)).toEqual([mine.qitemId]);
    expect(repo.list({ sourceSession: "carol@rig" }).map((i) => i.body)).toEqual(["theirs"]);
    repo.update({ qitemId: mine.qitemId, actorSession: "bob@rig", state: "done", closureReason: "no-follow-on" });
    expect(repo.list({ activeOnly: true }).map((i) => i.qitemId)).toEqual([theirs.qitemId]);
    expect(repo.list({ state: "done" }).map((i) => i.qitemId)).toEqual([mine.qitemId]);
  });

  it("a human-seat park must carry a summary and an evidence ref", async () => {
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "ask" });
    expect(codeOf(() => repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "blocked", blockedOn: "human-owner@kernel" })))
      .not.toBeNull();
    repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "blocked", blockedOn: "human-owner@kernel",
      summary: "Decide the rollout", evidenceRef: "docs/plan.md" });
    const parked = repo.getById(item.qitemId)!;
    expect(parked.blockedOn).toBe("human-owner@kernel");
    expect(parked.summary).toBe("Decide the rollout");
    expect(parked.evidenceRef).toBe("docs/plan.md");
  });

  it("summary and evidence ref are refused on a non-park transition rather than silently dropped", async () => {
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "x" });
    expect(codeOf(() => repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "pending", summary: "nope" }))).toBe("summary_evidence_not_persistable");
  });

  it("releaseClaimsByGeneration releases only the retiring generation's in-progress claims", async () => {
    const mine = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "mine" });
    const theirs = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "theirs" });
    db.prepare("UPDATE queue_items SET state = 'in-progress', claimed_at = ?, claimed_by_generation_uuid = ? WHERE qitem_id = ?")
      .run(new Date().toISOString(), "gen-retired", mine.qitemId);
    db.prepare("UPDATE queue_items SET state = 'in-progress', claimed_at = ?, claimed_by_generation_uuid = ? WHERE qitem_id = ?")
      .run(new Date().toISOString(), "gen-live", theirs.qitemId);
    expect(repo.releaseClaimsByGeneration("gen-retired")).toBe(1);
    expect(repo.getById(mine.qitemId)).toMatchObject({ state: "pending", claimedAt: null });
    expect(repo.getById(theirs.qitemId)!.state).toBe("in-progress");
  });

  it("the state predicates agree with the shipped state sets", () => {
    expect(isBlockerLive("pending")).toBe(true);
    expect(isBlockerLive("blocked")).toBe(true);
    expect(isBlockerLive("done")).toBe(false);
    expect(isTerminalState("done")).toBe(true);
    expect(isTerminalState("handed-off")).toBe(true);
    expect(isTerminalState("pending")).toBe(false);
    expect(isQitemPrimaryKeyConflict(Object.assign(new Error("UNIQUE constraint failed: queue_items.qitem_id"), {}))).toBe(true);
  });
});