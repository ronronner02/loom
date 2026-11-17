'use strict';
/**
 * A whole desktop app in a `vm` context: real `src/` modules, mocked Electron, a fake engine
 * bridge and a fake daemon on the other end of `fetch`.
 *
 * The fixture drives `main.js`, so what it exercises is the wiring the app actually ships: the
 * lifecycle state machine, the pairing handshake, the IPC handlers and the quit path.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const originRules = require('../../src/origin.js');
const { dependencyRows } = require('../../src/dependencies.js');
const enginePaths = require('../../src/engine-paths.js');
const { desktopContext } = require('./desktop-context.js');

const SRC = path.resolve(__dirname, '..', '..', 'src');
const PORT = 58123;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PID = 4321;

/**
 * Let the async startup chain settle: fork → ready → health → probe → mint → exchange → load.
 */
const settle = async () => {
  for (let i = 0; i < 12; i += 1) await new Promise(resolve => setImmediate(resolve));
};

/**
 * @param {object} [opts]
 * @param {object} [opts.ready] – the readiness the fake daemon reports
 * @param {Error} [opts.readyError] – a start that never reaches ready
 * @param {boolean} [opts.engineEntryExists] – whether the daemon build is on disk
 * @param {number|Function} [opts.runningAttempts] – what the desktop's health probe reads
 * @param {Function} [opts.countRunningAttempts] – replace the quit probe outright
 * @param {number} [opts.closeResponse] – the close dialog's answer
 * @param {Error} [opts.dependenciesError] – a failing first-run dependency probe
 * @param {Function} [opts.fetch] – replace the fake daemon entirely
 */
function desktopApp(opts = {}) {
  const ready = opts.ready ?? { port: PORT, pid: PID };
  const runningAttempts = opts.runningAttempts ?? 0;
  const loaded = [];
  const messageBoxes = [];
  const lifecycleHandlers = new Map();
  const contentsHandlers = new Map();
  const windowHandlers = new Map();
  const ipcHandlers = new Map();
  const cookies = [];
  const clipboardWrites = [];
  const externalUrls = [];
  const mints = [];
  const exchangeRequests = [];
  const shutdowns = [];
  const startArgs = [];
  let windowOptions = null;
  let capturedMenu = null;
  let windowCount = 0;
  /** The live window, once `main.js` has created it. */
  let activeWindow = () => null;
  let exitListener = null;
  let mintIndex = 0;
  const mintCode = opts.mintCode || (() => 'M'.repeat(40) + String(++mintIndex).padStart(3, '0'));
  /** Resolvers the fake bridge hands back, so a test can let a startup finish when it chooses. */
  const pendingReady = [];

  const mainFrame = { url: 'file:///first-run.html' };
  /** Every status the main process published to the window, in order. */
  const published = [];
  const contents = {
    mainFrame,
    on(event, fn) { contentsHandlers.set(event, fn); },
    send(channel, status) { if (channel === 'desktop:state') published.push(status); },
    setWindowOpenHandler() {},
    reload() {},
    getURL() { return mainFrame.url; },
  };

  class Window {
    constructor(value) { windowOptions = value; this.webContents = contents; this.destroyed = false; }
    once() {}
    on(event, fn) {
      const list = windowHandlers.get(event) || [];
      list.push(fn);
      windowHandlers.set(event, list);
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    restore() {}
    focus() { this.focused = true; }
    show() {}
    close() {
      if (this.destroyed) return;
      this.destroyed = true;
      for (const handler of windowHandlers.get('closed') || []) handler();
    }
    loadURL(url) { loaded.push(url); return Promise.resolve(); }
  }

  const app = {
    requestSingleInstanceLock: () => true,
    // Event handlers accumulate, as they do in Electron.
    on(event, fn) {
      const list = lifecycleHandlers.get(event) || [];
      list.push(fn);
      lifecycleHandlers.set(event, list);
    },
    whenReady: () => Promise.resolve(),
    // Emit a lifecycle event and report whether the app's handler prevented the default.
    emit(event) {
      const handlers = lifecycleHandlers.get(event) || [];
      if (!handlers.length) return false;
      let prevented = false;
      const closeEvent = { defaultPrevented: false, preventDefault() { prevented = true; this.defaultPrevented = true; } };
      for (const handler of handlers) handler(closeEvent);
      return prevented;
    },
    quit() {
      let prevented = false;
      for (const handler of lifecycleHandlers.get('before-quit') || []) {
        handler({ preventDefault: () => { prevented = true; } });
      }
      if (!prevented) activeWindow()?.close();
      return prevented;
    },
    getPath: name => name === 'appData' ? path.join('D:', 'ma', 'tmp', 'appData') : path.join('D:', 'ma', 'tmp', 'userData'),
  };

  const electron = {
    app,
    BrowserWindow: Window,
    session: { defaultSession: { cookies: { set: async (cookie) => { cookies.push(cookie); } }, setPermissionRequestHandler() {} } },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 940 } }) },
    dialog: {
      showOpenDialog: async () => (opts.openDialog ?? { canceled: true, filePaths: [] }),
      showMessageBox: async (...args) => {
        const box = args.length === 2 ? args[1] : args[0];
        messageBoxes.push(box);
        return { response: typeof opts.closeResponse === 'function' ? opts.closeResponse(box) : (opts.closeResponse ?? 1) };
      },
    },
    ipcMain: {
      handle(channel, fn) { ipcHandlers.set(channel, fn); },
      on(channel, fn) { ipcHandlers.set(channel, fn); },
    },
    Menu: { buildFromTemplate: (template) => { capturedMenu = template; return {}; }, setApplicationMenu() {} },
    shell: { openExternal: async (url) => { externalUrls.push(url); } },
    clipboard: { writeText: (text) => { clipboardWrites.push(text); } },
  };

  const resolutions = opts.resolutions ?? [
    { ok: true, client: 'claude', path: String.raw`D:\claude.exe`, source: 'shim' },
    { ok: true, client: 'codex', path: String.raw`D:\codex.exe`, source: 'shim' },
    { ok: true, client: 'git', path: String.raw`D:\git.exe`, source: 'path' },
    { ok: false, client: 'gh', reason: 'not-found', tried: [] },
  ];
  const bridge = {
    startEngine(args) {
      startArgs.push(args);
      exitListener = args.onExit;
      // `readyPending` holds readiness until the test calls `resolveReady()`, which is how a
      // start is made to sit mid-flight.
      let settleReady = () => {};
      const readyPromise = opts.readyError
        ? Promise.reject(opts.readyError)
        : new Promise((resolve) => { settleReady = resolve; if (opts.readyPending !== true) resolve(ready); });
      const handle = {
        ready: readyPromise,
        shutdown: async () => { shutdowns.push(handle); if (opts.stopDelay) await opts.stopDelay(); },
        mintPairing: async () => { const code = mintCode(); mints.push(code); return code; },
        dependencies: async () => { if (opts.dependenciesError) throw opts.dependenciesError; return resolutions; },
        isRunning: () => true,
        port: () => PORT,
        kill: () => { handle.killed = true; },
        resolveReady: () => settleReady(ready),
      };
      pendingReady.push(() => settleReady(ready));
      bridge.last = handle;
      return handle;
    },
  };

  const defaultText = JSON.stringify({ status: 'ok', pid: PID, runningAttempts });
  const defaultFetch = async (url, init) => {
    const href = String(url);
    if (href.endsWith('/healthz')) {
      const count = typeof runningAttempts === 'function' ? await runningAttempts() : runningAttempts;
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'ok', pid: PID, runningAttempts: count }) };
    }
    if (href.includes('/api/team-control/owner-session/exchange')) {
      exchangeRequests.push({ url: href, init });
      return {
        ok: true, status: 200,
        headers: { get: (name) => String(name).toLowerCase() === 'set-cookie'
          ? 'multi_agent_owner=COOKIE_' + 'X'.repeat(36) + '; HttpOnly; SameSite=Strict; Path=/api; Max-Age=43200' : null },
        json: async () => ({ antiForgeryToken: 'C'.repeat(43) }),
      };
    }
    return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
  };

  const globals = {
    __dirname: SRC,
    process: { env: { HOME: 'D:\\Users\\fixture', USERPROFILE: 'D:\\Users\\fixture', CODEX_HOME: 'D:\\Users\\fixture\\.codex', CLAUDE_CONFIG_DIR: 'D:\\Users\\fixture\\.claude' } },
    fetch: opts.fetch || defaultFetch,
  };
  const externals = {
    './engine-paths.js': enginePaths,
    './origin.js': originRules,
    './dependencies.js': { dependencyRows },
    './engine-bridge.js': bridge,
    'node:child_process': () => { throw new Error('No process in these tests'); },
    'node:fs': { existsSync: () => opts.engineEntryExists !== false, mkdirSync() {}, writeFileSync() {}, readFileSync: fs.readFileSync },
    'node:url': require('node:url'),
  };

  const { context, load } = desktopContext({ electron, externals, globals });
  // Load the real modules once, then hand `main.js` a wrapper that records what it built, so a
  // test can read the live lifecycle and window without either module exporting a test seam.
  const realLifecycle = load('lifecycle.js');
  const lifecycleInstances = [];
  externals['./lifecycle.js'] = {
    ...realLifecycle,
    createLifecycleModule: (config) => {
      const instance = realLifecycle.createLifecycleModule(
        opts.countRunningAttempts ? { ...config, countRunningAttempts: opts.countRunningAttempts } : config,
      );
      lifecycleInstances.push(instance);
      return instance;
    },
  };
  const realWindow = load('window.js');
  const windowInstances = [];
  externals['./window.js'] = {
    ...realWindow,
    createWindowModule: (config) => {
      const instance = realWindow.createWindowModule(config);
      windowInstances.push(instance);
      activeWindow = () => instance.getWindow();
      return instance;
    },
  };
  load('main.js');

  return {
    ready: settle(),
    context, electron, bridge, loaded, messageBoxes, lifecycle: event => (lifecycleHandlers.get(event) || [])[0], contentsHandlers, windowHandlers,
    ipcHandlers, contents, mainFrame, cookies, clipboardWrites, externalUrls, mints, exchangeRequests, shutdowns, startArgs,
    options: () => windowOptions,
    started: () => startArgs.length,
    lastStartEnv: () => (startArgs.at(-1) ? startArgs.at(-1).env : null),
    engineHandle: () => bridge.last,
    window: () => windowInstances[0].getWindow(),
    /** How many windows the app has open; a closed window is destroyed and cleared. */
    windowCount: () => (windowInstances[0] && windowInstances[0].getWindow() ? 1 : 0),
    menuItem: label => (capturedMenu || []).flatMap(item => item.submenu || []).find(item => item.label === label),
    click: async label => { await (capturedMenu || []).flatMap(item => item.submenu || []).find(item => item.label === label).click(); },
    exit: () => exitListener,
    close: () => (windowHandlers.get('close') || [])[0],
    /** Every status the window was sent, in order. */
    published: () => published,
    phases: () => published.map(status => status.phase),
    /** The state the window would render right now. */
    state: () => ipcHandlers.get('desktop:get-state')(),
    /** The live engine lifecycle. */
    lifecycleModule: () => lifecycleInstances[0],
    /** The current engine lifecycle phase. */
    phase: () => lifecycleInstances[0].phase(),
    /** The origin the window may show, or null. */
    origin: () => lifecycleInstances[0].getOrigin(),
    /** Resolve the most recent start's readiness. */
    resolveReady: () => pendingReady.at(-1)(),
  };
}

module.exports = { desktopApp, settle, ORIGIN, PORT, PID };