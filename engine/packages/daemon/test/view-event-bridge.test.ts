import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { initializeDatabase } from "../src/db/baseline.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { StreamStore } from "../src/domain/stream-store.js";
import { ViewProjector } from "../src/domain/view-projector.js";
import { wireViewEventBridge } from "../src/domain/view-event-bridge.js";
import type { PersistedEvent } from "../src/domain/types.js";

/**
 * View event bridge tests (PL-004 Phase B R1; closes guard BLOCKER 2).
 *
 * The bridge subscribes to coordination state-mutation events and emits
 * view.changed for affected built-in views via ViewProjector.notifyViewChanged.
 * Without this, /api/views/:name/sse never receives change notifications.
 */

describe("view-event-bridge (PL-004 Phase B R1; BLOCKER 2 fix)", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let streamStore: StreamStore;
  let projector: ViewProjector;
  let captured: PersistedEvent[];

  beforeEach(() => {
    db = createDb();
    initializeDatabase(db);
    bus = new EventBus(db);
    queueRepo = new QueueRepository(db, bus);
    streamStore = new StreamStore(db, bus);
    projector = new ViewProjector(db, bus);
    captured = [];
    bus.subscribe((e) => captured.push(e));
    wireViewEventBridge(bus, projector);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  function viewChangedEvents(): Array<{ viewName: string; cause: string }> {
    return captured
      .filter((e) => e.type === "view.changed")
      .map((e) => ({ viewName: (e as { viewName: string }).viewName, cause: (e as { cause: string }).cause }));
  }

  it("queue.created triggers view.changed for recently-active + founder + pod-load + activity", async () => {
    await queueRepo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "test",
      nudge: false,
    });
    const events = viewChangedEvents();
    const viewNames = events.map((e) => e.viewName);
    expect(viewNames).toContain("recently-active");
    expect(viewNames).toContain("founder");
    expect(viewNames).toContain("pod-load");
    expect(viewNames).toContain("activity");
    // Each event has cause = the source event type.
    expect(events.every((e) => e.cause === "queue.created")).toBe(true);
  });

  it("queue.handed_off triggers view.changed for recently-active + pod-load + activity", async () => {
    const item = await queueRepo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "test",
      nudge: false,
    });
    captured.length = 0; // reset to focus on the handoff event
    await queueRepo.handoff({
      qitemId: item.qitemId,
      fromSession: "bob@rig",
      toSession: "carol@rig",
      nudge: false,
    });
    const events = viewChangedEvents();
    expect(events.some((e) => e.viewName === "recently-active" && e.cause === "queue.handed_off")).toBe(true);
    expect(events.some((e) => e.viewName === "pod-load" && e.cause === "queue.handed_off")).toBe(true);
    expect(events.some((e) => e.viewName === "activity" && e.cause === "queue.handed_off")).toBe(true);
    // queue.handed_off ALSO emits queue.created for the new qitem (which fires its own view.changed batch).
  });

  it("R2: queue.updated triggers view.changed for ALL 6 built-in views (state mutations may affect any)", async () => {
    const item = await queueRepo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "test",
      nudge: false,
    });
    queueRepo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
    captured.length = 0;
    queueRepo.update({
      qitemId: item.qitemId,
      actorSession: "bob@rig",
      state: "done",
      closureReason: "no-follow-on",
    });
    const events = viewChangedEvents();
    const updateViewNames = events
      .filter((e) => e.cause === "queue.updated")
      .map((e) => e.viewName)
      .sort();
    // R2 mapping: queue.updated → all 6 built-in views.
    expect(updateViewNames).toEqual([
      "activity",
      "escalations",
      "founder",
      "held",
      "pod-load",
      "recently-active",
    ]);
  });

  it("R2: queue.updated for pending → blocked transition triggers view.changed for held + activity (and others)", async () => {
    const item = await queueRepo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "test-blocked",
      nudge: false,
    });
    captured.length = 0;
    queueRepo.update({
      qitemId: item.qitemId,
      actorSession: "bob@rig",
      state: "blocked",
      transitionNote: "blocked on dep",
    });
    const events = viewChangedEvents();
    const updateViews = events.filter((e) => e.cause === "queue.updated").map((e) => e.viewName);
    // held + activity are the most semantically affected, but all 6 fire conservatively.
    expect(updateViews).toContain("held");
    expect(updateViews).toContain("activity");
  });

  it("queue.claimed triggers view.changed for recently-active + pod-load + activity", async () => {
    const item = await queueRepo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "test",
      nudge: false,
    });
    captured.length = 0;
    queueRepo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
    const events = viewChangedEvents();
    const claimEvents = events.filter((e) => e.cause === "queue.claimed");
    expect(claimEvents.map((e) => e.viewName).sort()).toEqual(["activity", "pod-load", "recently-active"]);
  });

  it("qitem.closure_overdue triggers view.changed for recently-active + escalations + activity", async () => {
    const item = await queueRepo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "test-overdue",
      nudge: false,
    });
    queueRepo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
    const past = new Date(Date.now() - 60_000).toISOString();
    db.prepare("UPDATE queue_items SET closure_required_at = ? WHERE qitem_id = ?").run(past, item.qitemId);
    captured.length = 0;
    const event = queueRepo.recordClosureOverdue(item.qitemId);
    expect(event).not.toBeNull();
    expect(event?.type).toBe("qitem.closure_overdue");

    const events = viewChangedEvents();
    const overdueViewNames = events
      .filter((e) => e.cause === "qitem.closure_overdue")
      .map((e) => e.viewName)
      .sort();
    expect(overdueViewNames).toEqual([
      "activity",
      "escalations",
      "recently-active",
    ]);
  });

  it("notifyViewChanged persists only and view.changed does not echo through the bridge", () => {
    projector.notifyViewChanged("recently-active", "manual-test");
    captured.length = 0;
    projector.notifyViewChanged("recently-active", "manual-test-2");
    expect(captured).toEqual([]);
    const persisted = bus.replayAll(0).filter((event) => event.type === "view.changed");
    expect(persisted).toHaveLength(2);
    expect(persisted.map((event) => event.cause)).toEqual(["manual-test", "manual-test-2"]);
  });

  it("W2b drains outer events before re-entrant view.changed rows and delivers each exactly once", () => {
    captured.length = 0;

    bus.withNotifyEnvelope((register) => {
      register(bus.persistWithinTransaction({
        type: "queue.handed_off",
        qitemId: "q-w2b-handoff",
        fromSession: "alice@rig",
        toSession: "bob@rig",
        closureReason: "handed_off_to",
        summary: null,
      }));
      register(bus.persistWithinTransaction({ type: "proof.sources_changed", scope: "w2b", revision: "1" }));
    });

    expect(captured.slice(0, 2).map((event) => event.type)).toEqual([
      "queue.handed_off",
      "proof.sources_changed",
    ]);
    const replayed = bus.replayAll(0);
    expect(captured.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(captured.map((event) => event.seq)).toEqual(replayed.map((event) => event.seq));
    expect(new Set(captured.map((event) => event.seq)).size).toBe(captured.length);
    expect(
      captured
        .filter((event) => event.type === "view.changed")
        .map((event) => `${event.viewName}:${event.cause}`),
    ).toEqual([
      "recently-active:queue.handed_off",
      "pod-load:queue.handed_off",
      "activity:queue.handed_off",
      "execution:proof.sources_changed",
    ]);
  });

  it("W2b keeps drain-time delivery failures outside the bridge best-effort persist catch", () => {
    const originalNotify = bus.notifySubscribers.bind(bus);
    vi.spyOn(bus, "notifySubscribers").mockImplementation((event) => {
      if (event.type === "view.changed") throw new Error("drain delivery failed");
      originalNotify(event);
    });

    expect(() =>
      bus.withNotifyEnvelope((register) => {
        register(bus.persistWithinTransaction({
          type: "queue.created",
          qitemId: "q-w2b-delivery-error",
          sourceSession: "alice@rig",
          destinationSession: "bob@rig",
          priority: "routine",
          tier: null,
          summary: null,
        }));
      }),
    ).toThrow("drain delivery failed");
  });

  it("unsubscribe stops the bridge", async () => {
    // Re-wire and capture the unsubscribe function.
    const localCaptured: PersistedEvent[] = [];
    bus.subscribe((e) => localCaptured.push(e));
    const stop = wireViewEventBridge(bus, projector);
    stop();
    await queueRepo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "test-after-unsubscribe",
      nudge: false,
    });
    // The MAIN bridge from beforeEach is still wired; it emits view.changed.
    // The local one we just stopped doesn't emit. Verify only ONE bridge fired
    // (not two): activity should appear exactly once.
    const activityEvents = captured.filter(
      (e) => e.type === "view.changed" && (e as { viewName: string }).viewName === "activity" && (e as { cause: string }).cause === "queue.created",
    );
    expect(activityEvents).toHaveLength(1);
  });
});
