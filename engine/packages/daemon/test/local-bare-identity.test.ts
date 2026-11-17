// FOUNDER ROOT INVARIANT (L2 row, transitions 10816/10817, superseding ruling cb19867f Q2):
// inside ONE Multi-Agent instance, seat identity is bare `member@rig` on every durable row and
// rendered surface — local queue create, handoff wake envelope, local From lines and reply
// hints, and (downstream) the Slack thread map. Host identity is added ONLY at the cross-host
// forwarding boundary (routes/queue.ts stamp-at-FORWARD, preserved) and rides verbatim when a
// genuine origin triple arrives.
//
// These pins hold by construction: no producer here has a host id to stamp, so every
// intra-instance surface stays bare and a genuine origin triple rides through verbatim.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { OutboxHandler, WAKE_INTENT_PREFIX } from "../src/domain/outbox-handler.js";
// P8: the canonical migration list — never a hand-curated inline subset.
import { initializeDatabase } from "../src/db/baseline.js";
import { EventBus } from "../src/domain/event-bus.js";
import { wrapPaneEnvelope } from "../src/lib/pane-envelope.js";

const TEST_HOST = "host-red-invariant";

describe("local bare identity — no self-host suffix on any intra-instance surface", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let outbox: OutboxHandler;

  beforeEach(() => {
    db = new Database(":memory:");
    initializeDatabase(db);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    outbox = new OutboxHandler(db);
    repo.attachOutbox(outbox);
  });
  afterEach(() => {
    db.close();
  });

  it("queue CREATE persists the bare transport identity — never the self-host triple", async () => {
    const row = await repo.create({
      sourceSession: "dev-driver@v-multi-agent-build",
      destinationSession: "orch-lead@v-multi-agent-build",
      body: "local row",
    });
    expect(row.sourceSession, "local source_session must stay bare member@rig").toBe("dev-driver@v-multi-agent-build");
    expect(row.sourceSession).not.toContain(TEST_HOST);
  });

  it("a genuine ORIGIN TRIPLE arriving at create (cross-host forward) is stored verbatim — the boundary semantics survive the local deletion", async () => {
    const row = await repo.create({
      sourceSession: "pm-lead@other-rig@host-remote1",
      destinationSession: "orch-lead@v-multi-agent-build",
      body: "forwarded row",
    });
    expect(row.sourceSession).toBe("pm-lead@other-rig@host-remote1"); // never re-stamped, never stripped
  });

  it("the HANDOFF frozen wake envelope renders bare From and a copy-paste-local reply hint", async () => {
    const row = await repo.create({
      sourceSession: "dev-driver@v-multi-agent-build",
      destinationSession: "orch-lead@v-multi-agent-build",
      body: "to hand off",
    });
    await repo.handoff({
      qitemId: row.qitemId,
      fromSession: "dev-driver@v-multi-agent-build",
      toSession: "orch-lead@v-multi-agent-build",
      nudge: true,
    });
    const intents = db
      .prepare("SELECT outbox_id, body FROM outbox_entries WHERE outbox_id LIKE ?")
      .all(`${WAKE_INTENT_PREFIX}%`) as { outbox_id: string; body: string }[];
    expect(intents.length).toBeGreaterThan(0);
    const env = intents[intents.length - 1]!.body;
    expect(env).toContain("From: dev-driver@v-multi-agent-build\n"); // bare, newline-bounded (not a triple prefix)
    expect(env).toContain(`↩ Reply: multi-agent send dev-driver@v-multi-agent-build "..."`); // verbatim-usable locally
    expect(env).not.toContain(TEST_HOST);
  });

  it("the envelope wrapper renders a LOCAL sender exactly as received (no appended host id)", () => {
    // Called through a loose cast so this pin is signature-stable across the fix: pre-fix the
    // 4th argument is the selfHostId the callers pass (and gets appended — RED); post-fix the
    // parameter is gone and the sender renders as received (GREEN).
    const env = (wrapPaneEnvelope as (...args: unknown[]) => string)(
      "dev-driver@v-multi-agent-build",
      "orch-lead@v-multi-agent-build",
      "hello",
    );
    expect(env).toContain("From: dev-driver@v-multi-agent-build\n");
    expect(env).toContain(`↩ Reply: multi-agent send dev-driver@v-multi-agent-build "..."`);
    expect(env).not.toContain(TEST_HOST);
  });

  it("the envelope wrapper preserves a genuine origin TRIPLE verbatim (cross-host From stays qualified)", () => {
    const env = (wrapPaneEnvelope as (...args: unknown[]) => string)(
      "pm-lead@other-rig@host-remote1",
      "orch-lead@v-multi-agent-build",
      "hello from afar",
    );
    expect(env).toContain("From: pm-lead@other-rig@host-remote1");
    expect(env).toContain(`↩ Reply: multi-agent send pm-lead@other-rig@host-remote1 "..."`);
  });
});
