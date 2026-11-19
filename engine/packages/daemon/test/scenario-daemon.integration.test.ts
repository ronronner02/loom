import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { prepareHermeticEnv, SCAFFOLD_OWNER_TOKEN, type HermeticScaffold } from "./helpers/hermetic-env.js";
import {
  spawnScenarioDaemon,
  findFreePort,
  type ScenarioDaemon,
} from "./helpers/scenario-daemon.js";

// Slice 51-02 — the forced-local daemon SPAWN (the last hermetic-helper unit).
// Integration: the helper spawns a REAL scenario-local daemon (the built `rig`
// bin) under the scrubbed scratch env, its owner surface answers against it, and
// stop() tears it down. This is the foundation of proof item 2 (live round-trip)
// proven at a real process boundary — the whole point of the fail-closed helper
// (a direct method call would not be a transport proof).
//
// Contention note: spawns a real daemon (seconds); a free port avoids collisions.
// Under heavy fleet load the start/healthz wait can be slow — bounded by timeout.

const HERE = dirname(fileURLToPath(import.meta.url));
const RIG_BIN = resolve(HERE, "../../cli/dist/bin-wrapper.js");

function realBaseEnv() {
  return { HOME: process.env.HOME, PATH: process.env.PATH, TERM: "xterm" };
}

/** The owner-authenticated health read: the daemon's own evidence that it is serving. */
async function ownerHealth(baseUrl: string): Promise<Response> {
  return fetch(`${baseUrl}/api/team-control/health`, { headers: { Authorization: `Bearer ${SCAFFOLD_OWNER_TOKEN}` } });
}

describe("scenario-daemon forced-local spawn (integration)", () => {
  let scaffold: HermeticScaffold | undefined;
  let daemon: ScenarioDaemon | undefined;

  afterEach(async () => {
    if (daemon) await daemon.stop().catch(() => {});
    else if (scaffold) scaffold.cleanup();
    daemon = undefined;
    scaffold = undefined;
  });

  it("findFreePort returns a usable ephemeral port", async () => {
    const p = await findFreePort();
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(65536);
  });

  it("spawns a real forced-local daemon, serves the owner read, and tears it down", async () => {
    scaffold = prepareHermeticEnv({ baseEnv: realBaseEnv() });
    daemon = await spawnScenarioDaemon(scaffold, { rigBin: RIG_BIN });

    // /healthz is up on the helper's OWN daemon
    const health = await fetch(`${daemon.baseUrl}/healthz`);
    expect(health.ok).toBe(true);

    // The owner surface authenticates with the scaffold's credential, so this proves the
    // daemon booted admin-able rather than only listening.
    const read = await ownerHealth(daemon.baseUrl);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ protocolVersion: expect.any(String), health: expect.any(Object) });

    // teardown: the daemon is gone (connection refused), scaffold removed
    const baseUrl = daemon.baseUrl;
    await daemon.stop();
    daemon = undefined;
    await expect(fetch(`${baseUrl}/healthz`)).rejects.toThrow();
  }, 60_000);

  it("readEnv points at the helper's own daemon, never a foreign target", async () => {
    scaffold = prepareHermeticEnv({ baseEnv: realBaseEnv() });
    daemon = await spawnScenarioDaemon(scaffold, { rigBin: RIG_BIN });
    expect(daemon.readEnv.LOOM_URL).toBe(daemon.baseUrl);
    expect(daemon.baseUrl).toContain("127.0.0.1");
  }, 60_000);

  // Proof item 8 (the daemon-lifecycle A1 verb): sigterm kills the scenario-local
  // daemon; restart re-spawns it through the SAME guarantees (same port/scratch).
  it("daemon sigterm kills the scenario-local daemon (healthz refused)", async () => {
    scaffold = prepareHermeticEnv({ baseEnv: realBaseEnv() });
    daemon = await spawnScenarioDaemon(scaffold, { rigBin: RIG_BIN });
    expect((await fetch(`${daemon.baseUrl}/healthz`)).ok).toBe(true);
    await daemon.sigterm();
    await expect(fetch(`${daemon.baseUrl}/healthz`)).rejects.toThrow();
  }, 60_000);

  it("daemon restart re-spawns the scenario-local daemon on the same port/scratch", async () => {
    scaffold = prepareHermeticEnv({ baseEnv: realBaseEnv() });
    daemon = await spawnScenarioDaemon(scaffold, { rigBin: RIG_BIN });
    const beforePort = daemon.port;
    await daemon.restart();
    // back up on the SAME port (re-spawn through the same env guarantees)
    expect(daemon.port).toBe(beforePort);
    const health = await fetch(`${daemon.baseUrl}/healthz`);
    expect(health.ok).toBe(true);
    // the owner read still works against the re-spawned daemon
    expect((await ownerHealth(daemon.baseUrl)).status).toBe(200);
  }, 60_000);
});
