'use strict';
/**
 * The Loom desktop window.
 *
 * The daemon is this app's own child: Electron forks it as a utility process, the daemon binds
 * loopback on an OS-assigned port, and reports that origin back over the private parent channel.
 * The window then pairs itself and loads the daemon's own Web UI. Nothing this app shows comes
 * from an external process or a fixed port.
 *
 * Three rules shape the wiring below:
 *  - The window may only ever show the daemon's current loopback origin, plus its own local
 *    first-run page. Every other navigation is refused, and external links open in the user's
 *    browser instead.
 *  - No credential is logged, written outside the daemon's own cookie jar, or placed in a URL.
 *    The owner session comes from the daemon's own pairing flow.
 *  - The engine this app starts is the engine this app stops. Quitting, or Stop engine, runs the
 *    daemon's bounded shutdown and leaves no child behind.
 *
 * `lifecycle.js` owns the engine's state; this file wires the modules and the app lifecycle.
 */
const { app, Menu, ipcMain, session } = require('electron');
const path = require('node:path');

const engineBridge = require('./engine-bridge.js');
const { daemonEntry } = require('./engine-paths.js');
const { createWindowModule, FIRST_RUN_URL } = require('./window.js');
const pairing = require('./pairing.js');
const { createLifecycleModule, countRunningAttemptsAt } = require('./lifecycle.js');
const { createViewModule } = require('./view.js');
const { createIpcModule } = require('./ipc.js');

const DAEMON_ENTRY = daemonEntry();

// The stable data directory. Production is %LOCALAPPDATA%\Loom; a test or a manual run
// points LOOM_DESKTOP_DATA_DIR somewhere else. When Windows reports no per-user local
// application data, the app's own userData directory is the only correct fallback: never Roaming.
const DATA_DIR_ROOT = process.env.LOOM_DESKTOP_DATA_DIR
  || path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'Loom');

let state = { phase: 'checking', message: 'Starting the local engine…', dependencies: null, connected: false };
let csrfToken = null;

function publicState() {
  return {
    phase: state.phase,
    message: state.message,
    connected: state.connected,
    dependencies: state.dependencies,
  };
}

function publish(patch) {
  state = { ...state, ...patch };
  const window = windowModule.getWindow();
  if (window && !window.isDestroyed()) window.webContents.send('desktop:state', publicState());
}

const windowModule = createWindowModule({ publish, getOrigin: () => lifecycle.getOrigin() });

const view = createViewModule({
  windowModule,
  publish,
  setCsrfToken: token => { csrfToken = token; },
  settleDelay: ms => new Promise(resolve => setTimeout(resolve, ms)),
});

const lifecycle = createLifecycleModule({
  publish,
  bridge: engineBridge,
  dataDirRoot: DATA_DIR_ROOT,
  daemonEntry: DAEMON_ENTRY,
  connect: engine => view.openTeamView(engine),
  showFirstRunPage: () => view.showFirstRunPage(),
  countRunningAttempts: () => countRunningAttemptsAt(lifecycle.getOrigin()),
  getWindow: () => windowModule.getWindow(),
});

const ipc = createIpcModule({
  getWindow: () => windowModule.getWindow(),
  getOrigin: () => lifecycle.getOrigin(),
  getCsrfToken: () => csrfToken,
  pairOwnerSession: () => pairing.pairOwnerSession(lifecycle.getEngine(), lifecycle.getOrigin()),
});

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: 'Engine', submenu: [
      { label: 'Open in browser', click: () => void view.openInBrowser(lifecycle) },
      { label: 'Reconnect', click: () => void lifecycle.reconnect() },
      { label: 'Stop engine', click: () => void lifecycle.stop() },
      { label: 'Reload window', accelerator: 'CmdOrCtrl+R', click: () => windowModule.reload() },
      { type: 'separator' },
      { label: 'Quit', role: 'quit' },
    ] },
    { label: 'View', submenu: [
      { role: 'togglefullscreen' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' },
    ] },
  ]);
}

/**
 * The first-run page's Reconnect action. While a start or stop is in flight this joins it and
 * returns the projected status, so the page never sees a stale phase.
 */
async function reconnectEngine() {
  await lifecycle.reconnect();
  return publicState();
}

if (!app.requestSingleInstanceLock()) {
  // A second launch hands focus to the window that already exists, which owns the one engine.
  app.quit();
} else {
  app.on('second-instance', () => {
    const window = windowModule.getWindow();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(buildMenu());

    ipc.register(ipcMain, {
      getState: publicState,
      getEngineStatus: () => ({ running: lifecycle.getEngine() !== null, pid: lifecycle.getPid(), exit: lifecycle.getExit() }),
      reconnectEngine,
    });

    // This page shows local data and needs no device access.
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));

    // Window close and menu Quit share one close decision, from `lifecycle.js`.
    windowModule.createWindow({ onClose: lifecycle.requestQuit });
    void lifecycle.start();
  });

  app.on('before-quit', lifecycle.requestQuit);

  // Closing the last window quits the app, which triggers before-quit above.
  app.on('window-all-closed', () => app.quit());
}

// The preload's synchronous token hand-off compares against this module's own page URL.
module.exports = { FIRST_RUN_URL };