import path from "node:path";
import { existsSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { connectionErrorCode, formatDaemonHostForUrl } from "./client.js";
import type { DaemonStartLock } from "./daemon-start-lock.js";
import { DAEMON_STOP_WAIT_MS, DAEMON_SHUTDOWN_RECEIPT, type DaemonShutdownReceipt } from "@multi-agent/daemon/daemon-shutdown";
import { ConfigStore } from "./config-store.js";
import { MULTI_AGENT_HOME } from "@multi-agent/daemon/data-paths";
export interface DaemonState {
  pid: number;
  port: number;
  host?: string;
  db: string;
  startedAt: string;
}

/** Event-loop wedge evidence read from the enriched `/healthz` body. Present only when the
 *  daemon actually answered healthz with a monitor wired; absent when healthz timed out (a
 *  wedged loop can't respond — the evidence in that case is `reason: "unresponsive"`). */
export interface DaemonEventLoopEvidence {
  lagMeanMs: number;
  lagP99Ms: number;
  utilization: number;
  lastTickAgeMs: number;
  healthy: boolean;
}

export interface DaemonStatus {
  /** "stopped" requires POSITIVE evidence (connection refused); a probe TIMEOUT or other
   *  non-refusal failure is "unverified" — never a down assertion. */
  state: "running" | "stopped" | "stale" | "unverified";
  port?: number;
  host?: string;
  pid?: number;
  healthy?: boolean;
  /** Why an alive+listening daemon is unhealthy. "unresponsive" = the process is up but
   *  `/healthz` timed out (the honest wedged-loop signal); "event-loop-starved" = healthz
   *  answered but the loop-lag / last-tick evidence crossed the threshold. Absent when healthy. */
  reason?: "unresponsive" | "event-loop-starved";
  /** Event-loop evidence when healthz answered with a monitor. */
  eventLoop?: DaemonEventLoopEvidence;
  /** The OS code behind a failed health probe (e.g. EPERM when a sandbox blocked it). */
  probeErrorCode?: string;
}

/** "unknown": the process may exist but this shell can neither signal nor inspect it. */
export type ProcessLiveness = "alive" | "dead" | "unknown";

export interface GetDaemonStatusOptions {
  /** Observers may disable cleanup; only a matching clean shutdown permits removal. */
  cleanupStaleState?: boolean;
}

export interface StartOptions {
  port?: number;
  host?: string;
  db?: string;
}

export interface LifecycleDeps {
  /** Required by startDaemon; read-only lifecycle consumers need no launch capability. */
  acquireStartLock?: () => DaemonStartLock;
  spawn: (cmd: string, args: string[], opts: {
    env: Record<string, string>;
    stdio: unknown;
    detached: boolean;
    windowsHide?: boolean;
  }) => ChildProcess;
  /** Optional `json` lets getDaemonStatus read the enriched /healthz body (event-loop
   *  evidence). Optional so existing mocks that return `{ ok }` are unchanged. */
  /** `init` carries the one write the stop path makes: the owner's stop request. */
  fetch: (url: string, init?: { method: string; headers: Record<string, string> }) =>
    Promise<{ ok: boolean; json?: () => Promise<unknown> }>;
  /** Exclusive bind check used only after a no-state health probe times out. */
  isPortOccupied?: (host: string, port: number) => Promise<boolean>;
  kill: (pid: number, signal: string) => boolean;
  readFile: (path: string) => string | null;
  fileSize?: (path: string) => number;
  readFileFrom?: (path: string, offset: number) => string | null;
  writeFile: (path: string, content: string) => void;
  removeFile: (path: string) => void;
  exists: (path: string) => boolean;
  mkdirp: (path: string) => void;
  /** Exact production path typing for additive initialization. Tests that do
   * not exercise collisions may omit it and use the legacy exists seam. */
  pathKind?: (path: string) => "file" | "directory" | "other" | "missing";
  openForAppend: (path: string) => number;
  closeFile?: (fd: number) => void;
  isProcessAlive: (pid: number) => boolean;
  /** Platform for the stop path's exit semantics. Absent = the POSIX rules; realDeps supplies the running platform. */
  platform?: NodeJS.Platform;
  /** Three-state liveness for status reads (production: realDeps). Optional so existing
   *  mocks keep the boolean rule; absent = derived from isProcessAlive. */
  processLiveness?: (pid: number) => ProcessLiveness;
  /** Optional injectable delay for the status-probe bounded settle/retry. Defaults to a real
   *  setTimeout in production; tests pass a no-op to stay fast. */
  sleep?: (ms: number) => Promise<void>;
  /** Home-resolution honesty deps, optional so existing mocks/callers are untouched:
   *  homeDir overrides the module-load MULTI_AGENT_DIR for the sibling-home scan; listDir
   *  lists a directory (production: fs.readdirSync). */
  homeDir?: string;
  listDir?: (path: string) => string[];
  /** The owner credential a stop request authenticates with. Absent = read at stop time from the
   *  environment or the recorded owner file, like every other owner verb. */
  ownerToken?: () => string | null;
}

export const MULTI_AGENT_DIR = MULTI_AGENT_HOME;
export const STATE_FILE = path.join(MULTI_AGENT_DIR, "daemon.json");
const LOG_FILE = path.join(MULTI_AGENT_DIR, "daemon.log");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 7433;
const DEFAULT_DB = "multi-agent.sqlite";
// Fresh Linux hosts can take longer than a warmed dev machine to load native
// modules, run startup reconciliation, and bind healthz. Keep the retry loop
// bounded, but do not kill a healthy daemon during first-boot slack.
const HEALTHZ_RETRIES = 80;
const HEALTHZ_DELAY_MS = 250;
// The WHOLE status health probe stays within ONE normal
// CLI request window (~5s, matching DaemonClient's timeoutMs) — immediate connection
// errors may retry INSIDE this deadline, but it is NEVER re-allocated per retry. So a
// slow-but-answering /healthz (e.g. 400ms) is OBSERVED rather than falsely reported
// stopped; a genuine connection refusal still fails within the window -> stopped.
const STATUS_PROBE_DEADLINE_MS = 5000;
// Status-probe bounded settle: a single /healthz fetch loses to the post-restart
// listener bind window (process up, not yet accepting). getDaemonStatus retries a HARD-BOUNDED
// number of attempts with a short backoff so the status reflects the ACTUAL /healthz answer. This
// is status-probe-LOCAL (does NOT change start/stop/checkPid timing). Worst-case added latency for
// a genuine-down status check is bounded ((ATTEMPTS-1)*DELAY + per-attempt timeout) — never a hang.
const STATUS_PROBE_MAX_ATTEMPTS = 5;
const STATUS_PROBE_RETRY_DELAY_MS = 200;
const HEALTHZ_PROBE_TIMEOUT_MS = 250;
// Windows terminates a process outright on SIGTERM, so the killed daemon leaves the keep-alive
// socket the probe just used reset (ECONNRESET) rather than the port refusing. This bounded
// re-probe lets that socket settle so the stop observation reports the port's real state.
const WIN32_LISTENER_SETTLE_MS = 1_000;

class HealthProbeTimeoutError extends Error {
  constructor(url: string) {
    super(`healthz probe timed out for ${url}`);
    this.name = "HealthProbeTimeoutError";
  }
}

function summarizeDaemonStartFailure(healthzUrl: string, logContent: string | null): string {
  const generic = `Daemon failed to start: healthz at ${healthzUrl} not responding`;
  const lines = (logContent ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return generic;

  const recentLines = lines.slice(-20);
  const recentBlock = recentLines.join("\n");

  if (/ERR_DLOPEN_FAILED|NODE_MODULE_VERSION|compiled against a different Node\.js version/i.test(recentBlock)) {
    const moduleName = /better[-_]?sqlite3/i.test(recentBlock) ? "better-sqlite3" : "the daemon's native module";
    const detail = recentLines.find((line) => /ERR_DLOPEN_FAILED|NODE_MODULE_VERSION|compiled against a different Node\.js version/i.test(line))
      ?? recentLines[recentLines.length - 1]!;
    return [
      `Daemon failed to start under Node ${process.version} (${process.execPath}).`,
      `${moduleName} could not load because its native binary does not match the active Node runtime.`,
      `Recent daemon log: ${detail}`,
      "Fix: switch back to the Node version used when @multi-agent/cli was installed, or reinstall @multi-agent/cli under the current node, then retry `multi-agent daemon start`.",
    ].join(" ");
  }

  const detail = [...recentLines].reverse().find((line) => /error|ERR_|failed|exception|cannot|disk full/i.test(line))
    ?? recentLines[recentLines.length - 1]!;
  return `${generic}. Recent daemon log: ${detail}`;
}

function resolveCliBaseDir(baseDir: string): string {
  return path.basename(baseDir) === "commands" ? path.resolve(baseDir, "..") : baseDir;
}

/**
 * Pure resolver: prefers monorepo source when present (dev checkout
 * where `packages/daemon/dist` is the source of truth), falls back to
 * the bundled/vendored copy at `packages/cli/daemon` (the npm-install
 * layout).
 *
 * Why this order: in a monorepo dev checkout BOTH paths exist:
 *   - packages/daemon/dist                ← refreshed by
 *                                            `npm run build --workspace
 *                                            @multi-agent/daemon` (frequent;
 *                                            source of truth)
 *   - packages/cli/daemon/dist            ← refreshed only by
 *                                            `scripts/build-package.sh`
 *                                            (rare; for npm publish)
 *
 * Picking the vendored copy first (the prior order) means devs run a
 * stale daemon through `multi-agent daemon start` whenever they've rebuilt
 * `@multi-agent/daemon` but haven't rerun `build-package.sh`.
 *
 * In an npm-install layout `packages/daemon/dist` does not exist
 * (only the bundled `packages/cli/daemon` lives next to the cli);
 * the fallback handles that case unchanged.
 */
export function resolveDaemonPath(baseDir: string, exists: (p: string) => boolean): string {
  const cliBaseDir = resolveCliBaseDir(baseDir);
  const monorepo = path.resolve(cliBaseDir, "../../daemon");
  if (exists(path.join(monorepo, "dist/index.js"))) return monorepo;
  const bundled = path.resolve(cliBaseDir, "../daemon");
  if (exists(path.join(bundled, "dist/index.js"))) return bundled;
  // Last-resort: return the monorepo path so the caller's own existence check
  // reports "daemon dist not found at <path>" instead of crashing on undefined.
  return monorepo;
}

export function getDaemonPath(): string {
  return resolveDaemonPath(import.meta.dirname, existsSync);
}

function readState(deps: LifecycleDeps): DaemonState | null {
  const stateFile = STATE_FILE;
  if (!deps.exists(stateFile)) return null;
  const raw = deps.readFile(stateFile);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DaemonState;
  } catch {
    // Malformed daemon.json — treat as no state
    console.error("Warning: malformed daemon.json; target identity unavailable");
    return null;
  }
}

/** Check if a PID is an Multi-Agent daemon. Returns:
 *  - "multi-agent" — healthz responded (ok or not) → this is our daemon
 *  - "not_multi-agent" — connection refused → PID is alive but not listening on our port
 *  - "unresponsive" — pid is alive but healthz probe timed out
 *  - "dead" — PID not alive */
async function checkPid(state: DaemonState, deps: LifecycleDeps): Promise<"multi-agent" | "not_multi-agent" | "unresponsive" | "dead"> {
  if (!deps.isProcessAlive(state.pid)) return "dead";
  const host = state.host ?? DEFAULT_HOST;
  try {
    await fetchDaemonProbe(deps, `http://${formatDaemonHostForUrl(host)}:${state.port}/healthz`, HEALTHZ_PROBE_TIMEOUT_MS);
    // Any response (ok or not) means something is listening on our port → Multi-Agent
    return "multi-agent";
  } catch (err) {
    if (err instanceof HealthProbeTimeoutError) return "unresponsive";
    // Connection refused → PID alive but not our daemon
    return "not_multi-agent";
  }
}

function resolveConfiguredDaemonTarget(): { host: string; port: number } {
  try {
    const config = new ConfigStore().resolve();
    return {
      host: config.daemon.host,
      port: config.daemon.port,
    };
  } catch {
    return {
      host: DEFAULT_HOST,
      port: DEFAULT_PORT,
    };
  }
}

/**
 * Scrub list: environment variable prefixes and exact names that should NOT
 * be forwarded from the launching shell into the daemon process. These are
 * terminal-emulator, GUI-session, and cmux-session variables that can break
 * adapter initialization when the daemon runs detached.
 */
const ENV_SCRUB_PREFIXES = ["CODEX_", "GHOSTTY_", "XPC_", "__CF"];
// Routing state a managed environment may inject is byte-indistinguishable from opt-in, so
// it is ALWAYS scrubbed from the daemon env; bind intent crosses ONLY via the dedicated
// MULTI_AGENT_BIND_HOST (exported below when opts.host declares it). Any env var that
// doubles as client routing state must join this set: routing state silently becoming
// bind policy is the incident class this rules out.
const ROUTING_ENV_SCRUB = new Set(["MULTI_AGENT_HOST"]);

const ENV_SCRUB_EXACT = new Set([
  "CMUX_SOCKET_PATH",
  "CMUX_SURFACE_ID",
  "CMUX_WORKSPACE",
  "COLORTERM",
  "COMMAND_MODE",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TERMINFO",
]);

export function buildDaemonEnv(
  baseEnv: Record<string, string>,
  opts: {
    port: number;
    /**
     * Operator-explicit bind host. When undefined the daemon falls through to its default
     * loopback+tailscale-auto multi-bind path; there is NO env fallback, because an inherited
     * MULTI_AGENT_HOST is routing state and is scrubbed by ROUTING_ENV_SCRUB (an injected
     * routing env is byte-indistinguishable from opt-in). MULTI_AGENT_BIND_HOST is the only
     * env opt-in and passes through.
     */
    host?: string;
    db: string;
  },
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(baseEnv)) {
    if (ENV_SCRUB_EXACT.has(key)) continue;
    if (ROUTING_ENV_SCRUB.has(key)) continue; // routing env never crosses (see the set's contract)
    // CODEX_HOME is daemon topology/config-root state. Every other CODEX_*
    // value remains transient runtime/auth/session state and stays scrubbed.
    if (key !== "CODEX_HOME" && ENV_SCRUB_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    env[key] = value;
  }

  // The daemon runs one mode, and a CLI start is that mode: stated here rather than left to
  // the daemon's default, so a stale inherited value can never select something else.
  env["MULTI_AGENT_MODE"] = "managed";
  // Explicit MULTI_AGENT_* overrides — always win over inherited values
  env["MULTI_AGENT_PORT"] = String(opts.port);
  if (opts.host !== undefined) {
    // Declared intent exports the dedicated bind surface plus a COHERENT routing value
    // (seats/consumers route where the daemon actually binds).
    env["MULTI_AGENT_BIND_HOST"] = opts.host;
    env["MULTI_AGENT_HOST"] = opts.host;
  }
  env["MULTI_AGENT_DB"] = opts.db;

  return env;
}

// ── Bind-intent provenance and the listener adoption gate ──

/** Resolve OPERATOR BIND INTENT from the dedicated surfaces ONLY: the --host flag, the
 *  daemon.host config key read from the FILE, or the dedicated MULTI_AGENT_BIND_HOST env.
 *  A daemon.host value resolved from ENV is the overloaded routing channel
 *  (ENV_MAP maps daemon.host ← MULTI_AGENT_HOST) and NEVER creates intent. */
export function resolveBindIntent(input: {
  flagHost: string | undefined;
  envBindHost: string | undefined;
  configSource: string;
  configHost: string;
}): { explicit: boolean; host: string | undefined } {
  if (input.flagHost !== undefined) return { explicit: true, host: input.flagHost };
  const envBind = input.envBindHost?.trim() || undefined;
  if (envBind) return { explicit: true, host: envBind };
  if (input.configSource === "file") return { explicit: true, host: input.configHost };
  // "env"-sourced daemon.host is the overloaded routing channel — never intent;
  // "default" is no declaration at all.
  return { explicit: false, host: undefined };
}

/** The restored adoption/upgrade gate: derive the REQUIRED listener set from the
 *  daemon's reported effective bind mode (default ⇒ loopback AND
 *  tailscale-when-detected; explicit ⇒ exactly the declared host) and prove each by
 *  probing its own /healthz — binding evidence, never config echo. A silently dropped
 *  listener (the 0.5.3-receipt regression shape) fails LOUDLY. */
export async function verifyRequiredListeners(input: {
  bind: { mode: "explicit" | "default"; hosts: string[]; tailscaleDetected: boolean };
  port: number;
  /** TRI-STATE probe (r2 repair): "healthy" | "unhealthy" | "indeterminate".
   *  Refused/explicitly-unhealthy is POSITIVE bad-bind evidence; a transient probe
   *  exception is INDETERMINATE and never becomes missing-listener evidence. */
  probe: (url: string) => Promise<"healthy" | "unhealthy" | "indeterminate">;
}): Promise<
  | { ok: true; verified: string[] }
  | { ok: false; missing: string[]; reason: string }
  | { ok: "indeterminate"; reason: string }
> {
  const required = new Set(input.bind.hosts);
  required.add("127.0.0.1"); // loopback is required in EVERY mode's floor... except explicit
  if (input.bind.mode === "explicit") {
    required.clear();
    for (const h of input.bind.hosts) required.add(h);
  } else if (input.bind.tailscaleDetected && input.bind.hosts.length < 2) {
    // The 0.5.3-receipt regression shape: default mode, tailscale present, but the
    // daemon reports only one listener — the tailscale listener was silently dropped.
    return {
      ok: false,
      missing: ["<tailscale interface>"],
      reason:
        `required listener missing: default bind mode with a tailscale interface detected must bind loopback AND tailscale, but the daemon reports only [${input.bind.hosts.join(", ")}] — a silently dropped listener (the 0.5.3 receipt regression shape).`,
    };
  }
  const missing: string[] = [];
  const verified: string[] = [];
  const indeterminate: string[] = [];
  for (const host of required) {
    // NO catch-collapse here (r2 finding): the probe classifies its own errors; an
    // exception reaching this point is a wiring bug and should surface, not convert.
    const outcome = await input.probe(`http://${formatDaemonHostForUrl(host)}:${input.port}/healthz`);
    if (outcome === "healthy") verified.push(host);
    else if (outcome === "unhealthy") missing.push(host);
    else indeterminate.push(host);
  }
  if (indeterminate.length > 0) {
    // Indeterminate beats missing in precedence: with ANY listener unverifiable, the
    // gate has no complete evidence set and must not authorize a kill.
    return {
      ok: "indeterminate",
      reason: `listener state could not be checked for ${indeterminate.join(", ")} (transient probe failure) — the gate acts only on positive evidence and takes no action.`,
    };
  }
  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      reason: `required listener(s) not answering /healthz: ${missing.join(", ")} — binding evidence beats config echo; a reported host must prove itself.`,
    };
  }
  return { ok: true, verified };
}

function occupiedPortGuidance(port: number): string {
  return `Address already in use (EADDRINUSE) on port ${port}. Inspect the listener before stopping it, or run 'multi-agent daemon start --port <unused-port>'.`;
}

class StartupIdentityError extends Error {}
class StartupChildPendingError extends Error {}

export async function startDaemon(opts: StartOptions, deps: LifecycleDeps): Promise<DaemonState> {
  if (!deps.acquireStartLock) throw new Error("Daemon startup requires a local launch reservation");
  const lock = deps.acquireStartLock();
  let preserve = false;
  try {
    return await startOwnedDaemon(opts, deps, lock);
  } catch (error) {
    preserve = error instanceof StartupChildPendingError;
    throw error;
  } finally {
    lock.release(preserve);
  }
}

async function startOwnedDaemon(opts: StartOptions, deps: LifecycleDeps, lock: DaemonStartLock): Promise<DaemonState> {
  const port = opts.port ?? DEFAULT_PORT;
  const db = opts.db ?? DEFAULT_DB;
  // Preserve the user-explicit-vs-default distinction. `opts.host` is undefined when the
  // owner declared no bind host; healthz probes then use the loopback default, but
  // buildDaemonEnv must NOT export MULTI_AGENT_HOST so the daemon falls through to the
  // multi-bind default (loopback + tailscale auto-detect).
  const explicitHost = opts.host;
  const probeHost = explicitHost ?? DEFAULT_HOST;

  // Check if already running
  const existing = readState(deps);
  if (existing) {
    const pidState = await checkPid(existing, deps);
    if (pidState === "multi-agent") {
      // Our daemon is running (possibly unhealthy, but alive on our port)
      throw new Error(`Daemon already running (pid ${existing.pid} on port ${existing.port})`);
    }
    if (pidState === "unresponsive") {
      throw new Error(`Existing daemon process (pid ${existing.pid} on port ${existing.port}) is unresponsive — recover it before starting a new daemon.`);
    }
    // "dead" or "not_removed" → stale state, safe to proceed
  } else {
    let recoveredRunning = false;
    try {
      await fetchDaemonProbe(deps, `http://${formatDaemonHostForUrl(probeHost)}:${port}/healthz`, HEALTHZ_PROBE_TIMEOUT_MS);
      recoveredRunning = true;
    } catch (error) {
      // WSL2 can silently drop probes to an unused port. A slow live daemon can
      // also time out: do not run a second child's initialization against its DB.
      if (error instanceof HealthProbeTimeoutError && await deps.isPortOccupied?.(probeHost, port)) {
        throw new Error(occupiedPortGuidance(port));
      }
    }
    if (recoveredRunning) {
      throw new Error(`Daemon already running on port ${port}, but daemon state is missing`);
    }
  }
  const daemonEntry = path.join(getDaemonPath(), "dist/index.js");

  deps.mkdirp(MULTI_AGENT_DIR);

  const logOffset = deps.fileSize?.(LOG_FILE) ?? Buffer.byteLength(deps.readFile(LOG_FILE) ?? "");
  const logFd = deps.openForAppend(LOG_FILE);

  let child: ChildProcess;
  try {
    child = deps.spawn(process.execPath, [daemonEntry], {
    windowsHide: true,
    env: buildDaemonEnv(process.env as Record<string, string>, {
      port,
      host: explicitHost,
      db,
    }),
    stdio: ["ignore", logFd, logFd],
    detached: true,
    });
  } finally { deps.closeFile?.(logFd); }

  let childFailure: Error | undefined;
  let rejectExit!: (error: Error) => void;
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
  const failed = new Promise<never>((_, reject) => { rejectExit = reject; });
  // An error can arrive during synchronous publication/cleanup, between awaits.
  void failed.catch(() => {});
  const onError = (error: Error): void => {
    childFailure = new Error(`Daemon child failed to spawn: ${error.message}`);
    rejectExit(childFailure);
  };
  const onExit = (code: number | null, signal: string | null): void => {
    const startupLog = deps.readFileFrom
      ? deps.readFileFrom(LOG_FILE, logOffset) ?? ""
      : Buffer.from(deps.readFile(LOG_FILE) ?? "").subarray(logOffset).toString();
    const guidance = /\bEADDRINUSE\b/.test(startupLog)
      ? ` ${occupiedPortGuidance(port)}`
      : ` See ${LOG_FILE} for details.`;
    childFailure = new Error(`Daemon child ${child.pid ?? "unknown"} exited before startup completed (code ${code}, signal ${signal ?? "none"}).${guidance}`);
    rejectExit(childFailure);
    resolveExit();
  };
  child.once("error", onError);
  child.once("exit", onExit);
  child.unref();
  const pid = child.pid;
  const hasExited = (): boolean => child.exitCode != null || child.signalCode != null;
  const assertChild = (): void => {
    if (childFailure) throw childFailure;
    if (!Number.isSafeInteger(pid) || pid! <= 0) throw new Error("Daemon spawn returned no valid child PID");
    if (hasExited()) throw new Error(`Daemon child ${pid} exited before startup completed`);
  };
  const healthzUrl = `http://${formatDaemonHostForUrl(probeHost)}:${port}/healthz`;
  type StartHealth = { pid?: unknown; bind?: { mode: "explicit" | "default"; hosts: string[]; tailscaleDetected: boolean } };
  const readOwnedHealth = async (url: string): Promise<StartHealth | null> => {
    assertChild();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        failed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new HealthProbeTimeoutError(url)), HEALTHZ_PROBE_TIMEOUT_MS);
        }),
        (async () => {
          const res = await deps.fetch(url);
          if (!res.ok) return null;
          let body: StartHealth | null;
          try { body = res.json ? await res.json() as StartHealth : null; }
          catch { throw new StartupIdentityError(`Daemon startup identity unavailable at ${url}: expected child PID ${pid}; invalid health response`); }
          if (body?.pid !== pid) {
            throw new StartupIdentityError(`Daemon startup identity mismatch at ${url}: expected child PID ${pid}, observed ${typeof body?.pid === "number" ? body.pid : "unknown"}; state not published`);
          }
          assertChild();
          return body;
        })(),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  try {
    assertChild();
    lock.recordChild(pid!);
    let healthy = false;
    let lastProbe = "health endpoint not responding";
    for (let i = 0; i < HEALTHZ_RETRIES; i++) {
      try {
        const body = await readOwnedHealth(healthzUrl);
        if (body) {
          const bind = body.bind;
          if (!bind || !["explicit", "default"].includes(bind.mode) || !Array.isArray(bind.hosts)
            || bind.hosts.length === 0 || !bind.hosts.every((host) => typeof host === "string" && host.length > 0)
            || typeof bind.tailscaleDetected !== "boolean") {
            throw new StartupIdentityError(`Daemon startup listener identity unavailable for child PID ${pid}; state not published`);
          }
          const gate = await verifyRequiredListeners({ bind, port, probe: async (url) => {
            try { return await readOwnedHealth(url) ? "healthy" : "unhealthy"; }
            catch (error) {
              if (error instanceof StartupIdentityError || childFailure) throw error;
              const code = (error as { code?: string; cause?: { code?: string } }).code
                ?? (error as { cause?: { code?: string } }).cause?.code;
              return code === "ECONNREFUSED" ? "unhealthy" : "indeterminate";
            }
          } });
          if (gate.ok === false) throw new StartupIdentityError(`Daemon child ${pid} FAILED the listener adoption gate: ${gate.reason}`);
          if (gate.ok === true) { healthy = true; break; }
          lastProbe = gate.reason;
        }
      } catch (error) {
        assertChild();
        if (error instanceof StartupIdentityError) throw error;
        lastProbe = error instanceof Error ? error.message : String(error);
      }
      await Promise.race([new Promise((resolve) => setTimeout(resolve, HEALTHZ_DELAY_MS)), failed]);
    }
    if (!healthy) {
      throw new Error(`${summarizeDaemonStartFailure(healthzUrl, deps.readFile(LOG_FILE))}. Last probe: ${lastProbe}`);
    }
    assertChild();
    if (!deps.isProcessAlive(pid!)) throw new Error(`Daemon child ${pid} liveness could not be confirmed; state not published`);
    const state: DaemonState = { pid: pid!, port, host: probeHost, db, startedAt: new Date().toISOString() };
    try {
      deps.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
      assertChild();
      // A synchronous writer can outlast the process while exit events remain
      // undelivered. Recheck physical evidence on the other side of publication.
      if (!deps.isProcessAlive(pid!)) throw new Error(`Daemon child ${pid} liveness could not be confirmed at state publication; startup not accepted`);
    } catch (error) {
      removeMatchingState(deps, STATE_FILE, state);
      throw error;
    }
    return state;
  } catch (error) {
    // Only this launch's child may be cleaned up. A retained child also retains
    // the reservation so a retry cannot run another pre-bind initialization.
    // A failed ps is not exit evidence. This is our unreaped child: signal only
    // that PID, then release exclusion only after its own exit is observed.
    if (Number.isSafeInteger(pid) && pid! > 0 && !hasExited()) {
      try { deps.kill(pid!, "SIGTERM"); } catch { /* confirm exit below */ }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const gone = await Promise.race([
          exited.then(() => true),
          new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), DAEMON_STOP_WAIT_MS); }),
        ]);
        if (!gone) throw new StartupChildPendingError(`${error instanceof Error ? error.message : error}. Child PID ${pid} exit is unconfirmed; startup reservation retained. Inspect daemon-start.lock and daemon.log before recovery.`);
      } finally { if (timer) clearTimeout(timer); }
    }
    throw error;
  } finally {
    // A native spawn failure with no PID emits its error on the next turn.
    if (pid !== undefined || childFailure) child.off("error", onError);
    child.off("exit", onExit);
  }
}

function readShutdownReceipt(deps: LifecycleDeps, stateFile: string) {
  const receiptPath = path.join(path.dirname(stateFile), DAEMON_SHUTDOWN_RECEIPT);
  const raw = deps.readFile(receiptPath);
  let receipt: DaemonShutdownReceipt | undefined;
  try { receipt = JSON.parse(raw ?? "null") ?? undefined; } catch { /* unavailable */ }
  if (receipt?.schema !== "multi-agent.daemon-shutdown/v1" || !Number.isSafeInteger(receipt.pid) || receipt.pid <= 0
    || !Number.isFinite(Date.parse(receipt.startedAt)) || !(Date.parse(receipt.completedAt) >= Date.parse(receipt.startedAt))
    || !(Date.parse(receipt.completedAt) <= Date.now()) || typeof receipt.phase !== "string"
    || !Array.isArray(receipt.failures) || !["clean", "failed", "timed-out"].includes(receipt.outcome)) receipt = undefined;
  return { receipt, present: raw !== null || deps.exists(receiptPath), receiptPath };
}

function receiptMatchesState(receipt: DaemonShutdownReceipt | undefined, state: DaemonState, notBefore = Date.parse(state.startedAt)): boolean {
  return receipt?.pid === state.pid && Date.parse(receipt.startedAt) >= notBefore;
}

function isCleanShutdown(receipt: DaemonShutdownReceipt | undefined): boolean {
  return receipt?.outcome === "clean" && receipt.phase === "complete" && receipt.failures.length === 0;
}

function removeMatchingState(deps: LifecycleDeps, stateFile: string, state: DaemonState): void {
  // A concurrent start/rebind must not have its state removed by an old stop/status.
  const current = readState(deps);
  if (current?.pid === state.pid && current.startedAt === state.startedAt && current.port === state.port
    && current.host === state.host && current.db === state.db) deps.removeFile(stateFile);
}

/**
 * Ask a daemon to run its own bounded shutdown.
 *
 * A POSIX signal does this, but on Windows a process ends outright on SIGTERM and no handler
 * runs, so the workers it started outlive it. The daemon serves the owner's stop for exactly
 * that case. A refusal (an older daemon, a missing owner credential) answers false and the
 * caller falls back to the one signal it already sends.
 */
async function requestOwnerStop(deps: LifecycleDeps, target: string, state: DaemonState): Promise<boolean> {
  const token = deps.ownerToken ? deps.ownerToken() : null;
  if (!token) return false;
  try {
    const response = await fetchDaemonProbe(deps, `${target}/api/team-control/daemon/shutdown`,
      HEALTHZ_PROBE_TIMEOUT_MS, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    // The daemon answers 202 before it starts stopping, so an accepted request is the proof it
    // reached this daemon. A 404 is an older daemon; anything else was refused and the caller
    // falls back to the one signal.
    if (!response.ok) return false;
    // A daemon drains in its own order: it stops the listener before it ends the workers, so an
    // answered request is followed by the process going away rather than by an instant exit.
    const deadline = Date.now() + DAEMON_STOP_WAIT_MS;
    while (deps.isProcessAlive(state.pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return true;
  } catch { return false; }
}

export async function stopDaemon(deps: LifecycleDeps): Promise<"stopped" | "no-target" | "terminated"> {
  const state = readState(deps);
  const configured = resolveConfiguredDaemonTarget();
  const explicitUrl = process.env.MULTI_AGENT_URL;
  const stateUrl = state ? `http://${formatDaemonHostForUrl(state.host ?? DEFAULT_HOST)}:${state.port}` : undefined;
  const target = stateUrl ?? explicitUrl?.replace(/\/+$/, "") ?? `http://${formatDaemonHostForUrl(configured.host)}:${configured.port}`;
  if (stateUrl && explicitUrl && new URL(explicitUrl).origin !== new URL(stateUrl).origin) {
    throw new Error(`Cannot stop safely: addressed ${explicitUrl}/healthz does not match local PID ${state!.pid} at ${stateUrl}/healthz; no signal sent.`);
  }
  const check = `${target}/healthz`;
  const listener = async (): Promise<"responding" | "refused" | "unavailable"> => {
    try {
      await fetchDaemonProbe(deps, check, HEALTHZ_PROBE_TIMEOUT_MS);
      return "responding";
    } catch (error) {
      return isRefusedError(error) ? "refused" : "unavailable";
    }
  };
  // Windows has no graceful drain to verify: SIGTERM terminates the process outright, so the
  // daemon writes no shutdown receipt and the killed process resets the probe's pooled socket
  // instead of leaving the port refused. Bounded re-probe until the port settles.
  const settledListener = async (): Promise<"responding" | "refused" | "unavailable"> => {
    // The pre-signal identity check keeps the plain probe; only judgment after the one signal waits.
    if (deps.platform !== "win32") return listener();
    const deadline = Date.now() + WIN32_LISTENER_SETTLE_MS;
    for (;;) {
      const effect = await listener();
      if (effect !== "unavailable" || Date.now() >= deadline) return effect;
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  if (!state) {
    const effect = await listener();
    if (effect !== "refused") {
      throw new Error(`Daemon state is missing — cannot stop safely. Checked ${check}; listener ${effect}.`);
    }
    const stateFile = STATE_FILE;
    if (deps.exists(stateFile)) {
      throw new Error(`Daemon target state is unreadable; drain completion unverified. Checked ${check}; listener refused; no signal sent. Inspect ${stateFile}.`);
    }
    const prior = readShutdownReceipt(deps, stateFile);
    if (prior.present && !isCleanShutdown(prior.receipt)) {
      throw new Error(`Drain completion unverified: local shutdown evidence exists but no target state is recorded; cannot attribute it to ${target}. Checked ${check}; listener refused. Inspect ${prior.receiptPath}.`);
    }
    // No target is not a clean-drain verdict, including after an earlier clean stop.
    return "no-target";
  }
  const stateFile = STATE_FILE;

  const pidState = await checkPid(state, deps);
  if (pidState === "not_multi-agent") {
    throw new Error(`Cannot stop safely: PID ${state.pid} is present but identity is not confirmed at ${check}; no signal sent, state preserved.`);
  }

  let notBefore = Date.parse(state.startedAt);
  // True when the owner's stop was requested instead of a signal: the daemon then runs the same
  // bounded shutdown on every host.
  let requested = false;
  if (pidState !== "dead") {
    notBefore = Date.now();
    // A POSIX signal drains the daemon; hosts where it does not get the owner's stop, which
    // requests the same bounded shutdown. A daemon that cannot offer it gets the one signal,
    // and then the receipt below decides whether its drain was proved.
    requested = deps.platform === "win32" && await requestOwnerStop(deps, target, state);
    if (!requested) deps.kill(state.pid, "SIGTERM");
    // One request or signal. An already-exited target goes straight to the same judgment.
    const deadline = Date.now() + DAEMON_STOP_WAIT_MS;
    while (deps.isProcessAlive(state.pid) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const present = deps.isProcessAlive(state.pid);
  const effect = await settledListener();
  const observation = `targeted ${target}; checked ${check}; PID ${state.pid} ${present ? "present" : "absent"}; listener ${effect}`;
  if (present) {
    throw new Error(`Daemon did not exit after SIGTERM within ${DAEMON_STOP_WAIT_MS}ms; ${observation}` +
      (effect === "responding" ? " (still listening)" : "") + "; state file preserved.");
  }
  if (deps.platform === "win32" && !requested) {
    // Windows ends a process outright on SIGTERM, so this stop ran no drain and there is no
    // receipt to read. Identity was confirmed before the one signal; an absent PID with a
    // listener that is not responding is the strongest evidence this platform offers. A
    // still-responding listener stays an error.
    if (effect === "responding") throw new Error(`Daemon stop verification is unverified: ${observation}; state preserved.`);
    removeMatchingState(deps, stateFile, state);
    return "terminated";
  }
  if (effect !== "refused") throw new Error(`Daemon stop verification is unverified: ${observation}; state preserved.`);

  const { receipt, receiptPath } = readShutdownReceipt(deps, stateFile);
  if (!receiptMatchesState(receipt, state, notBefore)) {
    throw new Error(`Daemon process stopped; ${observation}; drain completion unverified (no matching shutdown receipt); state preserved. Inspect ${path.join(path.dirname(stateFile), "daemon.log")}.`);
  }
  if (!isCleanShutdown(receipt)) {
    throw new Error(`Daemon stopped with incomplete shutdown: ${receipt!.outcome}; phase=${receipt!.phase}; ${observation}. Pending effects are unverified; state preserved; inspect ${receiptPath}.`);
  }
  removeMatchingState(deps, stateFile, state);
  return "stopped";
}

/** Positive-down evidence classifier (lockstep with the daemon's
 *  crash-cart-detect semantics): ONLY a connection refusal is strong down evidence;
 *  a timeout / abort / anything else never proves the daemon dead. */
function isRefusedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const cause = (err as Error & { cause?: { code?: string } }).cause;
  const code = (err as Error & { code?: string }).code;
  return cause?.code === "ECONNREFUSED" || code === "ECONNREFUSED" || /refused/i.test(err.message);
}


export async function getDaemonStatus(
  deps: LifecycleDeps,
  options: GetDaemonStatusOptions = {},
): Promise<DaemonStatus> {
  // If MULTI_AGENT_URL is set, bypass daemon.json and probe that URL directly
  const multiAgentUrl = process.env.MULTI_AGENT_URL;
  if (multiAgentUrl) {
    try {
      const res = await probeHealthzWithSettle(deps, `${multiAgentUrl}/healthz`);
      const ev = await readHealthEvidence(res);
      const url = new URL(multiAgentUrl);
      return { state: "running", port: Number(url.port) || DEFAULT_PORT, host: url.hostname || DEFAULT_HOST, healthy: ev.healthy, reason: ev.reason, eventLoop: ev.eventLoop };
    } catch (err) {
      // 1ae863d2: refusal = positive down; anything else (timeout/wedged/blocked) = unverified.
      return isRefusedError(err) ? { state: "stopped" } : { state: "unverified", ...probeErrorCodeOf(err) };
    }
  }

  const state = readState(deps);
  if (!state) {
    const configured = resolveConfiguredDaemonTarget();
    try {
      const res = await probeHealthzWithSettle(deps, `http://${formatDaemonHostForUrl(configured.host)}:${configured.port}/healthz`);
      const ev = await readHealthEvidence(res);
      return {
        state: "running",
        port: configured.port,
        host: configured.host,
        healthy: ev.healthy,
        reason: ev.reason,
        eventLoop: ev.eventLoop,
      };
    } catch (err) {
      return isRefusedError(err) ? { state: "stopped" } : { state: "unverified", ...probeErrorCodeOf(err) };
    }
  }

  const liveness: ProcessLiveness = deps.processLiveness
    ? deps.processLiveness(state.pid)
    : deps.isProcessAlive(state.pid) ? "alive" : "dead";
  if (liveness === "dead") {
    // A status read must not erase the identity needed to judge a failed stop.
    const stateFile = STATE_FILE;
    const { receipt } = readShutdownReceipt(deps, stateFile);
    if (options.cleanupStaleState !== false && receiptMatchesState(receipt, state) && isCleanShutdown(receipt)) {
      removeMatchingState(deps, stateFile, state);
    }
    return { state: "stale" };
  }

  const host = state.host ?? DEFAULT_HOST;
  if (liveness === "unknown") {
    // This shell can neither signal nor inspect the recorded PID (a sandbox, or another
    // user's process). Never call that stale; let the daemon answer, and touch no state file.
    try {
      const res = await probeHealthzWithSettle(deps, `http://${formatDaemonHostForUrl(host)}:${state.port}/healthz`);
      const ev = await readHealthEvidence(res);
      return { state: "running", port: state.port, host, pid: state.pid, healthy: ev.healthy, reason: ev.reason, eventLoop: ev.eventLoop };
    } catch (err) {
      // 1ae863d2: refusal = positive down; anything else (timeout/wedged/blocked) = unverified.
      return isRefusedError(err) ? { state: "stopped" } : { state: "unverified", pid: state.pid, ...probeErrorCodeOf(err) };
    }
  }

  // Process alive — check healthz
  let healthy = false;
  let reason: DaemonStatus["reason"];
  let eventLoop: DaemonEventLoopEvidence | undefined;
  let probeFailure: Pick<DaemonStatus, "probeErrorCode"> = {};
  try {
    const res = await probeHealthzWithSettle(deps, `http://${formatDaemonHostForUrl(host)}:${state.port}/healthz`);
    const ev = await readHealthEvidence(res);
    healthy = ev.healthy;
    reason = ev.reason;
    eventLoop = ev.eventLoop;
  } catch (err) {
    // Pid alive but healthz timed out: the honest wedged-loop
    // signal. Report process-present/unhealthy (NOT "stopped") with the
    // "unresponsive" reason so the caller knows it's the control plane.
    reason = "unresponsive";
    probeFailure = probeErrorCodeOf(err);
  }

  // pid alive = running (state file preserved either way)
  return { state: "running", port: state.port, host, pid: state.pid, healthy, reason, eventLoop, ...probeFailure };
}

/** Keep the OS code of a failed health probe (absent for a timeout). */
function probeErrorCodeOf(err: unknown): Pick<DaemonStatus, "probeErrorCode"> {
  const code = connectionErrorCode(err);
  return code ? { probeErrorCode: code } : {};
}

export function readLogs(deps: LifecycleDeps): string | null {
  const logFile = LOG_FILE;
  if (!deps.exists(logFile)) return null;
  return deps.readFile(logFile);
}

export function tailLogs(deps: LifecycleDeps, opts: { follow: boolean }): void {
  const logFile = LOG_FILE;
  if (!deps.exists(logFile)) return;

  const args = opts.follow ? ["-f", logFile] : [logFile];
  const child = deps.spawn("tail", args, {
    windowsHide: true,
    env: process.env as Record<string, string>,
    stdio: "inherit" as unknown,
    detached: false,
  });
  child.unref();
}

/**
 * Read event-loop wedge evidence from a healthz probe result. A plain `{ ok: true }` (mocks,
 * or a monitor-less daemon) is healthy with no evidence. When the enriched body carries an
 * `eventLoop` block, its `healthy` verdict is honored (a starved loop that still answers
 * healthz reports process-present/unhealthy with the loop-lag evidence attached).
 */
async function readHealthEvidence(
  res: { ok: boolean; json?: () => Promise<unknown> },
): Promise<{ healthy: boolean; reason?: DaemonStatus["reason"]; eventLoop?: DaemonEventLoopEvidence }> {
  if (!res.ok) return { healthy: false };
  if (!res.json) return { healthy: true };
  try {
    const body = (await res.json()) as { eventLoop?: Partial<DaemonEventLoopEvidence> } | null;
    const el = body?.eventLoop;
    if (el && typeof el.healthy === "boolean" && typeof el.lagMeanMs === "number") {
      const eventLoop: DaemonEventLoopEvidence = {
        lagMeanMs: el.lagMeanMs,
        lagP99Ms: typeof el.lagP99Ms === "number" ? el.lagP99Ms : 0,
        utilization: typeof el.utilization === "number" ? el.utilization : 0,
        lastTickAgeMs: typeof el.lastTickAgeMs === "number" ? el.lastTickAgeMs : 0,
        healthy: el.healthy,
      };
      return el.healthy
        ? { healthy: true, eventLoop }
        : { healthy: false, reason: "event-loop-starved", eventLoop };
    }
  } catch {
    // Body absent / not JSON — treat as plain healthy (res.ok already true).
  }
  return { healthy: true };
}

async function fetchDaemonProbe(deps: LifecycleDeps, url: string, timeoutMs: number,
  init?: { method: string; headers: Record<string, string> }): Promise<{ ok: boolean; json?: () => Promise<unknown> }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      init ? deps.fetch(url, init) : deps.fetch(url),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new HealthProbeTimeoutError(url)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Status-probe-LOCAL bounded settle/retry around fetchDaemonProbe. A single /healthz
 * fetch loses to the post-restart listener bind window (process up but not yet accepting), yielding
 * a false 'down'/'unhealthy'. Retry a HARD-BOUNDED number of attempts with a short backoff so the
 * status probe reflects the ACTUAL /healthz answer. Bounded by construction: a genuine-down answers
 * nothing, every attempt fails, the final error is rethrown (reported as stopped/unhealthy) — never
 * masked, never an unbounded wait. Used ONLY by getDaemonStatus; start/stop/checkPid keep their own
 * timing (start already has its own poll loop).
 */
async function probeHealthzWithSettle(deps: LifecycleDeps, url: string): Promise<{ ok: boolean; json?: () => Promise<unknown> }> {
  const sleep = deps.sleep ?? defaultSleep;
  // ONE ~5s deadline for the whole status probe. Each attempt gets the REMAINING
  // budget (never a fresh 5s), so a slow-but-answering /healthz is observed within
  // the window. A probe TIMEOUT means the deadline is spent -> stop (no re-allocation);
  // only IMMEDIATE connection errors (the post-restart bind window) retry, bounded by
  // BOTH the attempt cap and the deadline. Genuine connection-refusal exhausts the
  // bounded retries and is rethrown (reported stopped/unhealthy) — never masked.
  const deadline = Date.now() + STATUS_PROBE_DEADLINE_MS;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= STATUS_PROBE_MAX_ATTEMPTS; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      return await fetchDaemonProbe(deps, url, remaining);
    } catch (err) {
      lastErr = err;
      if (err instanceof HealthProbeTimeoutError) break; // deadline spent — do not re-allocate a new window
      if (attempt < STATUS_PROBE_MAX_ATTEMPTS && Date.now() + STATUS_PROBE_RETRY_DELAY_MS < deadline) {
        await sleep(STATUS_PROBE_RETRY_DELAY_MS);
      }
    }
  }
  throw lastErr;
}
