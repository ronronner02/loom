import { serve, type ServerType } from "@hono/node-server";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { closeHttpServer, createDaemonShutdown, DAEMON_SHUTDOWN_RECEIPT, trackHttpServerResponses } from "./daemon-shutdown.js";
import { MULTI_AGENT_HOME, resolveDataRoots } from "./data-paths.js";
import { resolveDaemonDbPath } from "./daemon-db-path.js";
import { createDaemon } from "./startup.js";
import { resolveClientDependencies } from "./domain/executable-resolver.js";
import { endRunningWorkerTrees } from "./domain/process-termination.js";
import { resolveBindPlan } from "./domain/bind-plan.js";
import type { TeamControlCredentials } from "./middleware/auth-bearer-token.js";
import { assertBindAuthInvariant } from "./middleware/auth-bearer-token.js";
import type { SlowOperationInstrumentation } from "./domain/slow-op-recorder.js";
import { SettingsStore } from "./domain/user-settings/settings-store.js";
import {
  ensureMultiAgentInstance,
  formatInstanceInitializationConflicts,
} from "./domain/instance-initialization.js";

/** OPR.0.4.3.21 (51elv2) — bound the graceful-shutdown recorder drain. */
export const SLOW_OP_SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000;
/** P7 — lifecycle heartbeat cadence; last-seen granularity = this interval. */
export const HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * OPR.0.4.3.21 (51elv2) — drain + close the slow-operation recorder on graceful
 * shutdown and report the process exit code. Returns 0 when the recorder closes
 * cleanly (or is absent), 1 when the drain rejects, times out, or the recorder
 * is in a terminal-failure state — an unproven/lost drain must never look like a
 * clean exit. Bounded by ONE finite timer that stays REFERENCED until the drain
 * settles or times out — it is the only handle that can enforce the bound once
 * the servers and recorder Worker are unreferenced — and is cleared after
 * settlement; adds no retry, queue repair, migration, or supervisor machinery.
 */
export async function drainSlowOpRecorderOnShutdown(
  recorder: Pick<SlowOperationInstrumentation, "flush" | "close"> | undefined,
  opts?: { timeoutMs?: number; log?: (message: string, error?: unknown) => void },
): Promise<number> {
  const drain = recorder?.close ?? recorder?.flush;
  if (!recorder || !drain) return 0;
  const log = opts?.log ?? ((message: string, error?: unknown) => console.error(message, error));
  const timeoutMs = opts?.timeoutMs ?? SLOW_OP_SHUTDOWN_DRAIN_TIMEOUT_MS;

  let drainError: unknown;
  // Track rejection independently of its value: a Promise may reject with a
  // falsey value (undefined / null / false / 0 / ""), which is still a failure.
  let rejected = false;
  let settled = false;
  const drainPromise = Promise.resolve()
    .then(() => drain.call(recorder))
    .then(
      () => { settled = true; },
      (error) => { drainError = error; rejected = true; settled = true; },
    );

  // This finite timer is the ONLY thing keeping shutdown alive long enough to
  // enforce the bound once the servers + recorder Worker are unreferenced, so
  // it must stay referenced (do NOT unref it); it is cleared after settlement.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });

  await Promise.race([drainPromise, timeoutPromise]);
  if (timer) clearTimeout(timer);

  if (!settled) {
    log("[slow-operation] shutdown drain timed out; instrumentation records may be lost");
    return 1;
  }
  if (rejected) {
    log("[slow-operation] shutdown drain failed; instrumentation records may be lost", drainError);
    return 1;
  }
  return 0;
}

/**
 * End every worker process tree this daemon started, and refuse a clean shutdown when one
 * could not be proved gone.
 *
 * A daemon's shutdown is the end of the run: no supervisor remains to close a turn, and a
 * worker left running is an agent nobody can see, still holding its candidate, its endpoint
 * and the owner's provider spend. Each live attempt recorded its own process pair, and the
 * tree kill cancellation and boot recovery already use ends it — `taskkill /T /F` on Windows,
 * the process group signal on POSIX. An identity that cannot be proved is never signalled as
 * though it were dead; a surviving tree makes the shutdown receipt say `failed` instead of
 * claiming a stop it did not observe.
 */
async function endWorkerChildren(db: {
  prepare(sql: string): { all(...parameters: string[]): unknown[] };
}): Promise<void> {
  const result = await endRunningWorkerTrees(db);
  if (result.unresolved > 0) {
    throw new Error(`${result.unresolved} of ${result.attempted} worker process tree(s) could not be proved stopped`);
  }
}

export async function startServer(port?: number) {
  // Consume control credentials before bootstrap or discovery can spawn a child.
  const ownerToken = process.env.MULTI_AGENT_OWNER_TOKEN?.trim() || null;
  delete process.env.MULTI_AGENT_OWNER_TOKEN;
  // The daemon runs one mode. A desktop or service launch sets `managed`; anything else is
  // rejected rather than silently starting a daemon with no run supervision.
  const requestedMode = process.env.MULTI_AGENT_MODE?.trim() || "managed";
  if (requestedMode !== "managed") {
    throw new Error(`MULTI_AGENT_MODE must be "managed", got "${requestedMode}"`);
  }
  // A managed daemon hosted by the desktop (Electron's utility process, which has a
  // parent port) starts with no configured owner token. Pairing still needs a stable owner
  // identity inside this process, so mint one in memory. It never leaves the daemon: the
  // desktop mints a one-time code over the private parent channel instead, and nothing here
  // persists, logs, or hands this value to Electron. A daemon with no parent port has no
  // channel to mint a code on, so it gets no invented token.
  const hostedByDesktop = (process as { parentPort?: unknown }).parentPort !== undefined;
  const resolvedOwnerToken = ownerToken
    ?? (hostedByDesktop ? randomBytes(32).toString("base64url") : null);
  if (!resolvedOwnerToken) {
    throw new Error("No owner credential: set MULTI_AGENT_OWNER_TOKEN, or start the daemon from the desktop, "
      + "which mints one over its parent channel.");
  }
  const p = port ?? parseInt(process.env.MULTI_AGENT_PORT ?? "7433", 10);
  // A value that cannot be bound is a configuration error, and it is named here rather than left
  // to `serve()`'s raw ERR_SOCKET_BAD_PORT. Same rule the CLI applies to `--port`.
  if (!Number.isInteger(p) || p < 0 || p > 65_535) {
    throw new Error(`MULTI_AGENT_PORT must be an integer in [0, 65535], got "${process.env.MULTI_AGENT_PORT ?? p}"`);
  }
  // D15 — anchor the default db under MULTI_AGENT_HOME, never a bare CWD-relative
  // filename (which could open the shared fleet db). Explicit MULTI_AGENT_DB wins.
  const dbPath = resolveDaemonDbPath(process.env.MULTI_AGENT_DB, MULTI_AGENT_HOME);
  const instanceConfig = new SettingsStore().resolveConfig();
  const initialization = ensureMultiAgentInstance({
    home: MULTI_AGENT_HOME,
    configHome: resolveDataRoots().config,
    workspaceRoot: instanceConfig.workspaceRoot,
    contextRoot: instanceConfig.contextRoot,
    skillsRoot: instanceConfig.skillsRoot,
    topologyRoot: instanceConfig.topologyRoot,
  });
  if (!initialization.ok) {
    throw new Error(`Multi-Agent instance initialization blocked: ${formatInstanceInitializationConflicts(initialization)}`);
  }

  // OPR.0.5.5.20 — bind intent rides ONLY the dedicated MULTI_AGENT_BIND_HOST surface.
  // The overloaded routing env (MULTI_AGENT_HOST) is observed for the provenance line below
  // and NEVER selects the bind branch: a managed environment's injected endpoint is
  // byte-indistinguishable from opt-in. With no declared host the plan is loopback-only, so a
  // host that also runs Tailscale binds loopback rather than publishing the owner surfaces on
  // the tailnet.
  const bindPlan = resolveBindPlan({
    bindHostEnv: process.env.MULTI_AGENT_BIND_HOST,
    routingHostEnv: process.env.MULTI_AGENT_HOST,
  });
  if (bindPlan.ignoredRoutingHost) {
    console.error(
      `[bind-provenance] MULTI_AGENT_HOST=${bindPlan.ignoredRoutingHost} is ROUTING env and was ignored for bind policy — ` +
      `binding default ${bindPlan.hosts.join(" + ")}. Declare bind intent via --host, the daemon.host config key (file), or MULTI_AGENT_BIND_HOST.`,
    );
  }
  const explicitHost = bindPlan.mode === "explicit" ? bindPlan.hosts[0] : undefined;
  // PL-005 Phase B: bearer token for Mission Control write verbs.
  // No legacy alias (this env var is new in Phase B).
  const bearerToken = process.env.MULTI_AGENT_AUTH_BEARER_TOKEN ?? null;

  let bindHosts: string[];
  if (explicitHost) {
    // Operator opt-in path — the invariant requires a bearer for a genuinely public/LAN bind;
    // a loopback bind short-circuits.
    await assertBindAuthInvariant({ host: explicitHost, bearerToken });
    bindHosts = [explicitHost];
  } else {
    // Default path — the plan is loopback-only.
    bindHosts = bindPlan.hosts;
  }

  // The process entry holds the one credential object the daemon fills. Startup
  // writes its `workers` list in place as attempts are admitted, so every holder — control
  // routes, the managed launch chain and the mailbox endpoint — reads the same tokens, and
  // the owner credential it started with is never replaced by a second copy.
  const teamControlCredentials: TeamControlCredentials = { ownerToken: resolvedOwnerToken };
  // The bounded shutdown is composed below, after every phase it stops exists. The route only
  // needs to reach it once the daemon is listening, so it is handed a thunk resolved late.
  let runningShutdown = (_signal: string): void => {};
  const { app, deps, eventLoopMonitor } = await createDaemon({
    dbPath,
    teamControl: { credentials: teamControlCredentials },
    bearerToken,
    // The effective bind plan rides the health surface so adoption gates verify
    // listeners from BINDING EVIDENCE (probe each host) instead of config echo.
    bindPlan,
    requestShutdown: signal => runningShutdown(signal),
  });

  // Multi-bind via N serve() instances sharing the same Hono app.
  // Hono's serve() targets a single host:port; for multi-bind we spawn
  // one per host. The schedulers only start once after the first successful
  // bind callback fires.
  let monitorsStarted = false;
  // P7 — lifecycle heartbeat: advance last-seen every tick while running.
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const servers: ServerType[] = [];
  for (const host of bindHosts) {
    const srv = serve({ fetch: app.fetch, port: p, hostname: host }, (info) => {
      console.log(`Multi-Agent daemon listening on http://${host}:${info.port}`);
      // U5 — report readiness to the Electron parent process over parentPort. Only the
      // loopback bind reports, because the desktop only ever binds loopback.
      if (host === "127.0.0.1") {
        try {
          (process as { parentPort?: { postMessage: (msg: unknown) => void } }).parentPort?.postMessage({
            type: "ready", port: info.port, pid: process.pid,
          });
        } catch { /* parentPort may be closed during fast shutdown */ }
      }
      if (!monitorsStarted) {
        monitorsStarted = true;
        // Observe the end of a direct-launched attempt. The sweep admits each launch
        // receipt's attempt and records it stopped when the process it named is gone; it never
        // decides an outcome, which stays the owner's action.
        deps.attemptCompletion?.start();
        // P7 — lifecycle heartbeat (advances last-seen). A write failure logs and
        // continues (the render degrades to an older last-seen honestly); the
        // store guards not-stopped so a tick can never pass stopped_at.
        heartbeatTimer = setInterval(() => {
          try {
            deps.daemonLifecycleStore.recordHeartbeat(new Date().toISOString());
          } catch (err) {
            console.error("[lifecycle-heartbeat] write failed (non-fatal)", err);
          }
        }, HEARTBEAT_INTERVAL_MS);
      }
    });
    trackHttpServerResponses(srv, deps.requestPhaseObserver?.observeRequest);
    servers.push(srv);
  }

  // Multi-bind: close every serve() instance in parallel.
  const shutdownPhases: Array<[string, () => unknown]> = [
    ["timers", () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    }],
    ["attempt-completion", () => deps.attemptCompletion?.stop()],
    ["github-login", () => deps.github?.stop()],
    ["event-loop-monitor", () => eventLoopMonitor.stop()],
    ["connections", () => Promise.all(servers.map((srv) => closeHttpServer(srv)))],
    // After the sweep and the listener are stopped nothing can launch another turn, so every
    // worker that is still running is one this daemon must end before it goes.
    ["worker-processes", () => endWorkerChildren(deps.rigRepo.db)],
    ["recorder", async () => {
      deps.requestPhaseObserver?.close();
      if (await drainSlowOpRecorderOnShutdown(deps.slowOpRecorder) !== 0) {
        throw new Error("slow-operation recorder drain incomplete; records may be lost");
      }
    }],
  ];
  const shutdown = createDaemonShutdown({
    receiptPath: path.join(MULTI_AGENT_HOME, DAEMON_SHUTDOWN_RECEIPT),
    phases: shutdownPhases,
    // A service failure, open connection, or lost recorder drain is never clean.
    markClean: () => deps.daemonLifecycleStore.recordStop(deps.daemonBootEpoch, new Date().toISOString()),
  });
  runningShutdown = shutdown;
  // Repeated signals join the first shutdown instead of bypassing its evidence.
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  /** Parent-port bridge for Electron utility-process hosting. */
  // parentPort is injected by Electron's utilityProcess runtime; it is not
  // a standard Node.js Process property, so we access it via cast. Electron's
  // MessagePortMain delivers `{ data }`; worker_threads delivers the value.
  const parentPort = (process as {
    parentPort?: {
      on: (event: string, listener: (message: unknown) => void) => void;
      postMessage: (message: unknown) => void;
    };
  }).parentPort;
  if (parentPort) {
    parentPort.on("message", (message: unknown) => {
      const envelope = message as { data?: unknown };
      const msg = (envelope && typeof envelope === "object" && "data" in envelope ? envelope.data : message) as Record<string, unknown> | null;
      if (msg?.type === "shutdown") shutdown("parent");
      // Native pairing. The desktop mints a one-time code over this private port
      // instead of holding an owner token, then exchanges it over HTTP like a browser
      // would. Only the parent process can reach this listener, so no HTTP route changes.
      // The code goes back over the port and is never logged or written anywhere.
      if (msg?.type === "mint-pairing") replyToMintPairing(deps.ownerSessions, resolvedOwnerToken, parentPort);
      // First-run dependency status. The desktop asks the daemon that will launch the
      // workers, so the resolved paths it shows are the paths a launch will use.
      if (msg?.type === "dependencies") replyToDependencies(parentPort);
    });
  }

  // Backward-compatible single-server return (callers that just need a
  // handle reference; multi-bind shutdown is wired via signal handlers).
  return servers[0]!;
}

/** Answer one `mint-pairing` request over the parent port. */
export function replyToMintPairing(
  sessions: import("./domain/owner-session.js").OwnerSessions | undefined,
  ownerToken: string | null,
  port: { postMessage: (message: unknown) => void },
): void {
  const reply = (message: unknown): void => replyOnParentPort(port, message);
  if (!sessions || !ownerToken) return reply({ type: "pairing-error", error: "owner_session_unavailable" });
  try {
    const { code } = sessions.mint(ownerToken);
    reply({ type: "pairing-code", code });
  } catch {
    // Never echo the code or the underlying error: a failed mint is a failed mint.
    reply({ type: "pairing-error", error: "pairing_mint_failed" });
  }
}

/** Post one answer on the parent port; a closed port is not an error worth raising. */
function replyOnParentPort(port: { postMessage: (message: unknown) => void }, message: unknown): void {
  try { port.postMessage(message); } catch { /* parentPort may be closed */ }
}

/**
 * Answer one `dependencies` request over the parent port.
 *
 * The answer is resolver output for `claude`, `codex`, `gemini`, `git` and `gh`, unchanged: the
 * desktop's first-run page shows what this daemon resolved, so its paths are the paths a launch
 * will use. A resolver failure is reported as a named error, never as an empty "all good" list.
 */
export function replyToDependencies(port: { postMessage: (message: unknown) => void }): void {
  try {
    replyOnParentPort(port, { type: "dependencies", resolutions: resolveClientDependencies() });
  } catch (error) {
    replyOnParentPort(port, { type: "dependencies-error", error: error instanceof Error ? error.message : String(error) });
  }
}

// Only start the server when this file is executed directly (not imported).
// pathToFileURL normalizes argv[1] (backslash paths on Windows) into the same
// shape as import.meta.url — a plain `file://${argv[1]}` never matches on win32,
// which made the daemon exit silently with code 0.
const isDirectRun =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  startServer();
}
