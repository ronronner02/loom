// "My command can't reach the daemon": BLOCKED is not DOWN.
//
// A connection this machine refused to make (EPERM/EACCES: a sandbox or security policy) used to
// render exactly like a daemon that is down, telling a sandboxed Codex seat to start a daemon that is
// already running. Contract pinned here:
//  (1) the client keeps the OS cause code on DaemonConnectionError;
//  (2) a blocked connection never reads as "start the daemon": the daemon may still be running, and
//      with Codex's network-disabled sandbox the cause is named and the offline help guide routed to
//      (no access setting is prescribed);
//  (3) ECONNREFUSED keeps today's down guidance, and the unknown-write wording is kept;
//  (4) --json carries the cause code.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DaemonClient, DaemonConnectionError } from "../src/client.js";
import { renderDaemonTransportError } from "../src/cli-error.js";
import { getDaemonStatus, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import { resolveOfflineHelpPath } from "../src/daemon-reachability.js";
import { createProcessLiveness, signalProbe } from "../src/commands/daemon.js";

const URL = "http://127.0.0.1:7433";
const DOWN_ADVICE = /multi-agent daemon start|'multi-agent up'|if it is down/i;
const WIDENING = /full_bypass|danger-full-access|network_access/i;
const TODAY_DOWN_ACTION =
  "Confirm the daemon is reachable with 'multi-agent daemon status'; if it is down, start it with 'multi-agent daemon start'.";
const UNKNOWN_WRITE_ACTION =
  "Check 'multi-agent daemon status' on the affected host; if it is down, start it with 'multi-agent daemon start'. Reconcile using the recovery ID before any retry. A lost connection does not prove the write failed.";

function failingFetch(code: string): typeof fetch {
  return (async () => {
    const err = new TypeError("fetch failed") as TypeError & { cause?: { code: string } };
    err.cause = { code };
    throw err;
  }) as unknown as typeof fetch;
}

async function connectionError(code: string): Promise<DaemonConnectionError> {
  const client = new DaemonClient(URL, { fetchImpl: failingFetch(code) });
  const caught = await client.get("/api/queue/list").then(() => null, (e) => e);
  expect(caught).toBeInstanceOf(DaemonConnectionError);
  return caught as DaemonConnectionError;
}

function render(e: unknown, json = false) {
  const out: string[] = [];
  const err: string[] = [];
  const handled = renderDaemonTransportError(e, { out: (l) => out.push(l), err: (l) => err.push(l), json });
  return { handled, out: out.join("\n"), err: err.join("\n") };
}

function lifecycleDeps(over: Partial<LifecycleDeps> = {}): LifecycleDeps {
  return {
    spawn: vi.fn() as unknown as LifecycleDeps["spawn"],
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn(() => null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn(() => false),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 0),
    isProcessAlive: vi.fn(() => false),
    sleep: async () => {},
    ...over,
  };
}

const probeFailing = (code: string): LifecycleDeps["fetch"] => async () => {
  const err = new TypeError("fetch failed") as TypeError & { cause?: { code: string } };
  err.cause = { code };
  throw err;
};

beforeEach(() => {
  vi.stubEnv("CODEX_SANDBOX_NETWORK_DISABLED", "");
  process.exitCode = undefined;
});
afterEach(() => {
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

describe("client keeps the OS cause of a failed connection", () => {
  it("EPERM rides DaemonConnectionError as causeCode and in the message", async () => {
    const e = await connectionError("EPERM");
    expect(e.causeCode).toBe("EPERM");
    expect(e.message).toContain("(EPERM)");
  });

  it("ECONNREFUSED is kept the same way", async () => {
    const e = await connectionError("ECONNREFUSED");
    expect(e.causeCode).toBe("ECONNREFUSED");
  });
});

describe("transport render: blocked is not down", () => {
  it("EPERM says the machine blocked it and the daemon may be running, with no start advice", async () => {
    const { handled, err } = render(await connectionError("EPERM"));
    expect(handled).toBe(true);
    expect(err).toMatch(/blocked the connection \(EPERM\)/);
    expect(err).toMatch(/may still be running/);
    expect(err).not.toMatch(DOWN_ADVICE);
    expect(err).not.toMatch(/Codex/);
  });

  it("EACCES is treated as blocked too", async () => {
    const { err } = render(await connectionError("EACCES"));
    expect(err).toMatch(/blocked the connection \(EACCES\)/);
    expect(err).not.toMatch(DOWN_ADVICE);
  });

  it("EPERM inside Codex's network-disabled sandbox names the cause and routes to the offline guide", async () => {
    vi.stubEnv("CODEX_SANDBOX_NETWORK_DISABLED", "1");
    const { err } = render(await connectionError("EPERM"));
    expect(err).toMatch(/Codex sandbox/);
    expect(err).toMatch(/help\.md/);
    expect(err).toMatch(/cannot change its own sandbox/);
    expect(err).toContain("The agent is waiting for permission or can't reach the daemon");
    expect(err).toMatch(/docs\/reference\/help\.md/);
    expect(err).not.toMatch(DOWN_ADVICE);
    expect(err).not.toMatch(WIDENING);
  });

  it("ECONNREFUSED keeps today's down guidance unchanged", async () => {
    vi.stubEnv("CODEX_SANDBOX_NETWORK_DISABLED", "1");
    const { err } = render(await connectionError("ECONNREFUSED"));
    expect(err).toContain("The command was not delivered.");
    expect(err).toContain(TODAY_DOWN_ACTION);
    expect(err).not.toMatch(/blocked the connection|Codex sandbox/);
  });

  it("--json carries the cause code for both blocked and refused", async () => {
    const blocked = JSON.parse(render(await connectionError("EPERM"), true).out);
    expect(blocked.error.causeCode).toBe("EPERM");
    expect(blocked.error.action).not.toMatch(DOWN_ADVICE);
    const refused = JSON.parse(render(await connectionError("ECONNREFUSED"), true).out);
    expect(refused.error.causeCode).toBe("ECONNREFUSED");
    expect(refused.error.action).toBe(TODAY_DOWN_ACTION);
  });

  it("an unknown-outcome write keeps #495's wording; blocked drops only the start advice", async () => {
    const blocked = await connectionError("EPERM");
    blocked.writeOutcome = "unknown";
    const b = render(blocked).err;
    expect(b).toMatch(/outcome is UNKNOWN/);
    expect(b).toContain("Reconcile using the recovery ID before any retry. A lost connection does not prove the write failed.");
    expect(b).toMatch(/blocked the connection \(EPERM\)/);
    expect(b).not.toMatch(DOWN_ADVICE);

    const refused = await connectionError("ECONNREFUSED");
    refused.writeOutcome = "unknown";
    expect(render(refused).err).toContain(UNKNOWN_WRITE_ACTION);
  });
});

describe("status probe keeps the cause", () => {
  it("records EPERM on every probe path, and never calls a blocked probe 'stopped'", async () => {
    process.env.MULTI_AGENT_URL = URL;
    try {
      const viaUrl = await getDaemonStatus(lifecycleDeps({ fetch: probeFailing("EPERM") }));
      expect(viaUrl.state).toBe("unverified");
      expect(viaUrl.probeErrorCode).toBe("EPERM");
    } finally {
      delete process.env.MULTI_AGENT_URL;
    }
    const noState = await getDaemonStatus(lifecycleDeps({ fetch: probeFailing("EPERM") }));
    expect(noState.state).toBe("unverified");
    expect(noState.probeErrorCode).toBe("EPERM");

    const state = { pid: 4242, port: 7433, db: "/x/multi-agent.sqlite", startedAt: new Date().toISOString() };
    const alive = await getDaemonStatus(lifecycleDeps({
      fetch: probeFailing("EPERM"),
      exists: (p: string) => p.endsWith("daemon.json"),
      readFile: (p: string) => (p.endsWith("daemon.json") ? JSON.stringify(state) : null),
      isProcessAlive: () => true,
    }));
    expect(alive.state).toBe("running");
    expect(alive.healthy).toBe(false);
    expect(alive.probeErrorCode).toBe("EPERM");
  });
});

describe("offline help guide path (reachable without the daemon)", () => {
  it("prefers the source checkout's docs, then the copy bundled in the package", () => {
    const checkout = "/r/packages/cli/src";
    expect(resolveOfflineHelpPath(checkout, (p) => p === "/r/docs/reference/help.md" || p === "/r/packages/cli/daemon/docs/reference/help.md"))
      .toBe("/r/docs/reference/help.md");
    const installed = "/p/lib/node_modules/@multi-agent/cli/dist";
    expect(resolveOfflineHelpPath(installed, (p) => p === "/p/lib/node_modules/@multi-agent/cli/daemon/docs/reference/help.md"))
      .toBe("/p/lib/node_modules/@multi-agent/cli/daemon/docs/reference/help.md");
    expect(resolveOfflineHelpPath(installed, () => false)).toBeUndefined();
  });

  it("never resolves outside an installed package, even if a file sits there", () => {
    const installed = "/p/lib/node_modules/@multi-agent/cli/dist";
    const outside = "/p/lib/node_modules/docs/reference/help.md";
    const bundled = "/p/lib/node_modules/@multi-agent/cli/daemon/docs/reference/help.md";
    expect(resolveOfflineHelpPath(installed, (p) => p === outside || p === bundled)).toBe(bundled);
    expect(resolveOfflineHelpPath(installed, (p) => p === outside)).toBeUndefined();
  });
});

// Review finding on #504 (measured inside Codex's macOS sandbox): kill(pid, 0) on the daemon returns
// EPERM and `ps` cannot run, so the old boolean liveness said "dead", status said `stale`, and the
// precheck told the seat to start a daemon before any health probe ran.
describe("sandboxed liveness: EPERM on kill(pid, 0) is not a dead daemon", () => {
  const STATE = { pid: 4242, port: 7433, db: "/x/multi-agent.sqlite", startedAt: new Date().toISOString() };
  const withState = (over: Partial<LifecycleDeps>): LifecycleDeps => lifecycleDeps({
    exists: (p: string) => p.endsWith("daemon.json"),
    readFile: (p: string) => (p.endsWith("daemon.json") ? JSON.stringify(STATE) : null),
    ...over,
  });
  // What realDeps' liveness yields in the sandbox: kill(pid, 0) EPERM and no runnable `ps`.
  const sandboxLiveness = (): "unknown" => "unknown";

  it("classifies liveness: only a missing process or a zombie is dead; an uninspectable one is unknown", () => {
    const live = (signal: "sent" | "missing" | "not-permitted", state: string | null) =>
      createProcessLiveness({ signal: () => signal, readProcessState: () => state })(1);
    expect(live("sent", "S")).toBe("alive");
    expect(live("sent", "Z")).toBe("dead");
    expect(live("sent", null)).toBe("unknown");
    expect(live("missing", "S")).toBe("dead");
    expect(live("not-permitted", "S")).toBe("alive");
    expect(live("not-permitted", "Z")).toBe("dead");
    expect(live("not-permitted", null)).toBe("unknown");
  });

  it("maps kill(pid, 0) errors: EPERM is not-permitted, ESRCH is missing", () => {
    const throwing = (code: string) => () => { throw Object.assign(new Error(code), { code }); };
    expect(signalProbe(1, () => true)).toBe("sent");
    expect(signalProbe(1, throwing("EPERM"))).toBe("not-permitted");
    expect(signalProbe(1, throwing("ESRCH"))).toBe("missing");
  });

  it("unknown liveness plus a blocked probe is unverified with EPERM, never stale", async () => {
    const status = await getDaemonStatus(withState({
      isProcessAlive: () => false,
      processLiveness: sandboxLiveness,
      fetch: probeFailing("EPERM"),
    }));
    expect(status.state).not.toBe("stale");
    expect(status.state).toBe("unverified");
    expect(status.probeErrorCode).toBe("EPERM");
  });

  it("unknown liveness plus a refused probe is still a stopped daemon", async () => {
    const status = await getDaemonStatus(withState({
      isProcessAlive: () => false,
      processLiveness: sandboxLiveness,
      fetch: probeFailing("ECONNREFUSED"),
    }));
    expect(status.state).toBe("stopped");
  });

  it("unknown liveness plus a healthy probe is running", async () => {
    const status = await getDaemonStatus(withState({
      isProcessAlive: () => false,
      processLiveness: sandboxLiveness,
      fetch: async () => ({ ok: true }),
    }));
    expect(status.state).toBe("running");
  });

  it("a really dead PID stays stale, with or without the new liveness", async () => {
    const dead = (): "dead" => "dead";
    expect((await getDaemonStatus(withState({ isProcessAlive: () => false, processLiveness: dead }))).state).toBe("stale");
    expect((await getDaemonStatus(withState({ isProcessAlive: () => false }))).state).toBe("stale");
  });
});
