import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { observeIdentity } from "../src/domain/process-termination.js";
import { readSpawnCreationTime } from "../src/adapters/child-process-supervisor.js";

/** The owner credential this fixture starts the daemon with, and presents to it. */
const OWNER_TOKEN = "shutdown-worker-owner-credential";

/**
 * A daemon's SIGTERM ends the worker trees it started, whoever started the daemon.
 *
 * The desktop hosts its daemon, but a daemon started from the CLI is the same process with the
 * same ownership: nothing survives it that can close a turn. This runs the shipped entrypoint,
 * records a live worker exactly as a launch receipt does, sends the real signal, and checks the
 * worker and its grandchild are gone.
 */
describe("a daemon's SIGTERM ends its worker process trees", () => {
  const tempDirs: string[] = [];
  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const child of children.splice(0)) { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-shutdown-workers-"));
    tempDirs.push(dir);
    return dir;
  }

  it("ends a live worker tree started by a CLI-launched daemon", async () => {
    const home = tempDir();
    const dbPath = path.join(home, "multi-agent.sqlite");
    const port = await freePort();
    const indexPath = path.resolve(import.meta.dirname, "../src/index.ts");
    const daemon = spawn(process.execPath, ["--import", "tsx", indexPath], {
      env: {
        ...process.env,
        HOME: home,
        MULTI_AGENT_HOME: home,
        // The daemon's own database is where the attempt row is written below.
        MULTI_AGENT_DB: dbPath,
        MULTI_AGENT_PORT: String(port),
        // The default plan adds an active Tailscale address, which the owner surface refuses on
        // a host that has none of its own; a loopback-only bind is the explicit shape.
        MULTI_AGENT_BIND_HOST: "127.0.0.1",
        // A CLI start names its owner credential; the desktop mints one over its parent port.
        MULTI_AGENT_OWNER_TOKEN: OWNER_TOKEN,
        MULTI_AGENT_URL: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    children.push(daemon);
    let stderr = "";
    daemon.stderr!.setEncoding("utf8");
    daemon.stderr!.on("data", (chunk: string) => { stderr += chunk; });
    try {
      await waitForHealthz(port, daemon, () => stderr);

      // A worker that starts a grandchild and waits: the grandchild is what a plain kill of the
      // direct child leaves running, and the tree kill is what reaches it.
      const script = `const { spawn } = require('node:child_process');
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
console.log('grandchild=' + grandchild.pid);
setInterval(() => {}, 1000);`;
      // Spawned the way the supervisor spawns a turn: `detached` on POSIX puts the worker in its
      // own process group, which is the group the tree kill signals. A worker left in the test
      // runner's group is not this run's to end, and the production kill refuses it by name
      // rather than signalling a group it did not create.
      const worker = spawn(process.execPath, ["-e", script],
        { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, detached: process.platform !== "win32" });
      children.push(worker);
      const grandchildPid = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("the worker printed no grandchild pid")), 15_000);
        worker.stdout!.setEncoding("utf8");
        worker.stdout!.on("data", (chunk: string) => {
          const match = /grandchild=(\d+)/.exec(chunk);
          if (match) { clearTimeout(timer); resolve(Number(match[1])); }
        });
        worker.once("error", reject);
      });
      const processStart = await readSpawnCreationTime(worker.pid!);
      expect(processStart, "the worker's creation time is the identity the daemon records").toBeTruthy();
      const identity = { processId: worker.pid!, processStart: processStart! };
      expect(await observeIdentity(identity), "the worker is alive before the daemon stops").toBe("alive");

      recordRunningAttempt(dbPath, identity);

      // A signal cannot drain a daemon on Windows: the process ends outright and no handler runs.
      // The owner's stop request is the one path that drains on every host, and it must end the
      // worker trees too.
      const refused = await fetch(`http://127.0.0.1:${port}/api/team-control/daemon/shutdown`, { method: "POST" });
      expect(refused.status, "a stop without the owner credential is refused").toBe(401);
      const accepted = await fetch(`http://127.0.0.1:${port}/api/team-control/daemon/shutdown`, {
        method: "POST", headers: { authorization: `Bearer ${OWNER_TOKEN}` },
      });
      expect(accepted.status, `the owner's stop is accepted; body=${await accepted.text()}`).toBe(202);
      const [code] = (await once(daemon, "exit")) as [number | null];
      expect(code, `the daemon should shut down cleanly; stderr=${stderr}`).toBe(0);
      expect(await observeIdentity(identity), "the worker is gone after the daemon stops").toBe("dead");
      expect(await observeIdentity({ processId: grandchildPid, processStart: "unobserved" }),
        "the grandchild a direct kill would have leaked is gone too").not.toBe("alive");
      const receipt = JSON.parse(fs.readFileSync(path.join(home, "daemon-shutdown.json"), "utf8")) as
        { outcome: string; phase: string; failures: Array<{ phase: string }> };
      expect(receipt).toMatchObject({ outcome: "clean", phase: "complete", failures: [] });
    } finally {
      if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGKILL");
    }
  }, 60_000);
});

/** Record one running attempt the way a launch receipt does, against the daemon's own database. */
function recordRunningAttempt(dbPath: string, identity: { processId: number; processStart: string }): void {
  // WAL mode lets this connection write while the daemon holds its own; the daemon's next read
  // sees the row exactly as a running attempt it started.
  const db = new Database(dbPath, { timeout: 10_000 });
  try {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO rigs (id, name) VALUES ('shutdown-rig', 'shutdown fixture')").run();
    db.prepare(`INSERT INTO team_runs (id, rig_id, binding_json, binding_digest, state, phase, created_at, updated_at)
      VALUES ('shutdown-run', 'shutdown-rig', '{}', 'digest', 'approved', 'planning', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO team_attempts (id, run_id, qitem_id, role, provider, state, identity_json, unknown_reason,
      usage_json, active_ms, entity_version, created_at, updated_at)
      VALUES ('shutdown-attempt', 'shutdown-run', NULL, 'implementer', 'codex', 'running', ?, NULL, '{}', 0, 1, ?, ?)`)
      .run(JSON.stringify({ nativeSessionId: "shutdown", tmuxServer: null, paneId: null, ...identity,
        generation: 1, policyFingerprint: "fixture" }), now, now);
  } finally {
    db.close();
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealthz(port: number, child: ChildProcess, stderr: () => string): Promise<void> {
  const deadline = Date.now() + 20_000;
  let exited = false;
  child.once("exit", () => { exited = true; });
  while (Date.now() < deadline) {
    if (exited) throw new Error(`daemon exited before ready: ${stderr()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.status === 200) return;
    } catch { /* not listening yet */ }
    await new Promise<void>(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`daemon never became healthy: ${stderr()}`);
}