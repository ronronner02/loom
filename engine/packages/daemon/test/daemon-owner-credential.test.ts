import { afterEach, describe, expect, it, vi } from "vitest";
import { replyToMintPairing } from "../src/index.js";
import { createDaemon } from "../src/startup.js";

/**
 * The owner credential has one input: the caller. `startServer` consumes
 * `LOOM_OWNER_TOKEN` before it spawns anything and passes the result in, so a second read
 * inside `createDaemon` could only ever see the value it had already deleted — which left an
 * embedder calling `createDaemon` directly with a daemon whose every owner route answered 401.
 */
describe("createDaemon owner credential", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("refuses to start with no owner credential instead of serving an unadministrable daemon", async () => {
    vi.stubEnv("LOOM_OWNER_TOKEN", "fixture-owner-token");
    // An environment token is not a fallback: the process entry already consumed it.
    await expect(createDaemon({ dbPath: ":memory:" }))
      .rejects.toThrow(/requires an owner credential/);
  });

  it("starts with the credential the caller names", async () => {
    const ownerToken = "fixture-caller-owner-token";
    const daemon = await createDaemon({ dbPath: ":memory:", teamControl: { credentials: { ownerToken } } });
    try { expect(daemon.deps.teamControl?.credentials.ownerToken).toBe(ownerToken); }
    finally { daemon.eventLoopMonitor.stop(); daemon.db.close(); }
  });

  // The desktop mints over the parent port from `deps`, then exchanges over HTTP; both must reach
  // one session store, or every desktop launch fails to pair.
  it("mints a parent-port pairing code that the composed exchange route accepts", async () => {
    const ownerToken = "fixture-caller-owner-token";
    const daemon = await createDaemon({ dbPath: ":memory:", teamControl: { credentials: { ownerToken } } });
    try {
      const sent: Array<Record<string, unknown>> = [];
      replyToMintPairing(daemon.deps.ownerSessions, ownerToken, { postMessage: m => { sent.push(m as Record<string, unknown>); } });
      expect(sent).toHaveLength(1);
      expect(sent[0]!.type).toBe("pairing-code");
      const exchanged = await daemon.app.request("http://localhost/api/team-control/owner-session/exchange", {
        method: "POST",
        headers: { Host: "localhost", Origin: "http://localhost", "Content-Type": "application/json" },
        body: JSON.stringify({ code: sent[0]!.code }),
      }, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
      expect(exchanged.status).toBe(200);
    } finally { daemon.eventLoopMonitor.stop(); daemon.db.close(); }
  });
});