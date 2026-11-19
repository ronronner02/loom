'use strict';
/**
 * Electron main-process bridge for the native utility-process daemon.
 *
 * Responsibilities:
 * - Fork the built daemon entry (engine-host.js) as an Electron utility process.
 * - Pass the data directory, the loopback bind host, and the daemon's environment.
 * - Receive the bound port, the health identity, dependency status, and pairing codes over
 *   `parentPort` IPC.
 * - Expose readiness, exit, and shutdown lifecycle to the caller.
 * - On quit: send shutdown to the child, wait for the bounded receipt, then end the child.
 *
 * Every piece of process state belongs to the handle `startEngine` returns. A late exit from a
 * replaced child therefore cannot settle a later child's readiness, mint or shutdown.
 *
 * The `require('electron')` call is lazy so tests that mock it via `vm.runInContext` can load
 * this module without an actual Electron binary.
 */

const path = require('node:path');

/**
 * Fork the daemon as a utility process.
 *
 * @param {object} opts
 * @param {string} opts.dataDir  – the daemon's mutable state directory
 * @param {object} opts.env      – the daemon's environment (the owner's own, plus managed overrides)
 * @param {(exit: { code: number|null, reason: string }) => void} [opts.onExit]
 *   called for every child exit the caller did not ask for
 * @returns {{ ready: Promise<{ port: number, pid: number }>, shutdown: () => Promise<void>,
 *             mintPairing: () => Promise<string>, dependencies: () => Promise<unknown[]>,
 *             isRunning: () => boolean, port: () => number|null, kill: () => void }}
 */
function startEngine(opts) {
  const { dataDir, env, onExit } = opts;

  // Lazy require so tests can mock electron.
  const electron = require('electron');

  // The entry that runs inside the utility child.
  const entry = path.resolve(__dirname, 'engine-host.js');

  /** Everything this one child owns. Nothing here outlives the returned handle. */
  const state = {
    child: null,
    /** True once the child has exited or been killed. */
    gone: false,
    /** True from the moment this app asked the child to stop, so that exit is expected. */
    stopping: false,
    port: null,
    mint: null,
    dependencies: null,
  };
  let resolveReady = null;
  let rejectReady = null;

  /** Settle one in-flight request slot once and clear it. */
  function settle(slot, error, value) {
    const pending = state[slot];
    state[slot] = null;
    if (!pending) return;
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(value);
  }

  const settleMint = (error, code) => settle('mint', error, code);
  const settleDependencies = (error, resolutions) => settle('dependencies', error, resolutions);

  /** Settle readiness once and clear the pair. */
  function settleReady(error, value) {
    const resolve = resolveReady;
    const reject = rejectReady;
    resolveReady = null;
    rejectReady = null;
    if (error) { if (reject) reject(error); }
    else if (resolve) resolve(value);
  }

  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  state.child = electron.utilityProcess.fork(entry, [], {
    env,
    execArgv: [],
    serviceName: 'loom-daemon',
    stdio: 'pipe',
  });
  const child = state.child;

  // Forward the daemon's own output so a startup failure is visible in the desktop log rather
  // than silent.
  if (child.stdout) child.stdout.on('data', (chunk) => { try { process.stdout.write(`[daemon] ${chunk}`); } catch { /* ignore */ } });
  if (child.stderr) child.stderr.on('data', (chunk) => { try { process.stderr.write(`[daemon] ${chunk}`); } catch { /* ignore */ } });

  child.on('message', (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'ready') {
      state.port = message.port;
      settleReady(null, { port: message.port, pid: message.pid });
    }
    if (message.type === 'crash') {
      settleReady(new Error(`Daemon crash: ${message.error}`));
    }
    // The daemon's answer to a `mint-pairing` request. The code is handed straight back to the
    // caller and never logged; on failure only the error name is reported.
    if (message.type === 'pairing-code') settleMint(null, message.code);
    if (message.type === 'pairing-error') settleMint(new Error(message.error || 'pairing_mint_failed'));
    // First-run dependency status, resolved by the daemon's own resolver.
    if (message.type === 'dependencies') settleDependencies(null, message.resolutions);
    if (message.type === 'dependencies-error') settleDependencies(new Error(message.error || 'dependency_probe_failed'));
  });

  child.on('exit', (code) => {
    // A late exit from a child this handle no longer owns settles nothing and reports nothing.
    if (state.child !== child) return;
    const expected = state.stopping;
    state.gone = true;
    state.child = null;
    state.port = null;
    settleReady(new Error(`Daemon exited with code ${code} before ready`));
    settleMint(new Error('Daemon exited during pairing mint'));
    settleDependencies(new Error('Daemon exited during the dependency probe'));
    if (!expected && typeof onExit === 'function') onExit({ code, reason: `exit code ${code}` });
  });

  /** Ask the daemon to run its own bounded shutdown, then end what is left of the child. */
  const shutdown = async () => {
    if (state.gone || !state.child) return;
    state.stopping = true;
    const current = state.child;
    try { current.postMessage({ type: 'shutdown' }); } catch { /* child already gone */ }
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 12_000);
      current.once('exit', () => { clearTimeout(timeout); resolve(); });
    });
    // End the child if the bounded wait did not.
    if (state.child === current) {
      try { current.kill(); } catch { /* already gone */ }
    }
    state.gone = true;
    state.child = null;
    state.port = null;
    settleMint(new Error('Daemon stopped during pairing mint'));
    settleDependencies(new Error('Daemon stopped during the dependency probe'));
  };

  /**
   * Mint one one-time pairing code over the private parent channel.
   *
   * Only the daemon's own parent process can reach this port, so the code never has to travel
   * over HTTP or sit in an environment variable. The returned value is the raw code; the caller
   * exchanges it and must never log it or put it in a URL.
   */
  const mintPairing = () => {
    if (state.gone || !state.child) return Promise.reject(new Error('Daemon is not running'));
    if (state.mint) return Promise.reject(new Error('A pairing mint is already in flight'));
    const current = state.child;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => settleMint(new Error('Pairing mint timed out')), 10_000);
      state.mint = { resolve, reject, timer };
      try { current.postMessage({ type: 'mint-pairing' }); } catch (error) { settleMint(error); }
    });
  };

  /**
   * Ask the daemon what it resolved for `git`, `gh`, `claude` and `codex`.
   *
   * The daemon answers with its own resolver's output, so the first-run page shows the same
   * paths a worker launch will use. Nothing is resolved a second time in Electron.
   */
  const dependencies = () => {
    if (state.gone || !state.child) return Promise.reject(new Error('Daemon is not running'));
    if (state.dependencies) return Promise.reject(new Error('A dependency probe is already in flight'));
    const current = state.child;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => settleDependencies(new Error('Dependency probe timed out')), 10_000);
      state.dependencies = { resolve, reject, timer };
      try { current.postMessage({ type: 'dependencies' }); } catch (error) { settleDependencies(error); }
    });
  };

  /** Force-kill this child immediately, without a shutdown receipt. */
  const kill = () => {
    if (!state.gone && state.child) {
      state.stopping = true;
      try { state.child.kill(); } catch { /* already gone */ }
    }
    state.gone = true;
    state.child = null;
    state.port = null;
    settleMint(new Error('Daemon killed during pairing mint'));
    settleDependencies(new Error('Daemon killed during the dependency probe'));
  };

  return {
    ready,
    shutdown,
    mintPairing,
    dependencies,
    isRunning: () => !state.gone && state.child !== null,
    port: () => state.port,
    kill,
  };
}

module.exports = { startEngine };
