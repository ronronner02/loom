import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../src/db/connection.js";
import { initializeDatabase } from "../src/db/baseline.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { PlanGovernance } from "../src/domain/plan-governance.js";
import { TeamReadModel } from "../src/team-control-surface.js";
import type { PlanBinding } from "../src/contracts/team-control.js";
import { createTestApp } from "./helpers/test-app.js";

const binding: PlanBinding = {
  artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
  planRef: "docs/plan.md", planDigest: `sha256:${"a".repeat(64)}`,
  repository: { root: "/workspace/project", identity: `git:${"b".repeat(40)}` }, readPaths: ["src"], writePaths: ["src"],
  roles: ["lead", "implementer", "reviewer"], policyRevision: 1, policyFingerprint: `sha256:${"c".repeat(64)}`,
  limits: { maxSessions: 3, maxActiveMs: 3_600_000, maxRetries: 1, maxReviewRounds: 2 },
};
const ownerToken = "fanout-owner-fixture";

/**
 * Subscriber-generated events reach a reader in the order they were persisted.
 *
 * An event committed inside a subscriber runs after the parent has reached every subscriber,
 * and the live stream is the surface a reader sees. The SSE ids are the persisted sequence
 * numbers, so the stream's order is the durable order rather than a second ordering rule.
 */
describe("subscriber-generated events", () => {
  let db: ReturnType<typeof createDb>, bus: EventBus, governance: PlanGovernance;
  let app: ReturnType<typeof createTestApp>["app"];
  beforeEach(() => {
    db = createDb();
    initializeDatabase(db);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'fanout fixture')").run();
    bus = new EventBus(db);
    governance = new PlanGovernance(db, bus, new QueueRepository(db, bus));
    governance.createRun({ id: "run", rigId: "rig", binding });
    const model = new TeamReadModel({ db, governance, events: bus, readTaskRows: () => [] });
    app = createTestApp(db, { appDeps: { eventBus: bus, teamGovernance: governance,
      teamControl: { credentials: { ownerToken }, readModel: model, resolveBinding: () => binding } } }).app;
  });
  afterEach(() => db.close());

  it.each(["emit", "envelope"])("delivers %s children once, after the parent reaches every subscriber", (writer) => {
    const first: number[] = [];
    const second: number[] = [];
    bus.subscribe((event) => {
      first.push(event.seq);
      if (event.type !== "rig.created") return;
      const child = { type: "rig.deleted" as const, rigId: "rig-1" };
      if (writer === "emit") bus.emit(child);
      else bus.withNotifyEnvelope((register) => register(bus.persistWithinTransaction(child)));
    });
    bus.subscribe((event) => second.push(event.seq));
    // The fixture's run creation is the log's first event; the parent and the child it commits
    // are the next two, in that order.
    const before = bus.replayAll(0).at(-1)!.seq;
    bus.emit({ type: "rig.created", rigId: "rig-1" });
    const persisted = bus.replayAll(before).map((event) => event.seq);
    expect(persisted).toEqual([before + 1, before + 2]);
    expect(first).toEqual(persisted);
    expect(second).toEqual(persisted);
    expect(bus.getNotifyDrainStatus().watermark).toBe(before + 2);
  });

  it("streams nested live events in the same order as durable replay", async () => {
    const publish = (eventId: string, index: number, action: string) => bus.emit({ type: "team.control",
      protocolVersion: "1.0", eventId, rigId: "rig", runId: "run", taskId: null, attemptId: null,
      entityId: "run", entityVersion: index, action, payload: { index } });
    // A subscriber commits its own event while the parent is being delivered. Both must reach the
    // stream, in durable order, and neither may be delivered twice.
    bus.subscribe((event) => {
      if (event.type === "rig.created") publish("nested", 2, "fixture.nested");
    });
    publish("parent", 1, "fixture.parent");
    const response = await app.request("/api/team-control/runs/run/events/stream", {
      headers: { authorization: `Bearer ${ownerToken}` },
    }, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const received: number[] = [];
    let pending = "";
    try {
      publish("last", 3, "fixture.last");
      const deadline = Date.now() + 5_000;
      while (received.length < 3 && Date.now() < deadline) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        let boundary: number;
        while ((boundary = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          const id = /^id: (\d+)$/m.exec(frame);
          if (id) received.push(Number(id[1]));
        }
      }
      // The durable log and the stream agree: every persisted event, once, in sequence order.
      expect(received).toEqual(bus.replayRunSince("run", 0, 100).map((event) => event.seq));
      expect(received.length).toBe(3);
    } finally {
      await reader.cancel();
    }
  });
});