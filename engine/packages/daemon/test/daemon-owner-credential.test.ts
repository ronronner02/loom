import { afterEach, describe, expect, it, vi } from "vitest";
import { createDaemon } from "../src/startup.js";

/**
 * The owner credential has one input: the caller. `startServer` consumes
 * `MULTI_AGENT_OWNER_TOKEN` before it spawns anything and passes the result in, so a second read
 * inside `createDaemon` could only ever see the value it had already deleted — which left an
 * embedder calling `createDaemon` directly with a daemon whose every owner route answered 401.
 */
describe("createDaemon owner credential", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("refuses to start with no owner credential instead of serving an unadministrable daemon", async () => {
    vi.stubEnv("MULTI_AGENT_OWNER_TOKEN", "fixture-owner-token");
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
});