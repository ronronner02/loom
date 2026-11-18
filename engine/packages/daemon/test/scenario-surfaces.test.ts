import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { prepareHermeticEnv, SCAFFOLD_OWNER_TOKEN, type HermeticScaffold } from "./helpers/hermetic-env.js";
import { spawnScenarioDaemon, type ScenarioDaemon } from "./helpers/scenario-daemon.js";
import {
  readSurface,
  UnboundSurfaceError,
  type SurfaceContext,
} from "./helpers/scenario-surfaces.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RIG_BIN = resolve(HERE, "../../cli/dist/bin-wrapper.js");
const realBaseEnv = () => ({ HOME: process.env.HOME, PATH: process.env.PATH, TERM: "xterm" });

// Slice 51-02 — surface readers: read each shipped-observable surface via the
// shipped `rig` invocation and parse it into the observable the runner asserts
// on. `proof` is RESERVED at the format level (PM lock amendment, ruling row
// qitem-20260811092250-a80735bc) — the validator rejects it at load, and the
// reader keeps a defense-in-depth unbound error for a runtime-smuggled value.

describe("surface readers — reserved-proof defense-in-depth + dispatch (pure)", () => {
  const ctx: SurfaceContext = { rigBin: RIG_BIN, readEnv: {}, baseUrl: "http://127.0.0.1:1" };

  it("a runtime-smuggled 'proof' read still FAILS LOUD with a named UnboundSurfaceError (defense-in-depth)", async () => {
    // "proof" left the ExpectSurface type (RESERVED); only a cast can reach here.
    const smuggled = "proof" as never;
    await expect(readSurface(smuggled, ctx)).rejects.toBeInstanceOf(UnboundSurfaceError);
    let msg = "";
    try { await readSurface(smuggled, ctx); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain("proof");
    expect(msg.toLowerCase()).toContain("unbound");
    // it must NOT claim success or return a value
  });

  it("readSurface(unknown surface) throws (never silently skips)", async () => {
    await expect(readSurface("database" as never, ctx)).rejects.toThrow();
  });
});

describe("surface readers — live daemon (integration)", () => {
  let scaffold: HermeticScaffold | undefined;
  let daemon: ScenarioDaemon | undefined;
  afterEach(async () => {
    if (daemon) await daemon.stop().catch(() => {});
    else if (scaffold) scaffold.cleanup();
    daemon = undefined; scaffold = undefined;
  });

  // The shipped reads this suite once drove (ps, queue, transcript) went with the CLI
  // reduction; the owner surface is what the daemon still serves, so the live round trip is
  // asserted there. The pure dispatch cases above still cover the reader's own contract.
  it("the owner read answers from the scenario-local daemon, and refuses an anonymous caller", async () => {
    scaffold = prepareHermeticEnv({ baseEnv: realBaseEnv() });
    daemon = await spawnScenarioDaemon(scaffold, { rigBin: RIG_BIN });

    const anonymous = await fetch(`${daemon.baseUrl}/api/team-control/health`);
    expect(anonymous.status).toBe(401);
    const owner = await fetch(`${daemon.baseUrl}/api/team-control/health`,
      { headers: { Authorization: `Bearer ${SCAFFOLD_OWNER_TOKEN}` } });
    expect(owner.status).toBe(200);
    expect(await owner.json()).toMatchObject({ protocolVersion: expect.any(String), health: expect.any(Object) });
  }, 60_000);
});
