import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createServer } from "node:net";
import { realDeps } from "../src/commands/daemon.js";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  startDaemon,
  stopDaemon,
  getDaemonStatus,
  getDaemonPath,
  resolveDaemonPath,
  buildDaemonEnv,
  STATE_FILE,
  LOOM_DIR,
  type LifecycleDeps,
  type DaemonState,
} from "../src/daemon-lifecycle.js";

/** The daemon log path is internal to the lifecycle module; the start/stop tests only need the file. */
const LOG_PATH = path.join(path.dirname(STATE_FILE), "daemon.log");

afterEach(() => vi.useRealTimers());

function cleanReceipt(pid: number): string {
  const now = new Date().toISOString();
  return JSON.stringify({ schema: "loom.daemon-shutdown/v1", pid, startedAt: now, completedAt: now, outcome: "clean", phase: "complete", failures: [] });
}

function neverFetch(): Promise<{ ok: boolean }> {
  return new Promise(() => {});
}

function startupHealth() {
  return { ok: true, json: async () => ({ pid: 12345, bind: { mode: "explicit", hosts: ["127.0.0.1"] } }) };
}

function mockDeps(overrides?: Partial<LifecycleDeps>): LifecycleDeps {
  const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null as number | null, signalCode: null, unref: vi.fn() });
  return {
    acquireStartLock: () => ({ recordChild: vi.fn(), release: vi.fn() }),
    spawn: vi.fn(() => child as unknown as ChildProcess),
    fetch: vi.fn(async () => ({ ok: true })),
    isPortOccupied: vi.fn(async () => false),
    kill: vi.fn(() => { child.exitCode = 0; child.emit("exit", 0, "SIGTERM"); return true; }),
    readFile: vi.fn(() => null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn(() => false),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => child.exitCode === null),
    ...overrides,
  };
}

function startableDeps(overrides?: Partial<LifecycleDeps>): LifecycleDeps {
  let spawned = false;
  const deps = mockDeps(overrides);
  const spawn = deps.spawn;
  deps.spawn = vi.fn((...args) => { spawned = true; return spawn(...args); });
  deps.fetch = overrides?.fetch ?? vi.fn(async () => {
    if (!spawned) throw new Error("refused");
    return startupHealth();
  });
  return deps;
}

function writtenState(deps: LifecycleDeps): DaemonState {
  const call = (deps.writeFile as ReturnType<typeof vi.fn>).mock.calls.find(
    (c: unknown[]) => (c[0] as string).endsWith("daemon.json")
  );
  if (!call) throw new Error("daemon.json was not written");
  return JSON.parse(call[1] as string) as DaemonState;
}

describe("Daemon Lifecycle", () => {
  // Test 1: start resolves absolute daemon path (not cwd-relative)
  it("getDaemonPath resolves absolute path ending with daemon", () => {
    const daemonPath = getDaemonPath();
    expect(path.isAbsolute(daemonPath)).toBe(true);
    expect(daemonPath).toMatch(/daemon$/);
  });

  // Test 2: start constructs exact spawn command with correct env/redirect
  it("start: constructs spawn with node, daemon entry, env, and log redirect", async () => {
    const deps = startableDeps();
    await startDaemon({ port: 7433, db: "loom.sqlite" }, deps);

    const spawnMock = deps.spawn as ReturnType<typeof vi.fn>;
    expect(spawnMock).toHaveBeenCalledOnce();

    const [cmd, args, opts] = spawnMock.mock.calls[0]!;
    expect(cmd).toBe(process.execPath);
    expect(args[0]).toContain("daemon");
    // The entry is joined for this host, so assert its own spelling rather than a POSIX one.
    expect(args[0]).toContain(path.join("dist", "index.js"));
    expect(opts.env).toMatchObject({
      LOOM_PORT: "7433",
      LOOM_DB: "loom.sqlite",
    });
    expect(opts.detached).toBe(true);
  });

  // Test 3: start waits for healthz, writes daemon.json with pid+port+db+startedAt
  it("start: writes daemon.json with pid, port, db, startedAt after healthz", async () => {
    const deps = startableDeps();
    const result = await startDaemon({ port: 8000, db: "test.sqlite" }, deps);

    expect(result.pid).toBe(12345);
    expect(result.port).toBe(8000);
    expect(result.db).toBe("test.sqlite");
    expect(result.startedAt).toBeDefined();

    const state = writtenState(deps);
    expect(state.pid).toBe(12345);
    expect(state.port).toBe(8000);
    expect(state.db).toBe("test.sqlite");
    expect(state.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // Test 4: start already running -> error
  it("start: already running -> throws error", async () => {
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify({ pid: 99, port: 7433, db: "x.db", startedAt: "2026-01-01T00:00:00Z" });
        return null;
      }),
      isProcessAlive: vi.fn(() => true),
    });

    await expect(startDaemon({}, deps)).rejects.toThrow(/already running/i);
  });

  it("start: recovered running daemon without daemon.json -> throws instead of spawning duplicate", async () => {
    const deps = mockDeps({
      exists: vi.fn(() => false),
      fetch: vi.fn(async (url: string) => {
        expect(url).toBe("http://127.0.0.1:7433/healthz");
        return { ok: true };
      }),
    });

    await expect(startDaemon({}, deps)).rejects.toThrow(/already running/i);
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it("start: no state and a hanging initial probe still starts and verifies its own child", async () => {
    vi.useFakeTimers();
    const deps = startableDeps({ fetch: vi.fn().mockImplementationOnce(neverFetch).mockResolvedValue(startupHealth()) });
    const pending = startDaemon({ port: 7433 }, deps).catch((error) => error as Error);
    await vi.runAllTimersAsync();

    expect(await pending).toMatchObject({ pid: 12345, port: 7433 });
    expect(deps.spawn).toHaveBeenCalledOnce();
    expect(deps.fetch).toHaveBeenCalledTimes(3); // initial probe, child identity, listener
    expect(writtenState(deps).pid).toBe(12345);
    expect(deps.kill).not.toHaveBeenCalled();
  });

  it("start: a timed-out no-state probe on an occupied port refuses before any initialization", async () => {
    vi.useFakeTimers();
    const deps = mockDeps({ fetch: vi.fn(neverFetch), isPortOccupied: vi.fn(async () => true) });
    const pending = startDaemon({ port: 17433, host: "127.0.0.2" }, deps).catch((error) => error as Error);
    await vi.runAllTimersAsync();
    expect((await pending).message).toMatch(/EADDRINUSE.*port 17433/);
    expect((await pending).message).toContain("--port <unused-port>");
    expect(deps.isPortOccupied).toHaveBeenCalledWith("127.0.0.2", 17433);
    expect(deps.spawn).not.toHaveBeenCalled();
    expect(deps.mkdirp).not.toHaveBeenCalled();
    expect(deps.writeFile).not.toHaveBeenCalled();
    expect(deps.openForAppend).not.toHaveBeenCalled();
    expect(deps.kill).not.toHaveBeenCalled();
  });

  it("start: an immediate connection refusal does not bind-probe the port", async () => {
    const deps = startableDeps();
    await startDaemon({}, deps);
    expect(deps.isPortOccupied).not.toHaveBeenCalled();
    expect(deps.spawn).toHaveBeenCalledOnce();
  });

  it("start: reads only this launch's log bytes when its child exits", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null as number | null, signalCode: null, unref: vi.fn() });
    const deps = mockDeps({
      fetch: vi.fn().mockRejectedValue(new Error("refused")),
      fileSize: vi.fn(() => 1_000_000),
      readFile: vi.fn((p: string) => { if (p === LOG_PATH) throw new Error("whole log read"); return null; }),
      readFileFrom: vi.fn(() => "Error: listen EADDRINUSE\n"),
      spawn: vi.fn(() => {
        setTimeout(() => { child.exitCode = 1; child.emit("exit", 1, null); }, 1);
        return child as unknown as ChildProcess;
      }),
    });
    const pending = startDaemon({}, deps).catch((error) => error as Error);
    await vi.runAllTimersAsync();
    expect((await pending).message).toContain("EADDRINUSE");
    expect(deps.fileSize).toHaveBeenCalledWith(LOG_PATH);
    expect(deps.readFileFrom).toHaveBeenCalledWith(LOG_PATH, 1_000_000);
  });

  it("start: a bind failure after a hanging initial probe reports the occupied port without publishing state", async () => {
    vi.useFakeTimers();
    let log = "Earlier daemon log\n";
    const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null as number | null, signalCode: null, unref: vi.fn() });
    const deps = mockDeps({
      fetch: vi.fn(neverFetch),
      readFile: vi.fn((p: string) => p === LOG_PATH ? log : null),
      spawn: vi.fn(() => {
        setTimeout(() => {
          log += "Error: listen EADDRINUSE: address already in use 127.0.0.1:7433\n";
          child.exitCode = 1;
          child.emit("exit", 1, null);
        }, 1);
        return child as unknown as ChildProcess;
      }),
    });
    const pending = startDaemon({ port: 7433 }, deps).catch((error) => error as Error);
    await vi.runAllTimersAsync();
    const error = await pending;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/EADDRINUSE.*port 7433/);
    expect(error.message).toContain("--port <unused-port>");
    expect(deps.writeFile).not.toHaveBeenCalledWith(STATE_FILE, expect.anything());
    expect(deps.kill).not.toHaveBeenCalled();
  });

  it("start: an old bind error is not attributed to a new child's unrelated exit", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null as number | null, signalCode: null, unref: vi.fn() });
    const deps = mockDeps({
      fetch: vi.fn().mockRejectedValue(new Error("refused")),
      readFile: vi.fn((p: string) => p === LOG_PATH ? "Old error: EADDRINUSE\n" : null),
      spawn: vi.fn(() => {
        setTimeout(() => { child.exitCode = 1; child.emit("exit", 1, null); }, 1);
        return child as unknown as ChildProcess;
      }),
    });
    const pending = startDaemon({}, deps).catch((error) => error as Error);
    await vi.runAllTimersAsync();
    const error = await pending;

    expect(error.message).toMatch(/exited before startup completed/);
    expect(error.message).not.toContain("EADDRINUSE");
    expect(error.message).toContain(LOG_PATH);
  });

  it("start: a real held loopback port prevents spawning after the no-state timeout", async () => {
    const listener = createServer();
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    try {
      const port = (listener.address() as { port: number }).port;
      const deps = startableDeps({
        fetch: vi.fn().mockImplementationOnce(neverFetch).mockResolvedValue(startupHealth()),
        isPortOccupied: realDeps().isPortOccupied,
      });
      await expect(startDaemon({ port }, deps)).rejects.toThrow(/EADDRINUSE/);
      expect(deps.spawn).not.toHaveBeenCalled();
      expect(deps.mkdirp).not.toHaveBeenCalled();
      expect(deps.writeFile).not.toHaveBeenCalled();
      expect(listener.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("exclusive bind releases a free port and treats other bind failures as indeterminate", async () => {
    const deps = realDeps();
    const listener = createServer();
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    expect(await deps.isPortOccupied!("127.0.0.1", port)).toBe(false);
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(port, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    expect(await deps.isPortOccupied!("203.0.113.1", port)).toBe(false); // EADDRNOTAVAIL
    expect(await deps.isPortOccupied!("127.0.0.1", -1)).toBe(false); // synchronous bind error
  });

  it("production log reads use a byte offset, preserve old-error absence and handle truncation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loom-start-log-"));
    const log = path.join(root, "daemon.log");
    const deps = realDeps();
    try {
      fs.writeFileSync(log, "Older 🐢 EADDRINUSE\n".repeat(10_000));
      const offset = deps.fileSize!(log);
      expect(offset).toBe(fs.statSync(log).size);
      expect(deps.readFileFrom!(log, offset)).toBe("");
      const appended = "New 🐢 unrelated failure\n";
      fs.appendFileSync(log, appended);
      const read = vi.spyOn(fs, "readSync");
      try {
        expect(deps.readFileFrom!(log, offset)).toBe(appended);
        expect(read).toHaveBeenCalledWith(expect.any(Number), expect.any(Buffer), 0, Buffer.byteLength(appended), offset);
      } finally { read.mockRestore(); }
      fs.writeFileSync(log, "New EADDRINUSE\n");
      expect(deps.readFileFrom!(log, offset)).toBe("New EADDRINUSE\n");
      expect(deps.fileSize!(path.join(root, "absent"))).toBe(0);
      expect(deps.readFileFrom!(path.join(root, "absent"), 0)).toBeNull();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  // Test 5: stop reads pid from daemon.json, sends SIGTERM, removes daemon.json
  it("stop: reads pid, sends SIGTERM, removes daemon.json", async () => {
    const state: DaemonState = { pid: 555, port: 7433, db: "loom.sqlite", startedAt: "2026-01-01T00:00:00Z" };
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(state);
        return p.endsWith("daemon-shutdown.json") ? cleanReceipt(555) : null;
      }),
      fetch: vi.fn().mockResolvedValueOnce({ ok: true }).mockRejectedValue(new Error("refused")),
      isProcessAlive: vi.fn()
        .mockReturnValueOnce(true)   // first check: alive
        .mockReturnValueOnce(false), // after kill: dead
    });

    await stopDaemon(deps);

    expect(deps.kill).toHaveBeenCalledWith(555, "SIGTERM");
    expect(deps.removeFile).toHaveBeenCalledWith(STATE_FILE);
  });

  // Test 6: stop not running -> clean message (no throw)
  it("stop: not running -> does not throw", async () => {
    const deps = mockDeps({
      exists: vi.fn(() => false),
      fetch: vi.fn(async () => { throw new Error("refused"); }),
    });

    // Should not throw
    await expect(stopDaemon(deps)).resolves.toBe("no-target");
  });

  it("stop: recovered running daemon without daemon.json -> throws honest error", async () => {
    const deps = mockDeps({
      exists: vi.fn(() => false),
      fetch: vi.fn(async (url: string) => {
        expect(url).toBe("http://127.0.0.1:7433/healthz");
        return { ok: true };
      }),
    });

    await expect(stopDaemon(deps)).rejects.toThrow(/state is missing|cannot stop safely/i);
    expect(deps.kill).not.toHaveBeenCalled();
  });

  // Test 7: status reads port from daemon.json, reports running with port
  it("status: running daemon (pid alive + healthz ok) -> { state: 'running', port, pid }", async () => {
    const state: DaemonState = { pid: 777, port: 9000, db: "x.db", startedAt: "2026-01-01T00:00:00Z" };
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(state);
        return null;
      }),
      isProcessAlive: vi.fn(() => true),
      fetch: vi.fn(async () => ({ ok: true })),
    });

    const status = await getDaemonStatus(deps);
    expect(status.state).toBe("running");
    expect(status.port).toBe(9000);
    expect(status.pid).toBe(777);
    // Must have checked healthz
    expect(deps.fetch).toHaveBeenCalledWith("http://127.0.0.1:9000/healthz");
  });

  // Test 8: status stopped (no daemon.json) -> reports stopped
  it("status: no daemon.json -> { state: 'stopped' }", async () => {
    const deps = mockDeps({
      exists: vi.fn(() => false),
      fetch: vi.fn(async () => { throw new Error("refused"); }),
    });

    const status = await getDaemonStatus(deps);
    expect(status.state).toBe("stopped");
  });

  // OPR.0.4.2.1 — the daemon-status probe must settle a transient /healthz failure across the
  // post-restart listener bind window (bounded retry) and report the ACTUAL /healthz answer,
  // not a false 'down'/'unhealthy'. Repro (RED) + regression guards (must not mask a genuine down).
  it("OPR.0.4.2.1 status: pid alive, probe fails once then /healthz answers -> running + healthy (bind window settles)", async () => {
    const state: DaemonState = { pid: 777, port: 9000, db: "x.db", startedAt: "2026-01-01T00:00:00Z" };
    let calls = 0;
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => (p === STATE_FILE ? JSON.stringify(state) : null)),
      isProcessAlive: vi.fn(() => true),
      sleep: async () => {},
      fetch: vi.fn(async () => {
        calls++;
        if (calls === 1) throw new Error("connect ECONNREFUSED"); // listener not yet accepting
        return { ok: true };
      }),
    });
    const status = await getDaemonStatus(deps);
    expect(status.state).toBe("running");
    expect(status.healthy).toBe(true); // settled to the real answer, not a transient false-negative
    expect((deps.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2); // retried
  });

  it("OPR.0.4.2.1 status: no daemon.json, probe fails once then /healthz answers -> running, not stopped", async () => {
    let calls = 0;
    const deps = mockDeps({
      exists: vi.fn(() => false),
      sleep: async () => {},
      fetch: vi.fn(async () => { calls++; if (calls === 1) throw new Error("ECONNREFUSED"); return { ok: true }; }),
    });
    const status = await getDaemonStatus(deps);
    expect(status.state).toBe("running"); // NOT a false "stopped"
  });

  it("OPR.0.4.2.1 regression: genuine down (probe always fails, no state) -> stopped after HARD-BOUNDED retries", async () => {
    let calls = 0;
    const deps = mockDeps({
      exists: vi.fn(() => false),
      sleep: async () => {},
      fetch: vi.fn(async () => { calls++; throw new Error("ECONNREFUSED"); }),
    });
    const status = await getDaemonStatus(deps);
    expect(status.state).toBe("stopped"); // bounded budget expires -> honestly stopped, never masked
    expect(calls).toBeLessThanOrEqual(8); // hard cap — no unbounded hammering / hang
  });

  it("OPR.0.4.2.1 regression: pid alive but healthz never answers -> running + healthy:false (no false healthy)", async () => {
    const state: DaemonState = { pid: 777, port: 9000, db: "x.db", startedAt: "2026-01-01T00:00:00Z" };
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => (p === STATE_FILE ? JSON.stringify(state) : null)),
      isProcessAlive: vi.fn(() => true),
      sleep: async () => {},
      fetch: vi.fn(async () => { throw new Error("refused"); }),
    });
    const status = await getDaemonStatus(deps);
    expect(status.state).toBe("running"); // pid alive
    expect(status.healthy).toBe(false); // never answered -> honestly unhealthy, not falsely healthy
  });

  it("status: no daemon.json but configured healthz responds -> running without pid", async () => {
    const savedPort = process.env["LOOM_PORT"];
    const savedHost = process.env["LOOM_HOST"];
    process.env["LOOM_PORT"] = "7555";
    process.env["LOOM_HOST"] = "127.0.0.1";
    try {
      const deps = mockDeps({
        exists: vi.fn(() => false),
        fetch: vi.fn(async (url: string) => {
          expect(url).toBe("http://127.0.0.1:7555/healthz");
          return { ok: true };
        }),
      });

      const status = await getDaemonStatus(deps);
      expect(status).toEqual({
        state: "running",
        host: "127.0.0.1",
        port: 7555,
        healthy: true,
      });
    } finally {
      if (savedPort === undefined) delete process.env["LOOM_PORT"];
      else process.env["LOOM_PORT"] = savedPort;
      if (savedHost === undefined) delete process.env["LOOM_HOST"];
      else process.env["LOOM_HOST"] = savedHost;
    }
  });

  // A status read must preserve target identity when its shutdown is unverified.
  it("status: stale with no shutdown receipt -> preserves unverified target", async () => {
    const state: DaemonState = { pid: 888, port: 7433, db: "x.db", startedAt: "2026-01-01T00:00:00Z" };
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(state);
        return null;
      }),
      isProcessAlive: vi.fn(() => false),
    });

    const status = await getDaemonStatus(deps);
    expect(status.state).toBe("stale");
    expect(deps.removeFile).not.toHaveBeenCalled();
  });

  // Test 10: start --port flag stored in daemon.json and forwarded to env
  it("start: custom port stored in daemon.json and forwarded to spawn env", async () => {
    const deps = startableDeps();
    await startDaemon({ port: 9999 }, deps);

    const state = writtenState(deps);
    expect(state.port).toBe(9999);

    const spawnMock = deps.spawn as ReturnType<typeof vi.fn>;
    const env = spawnMock.mock.calls[0]![2].env;
    expect(env.LOOM_PORT).toBe("9999");
  });

  // Test 11: start invoked from different cwd -> still resolves correct daemon path
  it("getDaemonPath is stable regardless of cwd", () => {
    const path1 = getDaemonPath();
    // Simulate different cwd by just proving the path is absolute and based on import.meta
    // (cwd doesn't affect path.resolve from import.meta.dirname)
    expect(path.isAbsolute(path1)).toBe(true);
    expect(path1).toContain("daemon");
  });

  it("daemonCommand stop surfaces missing-state recovery error instead of claiming success", async () => {
    const { daemonCommand } = await import("../src/commands/daemon.js");
    const { Command } = await import("commander");
    const deps = mockDeps({
      exists: vi.fn(() => false),
      fetch: vi.fn(async () => ({ ok: true })),
    });

    const program = new Command();
    program.addCommand(daemonCommand(deps));

    const logs: string[] = [];
    const origErr = console.error;
    const savedExitCode = process.exitCode;
    process.exitCode = undefined;
    console.error = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      await program.parseAsync(["node", "loom", "daemon", "stop"]);
    } finally {
      console.error = origErr;
    }

    expect(logs.join("\n")).toMatch(/state is missing|cannot stop safely/i);
    expect(process.exitCode).toBe(1);
    process.exitCode = savedExitCode;
  });

  it("S4b RED: daemon stop refuses success when the addressed LOOM_URL listener is still up", async () => {
    const { daemonCommand } = await import("../src/commands/daemon.js");
    const { Command } = await import("commander");
    const savedUrl = process.env.LOOM_URL;
    const savedExitCode = process.exitCode;
    process.env.LOOM_URL = "http://127.0.0.1:7555";
    process.exitCode = undefined;
    const state: DaemonState = { pid: 555, port: 7433, db: "loom.sqlite", startedAt: "2026-01-01T00:00:00Z" };
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => p === STATE_FILE ? JSON.stringify(state) : null),
      isProcessAlive: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false),
      fetch: vi.fn(async () => ({ ok: true })),
    });
    const program = new Command();
    program.addCommand(daemonCommand(deps));
    const out: string[] = [];
    const err: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args: unknown[]) => out.push(args.join(" "));
    console.error = (...args: unknown[]) => err.push(args.join(" "));
    try {
      await program.parseAsync(["node", "loom", "daemon", "stop"]);
      expect(process.exitCode).toBe(1);
      expect(out.join("\n")).not.toContain("Daemon stopped");
      expect(err.join("\n")).toContain("http://127.0.0.1:7555");
      expect(err.join("\n")).toMatch(/healthz|health check/i);
      expect(err.join("\n")).toMatch(/does not match.*no signal sent/i);
      expect(deps.kill).not.toHaveBeenCalled();
    } finally {
      console.log = origLog;
      console.error = origErr;
      process.exitCode = savedExitCode;
      if (savedUrl === undefined) delete process.env.LOOM_URL;
      else process.env.LOOM_URL = savedUrl;
    }
  });

  it("S4b RED: a daemon that ignores SIGTERM reports the target, health check, and still-listening effect", async () => {
    vi.useFakeTimers();
    const { daemonCommand } = await import("../src/commands/daemon.js");
    const { Command } = await import("commander");
    const savedUrl = process.env.LOOM_URL;
    const savedExitCode = process.exitCode;
    process.env.LOOM_URL = "http://127.0.0.1:7555";
    process.exitCode = undefined;
    const state: DaemonState = { pid: 555, port: 7555, db: "loom.sqlite", startedAt: "2026-01-01T00:00:00Z" };
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => p === STATE_FILE ? JSON.stringify(state) : null),
      isProcessAlive: vi.fn(() => true),
      fetch: vi.fn(async () => ({ ok: true })),
    });
    const program = new Command();
    program.addCommand(daemonCommand(deps));
    const out: string[] = [];
    const err: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args: unknown[]) => out.push(args.join(" "));
    console.error = (...args: unknown[]) => err.push(args.join(" "));
    try {
      const stop = program.parseAsync(["node", "loom", "daemon", "stop"]);
      await vi.runAllTimersAsync();
      await stop;
      expect(process.exitCode).toBe(1);
      expect(out.join("\n")).not.toContain("Daemon stopped");
      expect(err.join("\n")).toContain("http://127.0.0.1:7555");
      expect(err.join("\n")).toMatch(/healthz|health check/i);
      expect(err.join("\n")).toMatch(/still listening/i);
    } finally {
      console.log = origLog;
      console.error = origErr;
      vi.useRealTimers();
      process.exitCode = savedExitCode;
      if (savedUrl === undefined) delete process.env.LOOM_URL;
      else process.env.LOOM_URL = savedUrl;
    }
  });

  it("S4b RED: daemon stop prints success only after the addressed target verifies down", async () => {
    const { daemonCommand } = await import("../src/commands/daemon.js");
    const { Command } = await import("commander");
    const savedUrl = process.env.LOOM_URL;
    const savedExitCode = process.exitCode;
    process.env.LOOM_URL = "http://127.0.0.1:7555";
    process.exitCode = undefined;
    const state: DaemonState = { pid: 555, port: 7555, db: "loom.sqlite", startedAt: "2026-01-01T00:00:00Z" };
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => p === STATE_FILE ? JSON.stringify(state) : p.endsWith("daemon-shutdown.json") ? cleanReceipt(555) : null),
      isProcessAlive: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false),
      fetch,
    });
    const program = new Command();
    program.addCommand(daemonCommand(deps));
    const out: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => out.push(args.join(" "));
    try {
      await program.parseAsync(["node", "loom", "daemon", "stop"]);
      expect(process.exitCode).toBeUndefined();
      expect(out.join("\n")).toContain("Daemon stopped");
      expect(fetch.mock.calls.length).toBeGreaterThan(1);
      expect(fetch).toHaveBeenLastCalledWith("http://127.0.0.1:7555/healthz");
    } finally {
      console.log = origLog;
      process.exitCode = savedExitCode;
      if (savedUrl === undefined) delete process.env.LOOM_URL;
      else process.env.LOOM_URL = savedUrl;
    }
  });

  // Test 15: start creates ~/.loom directory if missing
  it("start: creates LOOM_DIR if missing", async () => {
    const deps = startableDeps();
    await startDaemon({ port: 7433 }, deps);

    expect(deps.mkdirp).toHaveBeenCalledWith(LOOM_DIR);
  });

  // Test 17: pid alive + healthz failure -> running with healthy=false, daemon.json preserved
  it("status: pid alive but healthz fails -> running, healthy=false, state preserved", async () => {
    const state: DaemonState = { pid: 999, port: 7433, db: "x.db", startedAt: "2026-01-01T00:00:00Z" };
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(state);
        return null;
      }),
      isProcessAlive: vi.fn(() => true),
      fetch: vi.fn(async () => { throw new Error("connection refused"); }),
    });

    const status = await getDaemonStatus(deps);
    expect(status.state).toBe("running");
    expect(status.healthy).toBe(false);
    expect(status.pid).toBe(999);
    expect(status.port).toBe(7433);
    // daemon.json must NOT be deleted — stop still needs the pid
    expect(deps.removeFile).not.toHaveBeenCalled();
  });

  it("status: hanging healthz probe resolves boundedly as unhealthy instead of hanging forever", async () => {
    vi.useFakeTimers();
    const state: DaemonState = { pid: 999, port: 7433, db: "x.db", startedAt: "2026-01-01T00:00:00Z" };
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(state);
        return null;
      }),
      isProcessAlive: vi.fn(() => true),
      fetch: vi.fn(() => neverFetch()),
    });

    const statusPromise = getDaemonStatus(deps);
    await vi.runAllTimersAsync();
    const status = await statusPromise;

    expect(status.state).toBe("running");
    expect(status.healthy).toBe(false);
    vi.useRealTimers();
  });

  // Test 18: stop with process that won't die -> throws, daemon.json preserved
  it("stop: process survives SIGTERM -> throws, daemon.json NOT removed", async () => {
    const state: DaemonState = { pid: 111, port: 7433, db: "x.db", startedAt: "2026-01-01T00:00:00Z" };
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(state);
        return null;
      }),
      isProcessAlive: vi.fn(() => true), // never dies
    });

    await expect(stopDaemon(deps)).rejects.toThrow(/did not exit/i);
    expect(deps.kill).toHaveBeenCalledWith(111, "SIGTERM");
    // daemon.json must NOT be deleted — process is still running
    expect(deps.removeFile).not.toHaveBeenCalled();
  });

  // Test 19: start with stale PID (pid alive but healthz fails) -> allows start (PID reuse safety)
  it("start: stale PID (alive but not rig) -> proceeds to start new daemon", async () => {
    const state: DaemonState = { pid: 999, port: 7433, db: "x.db", startedAt: "2026-01-01T00:00:00Z" };
    let fetchCount = 0;
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(state);
        return null;
      }),
      isProcessAlive: vi.fn(() => true),
      // First fetch (verify existing PID): fails -> stale PID
      // Subsequent fetches (healthz poll for new daemon): succeed
      fetch: vi.fn(async () => {
        fetchCount++;
        if (fetchCount === 1) throw new Error("connection refused");
        return startupHealth();
      }),
    });

    const result = await startDaemon({ port: 7433 }, deps);
    expect(result.pid).toBe(12345); // new daemon spawned
  });

  it("start: hanging healthz probe on existing pid throws unresponsive error instead of spawning a second daemon", async () => {
    vi.useFakeTimers();
    const state: DaemonState = { pid: 999, port: 7433, db: "x.db", startedAt: "2026-01-01T00:00:00Z" };
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(state);
        return null;
      }),
      isProcessAlive: vi.fn(() => true),
      fetch: vi.fn(() => neverFetch()),
    });

    const startPromise = startDaemon({ port: 7433 }, deps).catch((error) => error as Error);
    await vi.runAllTimersAsync();
    const error = await startPromise;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/unresponsive/i);
    expect(deps.spawn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  // A reused PID must receive no signal and must not erase unresolved stop identity.
  it("stop: stale PID (alive but not rig) -> preserves state, does not kill", async () => {
    const state: DaemonState = { pid: 999, port: 7433, db: "x.db", startedAt: "2026-01-01T00:00:00Z" };
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(state);
        return null;
      }),
      isProcessAlive: vi.fn(() => true),
      fetch: vi.fn(async () => { throw new Error("connection refused"); }),
    });

    await expect(stopDaemon(deps)).rejects.toThrow(/identity is not confirmed/);
    expect(deps.kill).not.toHaveBeenCalled();
    expect(deps.removeFile).not.toHaveBeenCalled();
  });

  it("stop: hanging healthz probe still issues SIGTERM and reports the unavailable final probe", async () => {
    vi.useFakeTimers();
    const state: DaemonState = { pid: 999, port: 7433, db: "x.db", startedAt: "2026-01-01T00:00:00Z" };
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(state);
        return null;
      }),
      isProcessAlive: vi.fn()
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false),
      fetch: vi.fn(() => neverFetch()),
    });

    const stopPromise = expect(stopDaemon(deps)).rejects.toThrow(/unverified.*listener unavailable/i);
    await vi.runAllTimersAsync();
    await stopPromise;

    expect(deps.kill).toHaveBeenCalledWith(999, "SIGTERM");
    expect(deps.removeFile).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  // Test 21: malformed daemon.json -> treated as stopped, no crash
  it("malformed daemon.json -> getDaemonStatus returns stopped", async () => {
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return "NOT VALID JSON {{{";
        return null;
      }),
      fetch: vi.fn(async () => { throw new Error("refused"); }),
    });

    const status = await getDaemonStatus(deps);
    expect(status.state).toBe("stopped");
  });

  // Test 22: malformed daemon.json -> startDaemon proceeds (treats as no state)
  it("malformed daemon.json -> startDaemon proceeds normally", async () => {
    const deps = startableDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return "GARBAGE";
        return null;
      }),
    });

    const result = await startDaemon({ port: 7433 }, deps);
    expect(result.pid).toBe(12345);
  });

  // Test 23: start with unhealthy loom daemon (healthz responds non-ok) -> blocks start
  it("start: unhealthy loom daemon (healthz responds) -> throws already running", async () => {
    const state: DaemonState = { pid: 999, port: 7433, db: "x.db", startedAt: "2026-01-01T00:00:00Z" };
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(state);
        return null;
      }),
      isProcessAlive: vi.fn(() => true),
      // healthz responds (even if not ok) → port is ours → rig
      fetch: vi.fn(async () => ({ ok: false })),
    });

    await expect(startDaemon({ port: 7433 }, deps)).rejects.toThrow(/already running/i);
  });

  // Test 24: stop with unhealthy loom daemon -> still sends SIGTERM (it's our process)
  it("stop: unhealthy loom daemon -> sends SIGTERM", async () => {
    const state: DaemonState = { pid: 999, port: 7433, db: "x.db", startedAt: "2026-01-01T00:00:00Z" };
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(state);
        return p.endsWith("daemon-shutdown.json") ? cleanReceipt(999) : null;
      }),
      isProcessAlive: vi.fn()
        .mockReturnValueOnce(true)  // checkPid: alive
        .mockReturnValueOnce(false), // after kill: dead
      // healthz responds (non-ok) → still rig
      fetch: vi.fn().mockResolvedValueOnce({ ok: false }).mockRejectedValue(new Error("refused")),
    });

    await stopDaemon(deps);
    expect(deps.kill).toHaveBeenCalledWith(999, "SIGTERM");
    expect(deps.removeFile).toHaveBeenCalledWith(STATE_FILE);
  });

  // Test 25: start spawns process.execPath, not bare "node"
  it("start: spawns process.execPath as the Node binary", async () => {
    const deps = startableDeps();
    await startDaemon({ port: 7433, db: "loom.sqlite" }, deps);

    const spawnMock = deps.spawn as ReturnType<typeof vi.fn>;
    const [cmd] = spawnMock.mock.calls[0]!;
    expect(cmd).toBe(process.execPath);
  });

  it("start: surfaces native module runtime mismatch inline when healthz never comes up", async () => {
    vi.useFakeTimers();
    const deps = mockDeps({
      fetch: vi.fn(async () => { throw new Error("connection refused"); }),
      readFile: vi.fn((p: string) => {
        if (p === LOG_PATH) {
          return [
            "Error: The module '/tmp/better_sqlite3.node'",
            "was compiled against a different Node.js version using",
            "NODE_MODULE_VERSION 127. This version of Node.js requires",
            "NODE_MODULE_VERSION 141. Please try re-compiling or re-installing",
            "the module (for instance, using `npm rebuild` or `npm install`).",
            "code: 'ERR_DLOPEN_FAILED'",
          ].join("\n");
        }
        return null;
      }),
    });

    const startPromise = startDaemon({ port: 7433 }, deps).catch((error) => error as Error);
    await vi.runAllTimersAsync();
    const error = await startPromise;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/better-sqlite3|native module|node/i);
    expect(error.message).toContain(process.version);
    expect(error.message).toContain(process.execPath);
    vi.useRealTimers();
  });

  it("start: surfaces the recent daemon log line when startup crashes for another reason", async () => {
    vi.useFakeTimers();
    const deps = mockDeps({
      fetch: vi.fn(async () => { throw new Error("connection refused"); }),
      readFile: vi.fn((p: string) => {
        if (p === LOG_PATH) {
          return [
            "Booting daemon...",
            "Error: SQLite schema migration failed: disk full",
          ].join("\n");
        }
        return null;
      }),
    });

    const startPromise = startDaemon({ port: 7433 }, deps).catch((error) => error as Error);
    await vi.runAllTimersAsync();
    const error = await startPromise;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/disk full/i);
    vi.useRealTimers();
  });

  // Test 26: LOOM_URL set → getDaemonStatus bypasses daemon.json
  it("status: LOOM_URL set → probes URL directly, ignores daemon.json", async () => {
    const prev = process.env["LOOM_URL"];
    process.env["LOOM_URL"] = "http://127.0.0.1:7455";
    try {
      const deps = mockDeps({
        exists: vi.fn(() => false),
        readFile: vi.fn(() => null),
        fetch: vi.fn(async () => ({ ok: true })),
      });

      const status = await getDaemonStatus(deps);
      expect(status.state).toBe("running");
      expect(status.port).toBe(7455);
      expect(status.healthy).toBe(true);
      // daemon.json was never read
      expect(deps.readFile).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env["LOOM_URL"];
      else process.env["LOOM_URL"] = prev;
    }
  });

  // Test 27: LOOM_URL set but unreachable → stopped
  it("status: LOOM_URL set but unreachable → stopped", async () => {
    const prev = process.env["LOOM_URL"];
    process.env["LOOM_URL"] = "http://127.0.0.1:9999";
    try {
      const deps = mockDeps({
        exists: vi.fn(() => false),
        readFile: vi.fn(() => null),
        fetch: vi.fn(async () => { throw new Error("connection refused"); }),
      });

      const status = await getDaemonStatus(deps);
      expect(status.state).toBe("stopped");
    } finally {
      if (prev === undefined) delete process.env["LOOM_URL"];
      else process.env["LOOM_URL"] = prev;
    }
  });

  it("createIsProcessAlive treats zombie processes as dead", async () => {
    const { createIsProcessAlive } = await import("../src/commands/daemon.js");
    const isAlive = createIsProcessAlive({
      signalCheck: () => true,
      readProcessState: () => "Z",
    });

    expect(isAlive(123)).toBe(false);
  });

  it("createIsProcessAlive keeps non-zombie processes alive", async () => {
    const { createIsProcessAlive } = await import("../src/commands/daemon.js");
    const isAlive = createIsProcessAlive({
      signalCheck: () => true,
      readProcessState: () => "S",
    });

    expect(isAlive(123)).toBe(true);
  });

  it("readProcessState reads the ps state column on POSIX", async () => {
    const { readProcessState } = await import("../src/commands/daemon.js");
    const calls: Array<{ file: string; args: string[] }> = [];
    const state = readProcessState(123, "linux", (file, args) => {
      calls.push({ file, args });
      return "S\n";
    });

    expect(state).toBe("S\n");
    expect(calls).toEqual([{ file: "ps", args: ["-o", "state=", "-p", "123"] }]);
  });

  it("readProcessState returns null on POSIX when ps fails", async () => {
    const { readProcessState } = await import("../src/commands/daemon.js");
    const state = readProcessState(123, "darwin", () => {
      throw new Error("no such process");
    });

    expect(state).toBeNull();
  });

  it("readProcessState does not shell out to ps on Windows", async () => {
    const { readProcessState, createIsProcessAlive } = await import("../src/commands/daemon.js");
    const run = () => {
      throw new Error("ps must not run on win32");
    };

    expect(readProcessState(123, "win32", run)).toBe("R");
    const isAlive = createIsProcessAlive({
      signalCheck: () => true,
      readProcessState: (pid) => readProcessState(pid, "win32", run),
    });
    expect(isAlive(123)).toBe(true);
  });
});

describe("resolveDaemonPath", () => {
  // QA BLOCKING qitem-20260518054224 — the resolver previously preferred
  // the bundled (vendored) copy, so monorepo dev workflows ran a stale
  // packaged daemon when packages/cli/daemon hadn't been re-assembled
  // via scripts/build-package.sh. After the fix the resolver prefers
  // the monorepo source (packages/daemon) when present, ensuring
  // `node packages/cli/dist/bin-wrapper.js daemon start` always
  // launches the daemon source-of-truth in development.

  it("returns monorepo source path when packages/daemon/dist/index.js exists (DEV — both paths present)", () => {
    // Simulates a monorepo checkout: BOTH paths have dist/index.js
    // (vendored bundle assembled via scripts/build-package.sh + source
    // daemon built via @loom/daemon). The resolver picks source.
    const exists = (p: string) => p.endsWith("daemon/dist/index.js");
    const result = resolveDaemonPath("/repo/packages/cli/dist", exists);
    expect(result).toBe(path.resolve("/repo/packages/cli/dist", "../../daemon"));
  });

  it("falls back to bundled path when only ../daemon/dist exists (NPM-INSTALL — single path)", () => {
    // Simulates `npm install -g @loom/cli` layout:
    //   node_modules/@loom/cli/{dist,daemon,ui}
    // Only ../daemon (sibling to cli/dist) exists; ../../daemon doesn't.
    const exists = (p: string) => {
      // monorepo path absent; bundled present
      if (p === path.resolve("/install/cli/dist", "../../daemon", "dist/index.js")) return false;
      if (p === path.resolve("/install/cli/dist", "../daemon", "dist/index.js")) return true;
      return false;
    };
    const result = resolveDaemonPath("/install/cli/dist", exists);
    expect(result).toBe(path.resolve("/install/cli/dist", "../daemon"));
  });

  it("returns the monorepo path even when nothing exists, so callers can surface a clear error", () => {
    const exists = () => false;
    const result = resolveDaemonPath("/repo/packages/cli/dist", exists);
    expect(result).toBe(path.resolve("/repo/packages/cli/dist", "../../daemon"));
  });
});

describe("startDaemon env sanitization", () => {
  it("startDaemon preserves the Codex config root while excluding transient CODEX runtime/session vars", async () => {
    // Pollute process.env temporarily
    const saved: Record<string, string | undefined> = {};
    const pollutants: Record<string, string> = {
      GHOSTTY_BIN_DIR: "/bad",
      TERM_PROGRAM: "ghostty",
      CMUX_WORKSPACE: "workspace:1",
      CMUX_PANEL_ID: "panel:7",
      CMUX_BUNDLED_CLI_PATH: "/Applications/cmux.app/Contents/Resources/bin/cmux",
      CODEX_HOME: "/Users/tester/.codex-custom",
      CODEX_CI: "1",
      CODEX_THREAD_ID: "thread-123",
      COMMAND_MODE: "unix2003",
      __CFBundleIdentifier: "com.test",
    };
    for (const [k, v] of Object.entries(pollutants)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }

    try {
      const deps = startableDeps();
      await startDaemon({ port: 7433, host: "127.0.0.1", db: "/tmp/test.db" }, deps);

      const spawnCall = (deps.spawn as ReturnType<typeof vi.fn>).mock.calls[0];
      const spawnEnv = spawnCall![2].env as Record<string, string>;

      // Scrubbed vars must NOT be in spawn env
      expect(spawnEnv["GHOSTTY_BIN_DIR"]).toBeUndefined();
      expect(spawnEnv["TERM_PROGRAM"]).toBeUndefined();
      expect(spawnEnv["CMUX_WORKSPACE"]).toBeUndefined();
      expect(spawnEnv["CODEX_CI"]).toBeUndefined();
      expect(spawnEnv["CODEX_THREAD_ID"]).toBeUndefined();
      expect(spawnEnv["COMMAND_MODE"]).toBeUndefined();
      expect(spawnEnv["__CFBundleIdentifier"]).toBeUndefined();

      // cmux context needed for workspace-bound commands should survive
      expect(spawnEnv["CMUX_PANEL_ID"]).toBe("panel:7");
      expect(spawnEnv["CMUX_BUNDLED_CLI_PATH"]).toBe("/Applications/cmux.app/Contents/Resources/bin/cmux");

      // Core vars must be present
      expect(spawnEnv["HOME"]).toBeDefined();
      // CODEX_HOME is topology/config-root state consumed by the daemon; unlike
      // every other CODEX_* runtime/auth/session value, it must cross this boundary.
      expect(spawnEnv["CODEX_HOME"]).toBe("/Users/tester/.codex-custom");
      expect(spawnEnv["LOOM_PORT"]).toBe("7433");
    } finally {
      // Restore process.env
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("buildDaemonEnv", () => {
  it("preserves only CODEX_HOME because it is topology/config-root state", () => {
    const result = buildDaemonEnv({
      CODEX_HOME: "/Users/tester/.codex-custom",
      CODEX_CI: "1",
      CODEX_THREAD_ID: "thread-123",
      CODEX_SESSION_ID: "session-456",
      CODEX_AUTH_TOKEN: "transient-auth",
    }, { port: 7433, db: "/tmp/test.db" });

    expect(result["CODEX_HOME"]).toBe("/Users/tester/.codex-custom");
    expect(result["CODEX_CI"]).toBeUndefined();
    expect(result["CODEX_THREAD_ID"]).toBeUndefined();
    expect(result["CODEX_SESSION_ID"]).toBeUndefined();
    expect(result["CODEX_AUTH_TOKEN"]).toBeUndefined();
  });

  it("strips terminal/GUI vars and preserves core vars", () => {
    const baseEnv: Record<string, string> = {
      HOME: "/Users/tester",
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      USER: "tester",
      SHELL: "/bin/zsh",
      COLORTERM: "truecolor",
      COMMAND_MODE: "unix2003",
      CODEX_CI: "1",
      CODEX_THREAD_ID: "thread-123",
      GHOSTTY_BIN_DIR: "/Applications/Ghostty.app/bin",
      GHOSTTY_RESOURCES_DIR: "/Applications/Ghostty.app/resources",
      GHOSTTY_SHELL_FEATURES: "cursor,title",
      TERM_PROGRAM: "ghostty",
      TERM_PROGRAM_VERSION: "1.0",
      TERMINFO: "/Applications/Ghostty.app/terminfo",
      XPC_FLAGS: "0x0",
      XPC_SERVICE_NAME: "0",
      __CFBundleIdentifier: "com.cmuxterm.app",
      __CF_USER_TEXT_ENCODING: "0x1F5:0x0:0x0",
      CMUX_BUNDLE_ID: "com.cmuxterm.app",
      CMUX_BUNDLED_CLI_PATH: "/Applications/cmux.app/Contents/Resources/bin/cmux",
      CMUX_PANEL_ID: "panel:1",
      CMUX_SOCKET_PATH: "/tmp/cmux.sock",
      CMUX_TAB_ID: "tab:1",
      CMUX_WORKSPACE: "workspace:1",
      CMUX_WORKSPACE_ID: "workspace:1",
      CMUX_SURFACE_ID: "surface:3",
      LANG: "en_US.UTF-8",
    };

    const result = buildDaemonEnv(baseEnv, { port: 7433, host: "127.0.0.1", db: "/tmp/test.db" });

    // Core vars preserved
    expect(result["HOME"]).toBe("/Users/tester");
    expect(result["PATH"]).toBe("/opt/homebrew/bin:/usr/bin:/bin");
    expect(result["USER"]).toBe("tester");
    expect(result["SHELL"]).toBe("/bin/zsh");
    expect(result["LANG"]).toBe("en_US.UTF-8");

    // LOOM_* set from opts
    expect(result["LOOM_PORT"]).toBe("7433");
    expect(result["LOOM_HOST"]).toBe("127.0.0.1");
    expect(result["LOOM_DB"]).toBe("/tmp/test.db");

    // Scrubbed vars absent
    expect(result["COLORTERM"]).toBeUndefined();
    expect(result["COMMAND_MODE"]).toBeUndefined();
    expect(result["CODEX_CI"]).toBeUndefined();
    expect(result["CODEX_THREAD_ID"]).toBeUndefined();
    expect(result["GHOSTTY_BIN_DIR"]).toBeUndefined();
    expect(result["GHOSTTY_RESOURCES_DIR"]).toBeUndefined();
    expect(result["GHOSTTY_SHELL_FEATURES"]).toBeUndefined();
    expect(result["TERM_PROGRAM"]).toBeUndefined();
    expect(result["TERM_PROGRAM_VERSION"]).toBeUndefined();
    expect(result["TERMINFO"]).toBeUndefined();
    expect(result["XPC_FLAGS"]).toBeUndefined();
    expect(result["XPC_SERVICE_NAME"]).toBeUndefined();
    expect(result["__CFBundleIdentifier"]).toBeUndefined();
    expect(result["__CF_USER_TEXT_ENCODING"]).toBeUndefined();
    expect(result["CMUX_SOCKET_PATH"]).toBeUndefined();
    expect(result["CMUX_WORKSPACE"]).toBeUndefined();
    expect(result["CMUX_SURFACE_ID"]).toBeUndefined();

    // cmux context needed for workspace-bound commands is preserved
    expect(result["CMUX_BUNDLE_ID"]).toBe("com.cmuxterm.app");
    expect(result["CMUX_BUNDLED_CLI_PATH"]).toBe("/Applications/cmux.app/Contents/Resources/bin/cmux");
    expect(result["CMUX_PANEL_ID"]).toBe("panel:1");
    expect(result["CMUX_TAB_ID"]).toBe("tab:1");
    expect(result["CMUX_WORKSPACE_ID"]).toBe("workspace:1");
  });

  it("explicit opts override inherited LOOM_* from base env", () => {
    const baseEnv: Record<string, string> = {
      HOME: "/Users/tester",
      PATH: "/usr/bin",
      LOOM_PORT: "9999",
      LOOM_DB: "/old/path.db",
    };

    const result = buildDaemonEnv(baseEnv, { port: 7433, host: "127.0.0.1", db: "/new/path.db" });

    expect(result["LOOM_PORT"]).toBe("7433");
    expect(result["LOOM_DB"]).toBe("/new/path.db");
  });

  // A default product launch must NOT export LOOM_HOST, so the daemon falls through to
  // its own default plan — loopback-only — instead of taking an inherited routing value as
  // bind intent.
  describe("explicit-vs-default host signal", () => {
    it("omits LOOM_HOST when opts.host is undefined (default-product-launch)", () => {
      const baseEnv: Record<string, string> = { HOME: "/Users/tester", PATH: "/usr/bin" };
      const result = buildDaemonEnv(baseEnv, {
        port: 7433,
        db: "/tmp/test.db",
        // host intentionally omitted — operator never set it (default path)
      });
      expect(result["LOOM_HOST"]).toBeUndefined();
      // port + db still flow through
      expect(result["LOOM_PORT"]).toBe("7433");
      expect(result["LOOM_DB"]).toBe("/tmp/test.db");
    });

    it("sets LOOM_HOST when opts.host is explicit (user opt-in)", () => {
      const baseEnv: Record<string, string> = { HOME: "/Users/tester", PATH: "/usr/bin" };
      const result = buildDaemonEnv(baseEnv, {
        port: 7433,
        host: "0.0.0.0",
        db: "/tmp/test.db",
      });
      expect(result["LOOM_HOST"]).toBe("0.0.0.0");
    });

    it("S20: inherited LOOM_HOST is SCRUBBED — the shell-env-wins premise died (routing env is byte-indistinguishable from opt-in; operator baton qitem-20260827070400). Opt-in rides LOOM_BIND_HOST", () => {
      // The old pin encoded the dead-premise design this slice re-grounds: an
      // inherited LOOM_HOST was treated as operator opt-in, and a managed
      // environment's injected routing value silently became single-bind policy
      // (the parent lost its Tailscale listener). The dedicated surface carries
      // the same opt-in unambiguously:
      const baseEnv: Record<string, string> = {
        HOME: "/Users/tester",
        PATH: "/usr/bin",
        LOOM_HOST: "0.0.0.0",
      };
      const scrubbed = buildDaemonEnv(baseEnv, { port: 7433, db: "/tmp/test.db" });
      expect(scrubbed["LOOM_HOST"]).toBeUndefined();
      const optedIn = buildDaemonEnv({ ...baseEnv, LOOM_BIND_HOST: "0.0.0.0" }, { port: 7433, db: "/tmp/test.db" });
      expect(optedIn["LOOM_BIND_HOST"]).toBe("0.0.0.0"); // the dedicated channel still wins
    });
  });

  // The per-process state-isolation contract: the slice
  // intentionally drops a `--loom-home` CLI flag in favor of using
  // the process-env-pattern (each `rig` invocation gets its own
  // LOOM_HOME via the shell). The slice's "fully isolated state"
  // claim depends on the env contract being honored at module load
  // time — specifically that getLoomHome() returns the current
  // env value (not a hardcoded default) and that getStatePath
  // threads it into derived paths. The module-level constants
  // (LOOM_DIR / STATE_FILE) are a single snapshot of
  // these functions at load.
  //
  // These regression tests prove the function contract with distinct value discriminators.
  describe("LOOM_HOME env contract for per-process state isolation", () => {
    it("getLoomHome respects process.env.LOOM_HOME (distinct values yield distinct paths)", async () => {
      const { getLoomHome } = await import("@loom/daemon/data-paths");
      const saved = process.env["LOOM_HOME"];
      try {
        process.env["LOOM_HOME"] = "/Users/example/.loom-blank";
        const blank = getLoomHome();
        process.env["LOOM_HOME"] = "/Users/example/.loom-populated";
        const populated = getLoomHome();
        expect(blank).toBe("/Users/example/.loom-blank");
        expect(populated).toBe("/Users/example/.loom-populated");
        expect(blank).not.toBe(populated);
      } finally {
        if (saved === undefined) delete process.env["LOOM_HOME"];
        else process.env["LOOM_HOME"] = saved;
      }
    });

    it("getStatePath threads env-resolved LOOM_HOME into derived paths (daemon.json + log)", async () => {
      const { getStatePath } = await import("@loom/daemon/data-paths");
      const saved = process.env["LOOM_HOME"];
      try {
        process.env["LOOM_HOME"] = "/Users/example/.loom-blank";
        const blankState = getStatePath("daemon.json");
        const blankLog = getStatePath("daemon.log");
        process.env["LOOM_HOME"] = "/Users/example/.loom-populated";
        const populatedState = getStatePath("daemon.json");
        const populatedLog = getStatePath("daemon.log");
        // The state directory is real on this host, and the derived names are joined here.
        const blank = "/Users/example/.loom-blank", populated = "/Users/example/.loom-populated";
        expect(blankState).toBe(path.join(blank, "daemon.json"));
        expect(populatedState).toBe(path.join(populated, "daemon.json"));
        expect(blankLog).toBe(path.join(blank, "daemon.log"));
        expect(populatedLog).toBe(path.join(populated, "daemon.log"));
        expect(blankState).not.toBe(populatedState);
        expect(blankLog).not.toBe(populatedLog);
      } finally {
        if (saved === undefined) delete process.env["LOOM_HOME"];
        else process.env["LOOM_HOME"] = saved;
      }
    });

    it("empty LOOM_HOME falls back to homedir default (not the literal empty string)", async () => {
      const { getLoomHome } = await import("@loom/daemon/data-paths");
      const { homedir } = await import("node:os");
      const saved = process.env["LOOM_HOME"];
      try {
        process.env["LOOM_HOME"] = "";
        const { resolveDataRoots } = await import("@loom/daemon/data-paths");
        // The fallback is the host's per-user state root: `~/.loom` on POSIX and the
        // `Loom` folder under the locator on Windows. Empty means absent, not the path "".
        expect(getLoomHome()).toBe(resolveDataRoots({ env: {} }).state);
        expect(getLoomHome()).not.toBe("");
      } finally {
        if (saved === undefined) delete process.env["LOOM_HOME"];
        else process.env["LOOM_HOME"] = saved;
      }
    });

    // The regression test below proves the prior tests only verify
    // prior 3 tests verify the data-paths function contract but
    // do NOT prove daemon-lifecycle's module-level LOOM_DIR /
    // STATE_FILE constant picks up LOOM_HOME at import
    // time. Future code could hardcode "~/.loom" in
    // the module's constants would still look right and the prior tests would pass.
    //
    // This test imports daemon-lifecycle FRESH twice via
    // vi.resetModules + dynamic import, with distinct LOOM_HOME
    // values per import. Discriminator-distinct paths (per banked
    // discriminators) prove each module
    // load reflects the env that was set at that moment. Will fail
    // if a future contributor hardcodes a literal path or otherwise
    // bypasses data-paths helpers at module level.
    it("daemon-lifecycle module-level constants reflect LOOM_HOME at import time ", async () => {
      const saved = process.env["LOOM_HOME"];
      try {
        // First import — LOOM_HOME = blank-slate value
        process.env["LOOM_HOME"] = "/Users/example/.loom-vm-blank-fresh";
        vi.resetModules();
        const blank = await import("../src/daemon-lifecycle.js");

        // Second import — LOOM_HOME = populated value (distinct dir;
        // not equal, not a symlink prefix). vi.resetModules clears the
        // module cache so the second import re-evaluates module-level
        // constants under the new env.
        process.env["LOOM_HOME"] = "/Users/example/.loom-vm-populated-fresh";
        vi.resetModules();
        const populated = await import("../src/daemon-lifecycle.js");

        // LOOM_DIR — direct snapshot of getLoomHome() at module load
        const blankRoot = "/Users/example/.loom-vm-blank-fresh", populatedRoot = "/Users/example/.loom-vm-populated-fresh";
        expect(blank.LOOM_DIR).toBe(blankRoot);
        expect(populated.LOOM_DIR).toBe(populatedRoot);
        expect(blank.LOOM_DIR).not.toBe(populated.LOOM_DIR);

        // STATE_FILE — derived as path.join(LOOM_DIR, "daemon.json")
        expect(blank.STATE_FILE).toBe(path.join(blankRoot, "daemon.json"));
        expect(populated.STATE_FILE).toBe(path.join(populatedRoot, "daemon.json"));
        expect(blank.STATE_FILE).not.toBe(populated.STATE_FILE);
      } finally {
        if (saved === undefined) delete process.env["LOOM_HOME"];
        else process.env["LOOM_HOME"] = saved;
        // Re-reset modules so subsequent tests (and the file-top
        // import of daemon-lifecycle at line 4-19) aren't holding
        // stale references to a module instance bound to a temp env.
        vi.resetModules();
      }
    });
  });

  it("passes only retained startup settings into the daemon", () => {
    const env = buildDaemonEnv({}, { port: 27451, db: "/fixture/loom.sqlite" });
    expect(env).toEqual({ LOOM_MODE: "managed", LOOM_PORT: "27451", LOOM_DB: "/fixture/loom.sqlite" });
  });
});

describe("daemon status honesty: a slow-but-answering probe is never reported stopped", () => {
  // ===================================================================
  // SLICE-05 item-4 (D4) — daemon-status false-negative RED.
  // getDaemonStatus' stateless (no daemon.json) branch returns "stopped" on ANY
  // /healthz throw, conflating a probe TIMEOUT (daemon reachable but slow /healthz,
  // e.g. answers in 400ms > the 250ms status probe) with genuine-down. Runtime repro
  // (REPRO-D4a): a delayed-/healthz shim makes candidate `loom status` say "Daemon not
  // running" while /api serves. RED pins the honest outcome (a slow-but-ANSWERING probe
  // must not be "stopped"); fix-agnostic (widened budget OR timeout-vs-conn-error).
  // Genuine-down (connection error) stays "stopped" (control preserved).
  // ===================================================================
  it("Slice-05 D4 RED: a slow-but-answering /healthz on the no-daemon.json branch must NOT report stopped", async () => {
    const savedUrl = process.env["LOOM_URL"];
    delete process.env["LOOM_URL"]; // force the no-state (config) branch, not the LOOM_URL branch
    vi.useFakeTimers();
    try {
      const deps = mockDeps({
        exists: vi.fn(() => false), // no daemon.json -> stateless branch
        // /healthz ANSWERS 200, but after 400ms — past the 250ms probe, within a sane budget.
        fetch: vi.fn(() => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 400))),
      });
      const statusPromise = getDaemonStatus(deps);
      await vi.runAllTimersAsync();
      const status = await statusPromise;
      expect(status.state).not.toBe("stopped"); // <-- RED: currently "stopped" (timeout conflated with down)
    } finally {
      vi.useRealTimers();
      if (savedUrl !== undefined) process.env["LOOM_URL"] = savedUrl;
    }
  });

  it("Slice-05 D4 preserve (GREEN): genuine-down (connection error, no daemon.json) still reports stopped", async () => {
    const savedUrl = process.env["LOOM_URL"];
    delete process.env["LOOM_URL"];
    try {
      const deps = mockDeps({
        exists: vi.fn(() => false),
        sleep: async () => {},
        fetch: vi.fn(async () => { throw new Error("ECONNREFUSED"); }), // connection refused = confirmed down
      });
      const status = await getDaemonStatus(deps);
      expect(status.state).toBe("stopped");
    } finally {
      if (savedUrl !== undefined) process.env["LOOM_URL"] = savedUrl;
    }
  });

  // The OTHER independent stateless catch->stopped branch: LOOM_URL set (the
  // firsthand D4a repro path). Same false-negative: a slow-but-answering /healthz
  // there is also reported stopped.
  it("Slice-05 D4 RED (LOOM_URL branch): a slow-but-answering /healthz must NOT report stopped", async () => {
    const savedUrl = process.env["LOOM_URL"];
    process.env["LOOM_URL"] = "http://127.0.0.1:9999"; // force the LOOM_URL branch
    vi.useFakeTimers();
    try {
      const deps = mockDeps({
        fetch: vi.fn(() => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 400))), // answers > 250ms probe
      });
      const statusPromise = getDaemonStatus(deps);
      await vi.runAllTimersAsync();
      const status = await statusPromise;
      expect(status.state).not.toBe("stopped"); // <-- RED: currently "stopped" (LOOM_URL branch catch)
    } finally {
      vi.useRealTimers();
      if (savedUrl !== undefined) process.env["LOOM_URL"] = savedUrl;
      else delete process.env["LOOM_URL"];
    }
  });

  it("Slice-05 D4 preserve (GREEN, LOOM_URL branch): genuine-down (connection error) still reports stopped", async () => {
    const savedUrl = process.env["LOOM_URL"];
    process.env["LOOM_URL"] = "http://127.0.0.1:9999";
    try {
      const deps = mockDeps({ sleep: async () => {}, fetch: vi.fn(async () => { throw new Error("ECONNREFUSED"); }) });
      const status = await getDaemonStatus(deps);
      expect(status.state).toBe("stopped");
    } finally {
      if (savedUrl !== undefined) process.env["LOOM_URL"] = savedUrl;
      else delete process.env["LOOM_URL"];
    }
  });
});
