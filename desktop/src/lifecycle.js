'use strict';
/**
 * The engine lifecycle: one state variable, and every UI action valid or a no-op in each state.
 *
 *   stopped --start--> starting --connected--> running --stop--> stopping --exit--> stopped
 *                        |                      |
 *                        +--failure--> stopped +--unreachable--> unreachable
 *                                               |
 *                                               +--unexpected exit--> stopped
 *
 * `unreachable` is a live child whose page could not be paired or loaded: Reconnect pairs again,
 * Stop ends it, and quitting still asks because the activity count is unknown. A failed start
 * publishes `start-failed`; a start the owner stopped mid-way publishes only `stopped`, because
 * the stop is the outcome the owner asked for and not a failure to report.
 *
 * The engine is this app's child: whatever this module started is what it stops, and quitting
 * runs the daemon's own bounded shutdown.
 *
 * `connect` and `showFirstRunPage` receive the live lifecycle, so the view can read the engine
 * and its origin without importing this module.
 */
const { app, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { dependencyRows } = require('./dependencies.js');

/**
 * @param {object} opts
 * @param {(patch: object) => void} opts.publish – send a status patch to the window
 * @param {object} opts.bridge – `engine-bridge.js`
 * @param {() => string} opts.dataDirRoot – the app's data root; the engine's own state sits in `engine/`
 * @param {string} opts.daemonEntry – the daemon module to fork
 * @param {() => {dataRoot: string, outcome: string, error: Error|null}} opts.migrateInstallation – move a carried-over installation before the engine starts
 * @param {(root: string) => void} opts.updateDataDirRoot – adopt the root the migration settled on
 * @param {(lifecycle: object) => Promise<boolean>} opts.connect – health-check, pair and load the UI
 * @param {(lifecycle: object) => void} opts.showFirstRunPage – replace an orphaned engine page
 * @param {() => Promise<number|undefined>} opts.countRunningAttempts – the quit probe
 * @param {() => object|null} opts.getWindow – the window a dialog should parent to, if any
 */
function createLifecycleModule(opts) {
  const { publish, bridge, dataDirRoot, migrateInstallation, updateDataDirRoot, daemonEntry, connect, showFirstRunPage, countRunningAttempts, getWindow } = opts;

  /** The one engine lifecycle variable. Everything below transitions it or reads it. */
  let phase = 'stopped';
  /** The forked engine, from the fork until its shutdown finishes. */
  let engine = null;
  let enginePid = null;
  /** The one origin the window may show. Null until the engine reports one. */
  let origin = null;
  /** Why the engine stopped on its own, when it was not this app that stopped it. */
  let engineExit = null;
  /** The in-flight startup, so a second action joins it instead of forking a second child. */
  let startup = null;
  /** The in-flight shutdown, for the same reason. */
  let shutdown = null;
  let quitting = false;
  let quitCheck = null;

  const isStarting = () => phase === 'starting';
  /** The engine is up: `running` and `unreachable` both own a live child and an origin. */
  const hasLiveEngine = () => phase === 'running' || phase === 'unreachable';

  function clearEngine() {
    engine = null;
    enginePid = null;
    origin = null;
  }

  /**
   * The engine's environment. It inherits this process's own, so the daemon reads the owner's
   * real HOME/USERPROFILE/CODEX_HOME/CLAUDE_CONFIG_DIR and finds the sign-in already there. The
   * overrides below are the managed-mode contract only.
   */
  function engineEnv(dataDir) {
    const env = {
      ...process.env,
      LOOM_HOME: dataDir,
      LOOM_MODE: 'managed',
      // Loopback only: no LAN or Tailscale fallback.
      LOOM_BIND_HOST: '127.0.0.1',
      // The team UI is enabled by environment (settings-store ENV_MAP) instead of writing
      // config.json, which would overwrite the owner's settings.
      LOOM_UI_ENABLED: 'true',
    };
    delete env.LOOM_OWNER_TOKEN;
    return env;
  }

  function publishFailed(error) {
    clearEngine();
    phase = 'stopped';
    startup = null;
    console.error(`[desktop] engine start failed: ${error.message}`);
    publish({ phase: 'start-failed', message: `The engine did not start: ${error.message}`, connected: false });
  }

  async function runStart() {
    const migration = migrateInstallation?.();
    if (migration?.error) {
      // A half-moved installation is never started against; the error names both paths.
      publishFailed(migration.error);
      return;
    }
    if (migration?.outcome === 'moved') {
      updateDataDirRoot?.(migration.dataRoot);
      console.log(`[desktop] data folder moved to ${migration.dataRoot}`);
    }
    const dataDir = path.join(dataDirRoot(), 'engine');
    fs.mkdirSync(dataDir, { recursive: true });

    let started;
    try {
      started = bridge.startEngine({ dataDir, env: engineEnv(dataDir), onExit: onEngineExit });
    } catch (error) {
      publishFailed(error);
      return;
    }
    engine = started;
    try {
      const ready = await started.ready;
      if (!isStarting()) return; // the owner stopped first; the stop owns the shutdown
      enginePid = ready.pid;
      origin = `http://127.0.0.1:${ready.port}`;
      console.log(`[desktop] engine ready pid=${ready.pid} origin=${origin}`);
      publish({ phase: 'checking', message: 'Reading the local engine…' });
      const rows = await readDependencies(started);
      console.log(`[desktop] dependencies ${rows.map(row => `${row.client}=${row.ok ? row.path : row.reason}`).join(' ')}`);
      if (!isStarting()) return;
      publish({ dependencies: rows });
      const connected = await connect(api);
      if (!isStarting()) return;
      if (connected) { phase = 'running'; return; }
      // The page could not use the engine. If the child also went away, that is a failed start;
      // otherwise the engine is alive with no window on it, and Reconnect pairs again.
      if (!started.isRunning()) {
        try { await started.shutdown(); } catch { /* already gone */ }
        publishFailed(new Error('the engine stopped while the window was connecting'));
        return;
      }
      phase = 'unreachable';
    } catch (error) {
      if (!isStarting()) return; // stopped, or already reported; the deciding path publishes
      try { await started.shutdown(); } catch { /* already gone */ }
      if (!isStarting()) return;
      publishFailed(error);
    }
  }

  /**
   * The first-run dependency list, from the daemon's own resolver.
   *
   * This reads the daemon's answer rather than resolving a second time, so a path the first-run
   * page shows is the path a worker launch will use.
   */
  async function readDependencies(current) {
    let resolutions = [];
    try {
      resolutions = await current.dependencies();
    } catch (error) {
      console.error('[desktop] dependency probe failed:', error.message);
      resolutions = [];
    }
    return dependencyRows(resolutions);
  }

  /**
   * Fork the daemon and connect the window to it. A no-op unless the engine is stopped.
   *
   * One call owns the whole startup: the daemon reports readiness on a dynamic port, the window
   * pairs over the daemon's private parent channel, and only then does the window load the origin.
   */
  async function start() {
    if (phase !== 'stopped') return startup;
    if (!fs.existsSync(daemonEntry)) {
      publish({ phase: 'engine-missing', message: 'The engine build is missing. Build it, then Reconnect.', connected: false });
      return null;
    }
    engineExit = null;
    phase = 'starting';
    publish({ phase: 'starting', message: 'Starting the local engine…', connected: false });
    startup = runStart();
    return startup;
  }

  /**
   * Stop the engine this app owns. Valid whenever it owns one; a no-op otherwise.
   *
   * The bridge sends the daemon's own shutdown message and waits for its bounded receipt, then
   * ends what is left of the child's tree. Quitting and the menu action both come here.
   */
  function stop(reason = 'menu') {
    if (phase === 'stopped') return Promise.resolve();
    if (phase === 'stopping') return shutdown;
    const wasStarting = phase === 'starting';
    phase = 'stopping';
    origin = null;
    enginePid = null;
    // A child that has not reported ready cannot run the daemon's graceful shutdown, so a stop
    // during startup ends it directly. Its pending readiness then settles, and the start returns
    // without publishing a failure: the owner asked for this end.
    if (wasStarting && engine) engine.kill();
    shutdown = (async () => {
      if (startup) await startup.catch(() => {});
      const current = engine;
      if (current) {
        try { await current.shutdown(); } catch (error) { console.error('engine shutdown failed:', error.message); }
      }
      clearEngine();
      phase = 'stopped';
      startup = null;
      shutdown = null;
      console.log('[desktop] engine stopped');
      if (reason !== 'quit') publish({ phase: 'stopped', message: 'The local engine is stopped.', connected: false });
    })();
    return shutdown;
  }

  /**
   * Reconnect: start the engine when it is stopped, pair the window again when it is up. While a
   * start or a stop is in flight this joins it and publishes nothing, because that transition
   * already owns the phases the owner sees.
   */
  async function reconnect() {
    if (phase === 'starting') { await startup.catch(() => {}); return; }
    if (phase === 'stopping') return;
    if (hasLiveEngine()) {
      const connected = await connect(api);
      if (!connected && phase === 'running') phase = 'unreachable';
      else if (connected) phase = 'running';
      return;
    }
    await start();
  }

  /**
   * What a daemon exit that this app did not ask for means.
   *
   * A live engine that goes away is a crash: the page the window shows now belongs to a daemon
   * that is gone, so the window moves to the page that owns the reconnect action. An exit during
   * startup is the startup path's own failure to report, so this ignores it.
   */
  function onEngineExit(exit) {
    if (!hasLiveEngine()) return;
    clearEngine();
    engineExit = exit;
    phase = 'stopped';
    console.error(`[desktop] engine exited unexpectedly: ${exit.reason}`);
    publish({ phase: 'engine-exited', message: `The local engine stopped (${exit.reason}).`, connected: false });
    showFirstRunPage();
  }

  /**
   * Confirm and then quit.
   *
   * Electron makes its close decision synchronously; the activity probe and the dialog run
   * after. Running attempt state comes from the engine's own `/healthz` projection, and an
   * unknown answer asks rather than assumes idleness.
   */
  function requestQuit(event) {
    // The quit this module started continues; only a fresh close is held for confirmation.
    if (quitting) return;
    if (phase === 'stopped') return; // nothing this app owns is running: let the close through
    if (event) event.preventDefault();
    if (quitCheck) return;
    quitCheck = (async () => {
      // A start still in flight has no answer to ask about; stopping it is the whole decision.
      if (hasLiveEngine()) {
        // Only a non-negative integer is a count. Anything else is unknown, and unknown asks.
        const answer = await countRunningAttempts();
        const count = Number.isSafeInteger(answer) && answer >= 0 ? answer : undefined;
        if (count === undefined || count > 0) {
          const options = {
            type: 'warning',
            buttons: ['Stop agents and quit', 'Keep running'],
            defaultId: 1,
            cancelId: 1,
            title: count === undefined ? 'Agents may be running' : `Agents are running (${count})`,
            message: 'Closing stops the running agents. Resume continues the work next time you open the app.',
          };
          const currentWindow = getWindow();
          const result = currentWindow && !currentWindow.isDestroyed()
            ? await dialog.showMessageBox(currentWindow, options)
            : await dialog.showMessageBox(options);
          if (result.response !== 0) return;
        }
      }
      await stop('quit');
      quitting = true;
      app.quit();
    })().catch((error) => {
      quitting = false;
      console.error(`[desktop] quit failed: ${error.message}`);
    }).finally(() => { quitCheck = null; });
  }

  const api = {
    start,
    stop,
    reconnect,
    requestQuit,
    phase: () => phase,
    getEngine: () => engine,
    getOrigin: () => origin,
    getPid: () => enginePid,
    getExit: () => engineExit,
  };
  return api;
}

/** The running attempt count from the engine's own health projection. */
async function countRunningAttemptsAt(origin) {
  if (!origin) return undefined;
  try {
    const response = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(2_500) });
    if (!response.ok) return undefined;
    const body = JSON.parse(await response.text());
    return Number.isSafeInteger(body.runningAttempts) && body.runningAttempts >= 0 ? body.runningAttempts : undefined;
  } catch {
    return undefined;
  }
}

module.exports = { createLifecycleModule, countRunningAttemptsAt };