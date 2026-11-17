'use strict';
/**
 * The desktop window's own boundary: window options, the native folder dialog, the origin rules,
 * the preload surface, and source scans that prove the retired WSL path is gone.
 *
 * These drive the real `src/main.js` module graph in a `vm` context with a mocked Electron, so
 * they run under `node --test` without an Electron binary and without starting anything.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const originRules = require('../src/origin.js');
const { dependencyRows } = require('../src/dependencies.js');
const { desktopContext } = require('./fixtures/desktop-context.js');

const ORIGIN = 'http://127.0.0.1:58123';
const SRC = path.resolve(__dirname, '../src');

const flush = async () => { for (let i = 0; i < 4; i += 1) await new Promise(resolve => setImmediate(resolve)); };

/**
 * Build a `main.js` fixture.
 *
 * @param {object} [options]
 * @param {object} [options.selected] – the folder dialog's answer
 */
async function desktop(options = {}) {
  const selected = options.selected ?? { canceled: false, filePaths: [String.raw`D:\Client Work\fixture`] };
  const dialogs = [];
  const loaded = [];
  const ipcHandlers = new Map();
  let windowOptions;
  const contents = {
    mainFrame: { url: `${ORIGIN}/team` },
    on() {}, send() {}, setWindowOpenHandler() {}, reload() {},
    getURL() { return contents.mainFrame.url; },
  };
  class Window {
    constructor(value) { windowOptions = value; this.webContents = contents; this.destroyed = false; }
    once() {}
    on() {}
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    focus() {}
    loadURL(url) { loaded.push(url); return Promise.resolve(); }
  }
  const electron = {
    app: {
      requestSingleInstanceLock: () => true, on() {}, whenReady: () => Promise.resolve(),
      getPath: name => name === 'appData' ? path.join('D:', 'ma', 'tmp', 'appData') : path.join('D:', 'ma', 'tmp', 'userData'),
    },
    BrowserWindow: Window,
    Menu: { buildFromTemplate: () => ({}), setApplicationMenu() {} },
    session: { defaultSession: { cookies: { set: async () => {} }, setPermissionRequestHandler() {} } },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 940 } }) },
    dialog: {
      showOpenDialog: async (parent, settings) => { dialogs.push({ parent, settings }); return selected; },
      showMessageBox: async () => ({ response: 1 }),
    },
    ipcMain: { handle(channel, fn) { ipcHandlers.set(channel, fn); }, on(channel, fn) { ipcHandlers.set(channel, fn); } },
    shell: { openExternal: async () => {} },
    clipboard: { writeText: () => {} },
  };
  const globals = {
    __dirname: SRC,
    process: { env: {} },
    fetch: async () => ({ ok: false, status: 404, text: async () => '' }),
  };
  const externals = {
    './engine-bridge.js': { startEngine() { throw new Error('these tests do not start the engine'); } },
    './dependencies.js': { dependencyRows },
    './origin.js': originRules,
    'node:child_process': () => { throw new Error('Folder selection must not spawn a process'); },
    'node:worker_threads': () => { throw new Error('Folder selection must not use worker threads'); },
  };
  const { load } = desktopContext({ electron, externals, globals });
  // These tests never start an engine, so the IPC module is given the origin a running engine
  // would publish; every other wiring stays the app's own.
  const realIpc = load('ipc.js');
  externals['./ipc.js'] = {
    createIpcModule: (config) => realIpc.createIpcModule({ ...config, getOrigin: () => ORIGIN }),
  };
  load('main.js');
  // app readiness creates the window and registers the IPC handlers.
  await flush();
  const event = { sender: contents, senderFrame: contents.mainFrame };
  return {
    contents, event, dialogs, loaded, windowOptions: () => windowOptions,
    pick: (sender = event) => ipcHandlers.get('desktop:pick-folder')(sender),
  };
}

function preload(pick = async () => String.raw`D:\Client Work\fixture`) {
  const listeners = new Map(), domListeners = new Map(), storage = new Map(), events = [], writes = [];
  let bridge;
  const status = { phase: 'ready', connected: true, dependencies: [] };
  const document = {
    readyState: 'loading', documentElement: { dataset: {} },
    body: { appendChild: element => writes.push(element) }, head: { appendChild: element => writes.push(element) },
    getElementById: () => null, createElement: () => ({}),
    addEventListener: (name, callback) => domListeners.set(name, callback), dispatchEvent: event => events.push(event),
  };
  const context = vm.createContext({
    document, window: { sessionStorage: { setItem: (key, value) => storage.set(key, value) } },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    require: name => {
      assert.equal(name, 'electron'); return {
        contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, 'multiAgentDesktop'); bridge = value; } },
        ipcRenderer: {
          sendSync: channel => { assert.equal(channel, 'desktop:csrf-token'); return 'fixture-session-handoff'; },
          invoke: channel => channel === 'desktop:pick-folder' ? pick() : Promise.resolve(status),
          on: (channel, listener) => { const list = listeners.get(channel) ?? []; list.push(listener); listeners.set(channel, list); },
          removeListener: (channel, listener) => listeners.set(channel, listeners.get(channel).filter(item => item !== listener)),
        },
      };
    },
  });
  vm.runInContext(fs.readFileSync(path.join(SRC, 'preload.js'), 'utf8'), context);
  return { bridge, status, document, storage, events, writes,
    loaded: () => { document.readyState = 'complete'; domListeners.get('DOMContentLoaded')?.(); },
    publish: next => { for (const listener of listeners.get('desktop:state') ?? []) listener({}, next); },
  };
}

test('keeps the native caption overlay aligned with the shared 52px strip and the window sandboxed', async () => {
  const options = (await desktop()).windowOptions();
  assert.equal(options.titleBarStyle, 'hidden');
  assert.equal(options.titleBarOverlay.height, 52);
  assert.equal(options.titleBarOverlay.color, '#faf8f5');
  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.equal(options.webPreferences.sandbox, true);
  assert.equal(options.webPreferences.webSecurity, true);
});

test('the window first shows the first-run page as a file URL', async () => {
  const fixture = await desktop();
  assert.equal(fixture.loaded.length, 1);
  const url = new URL(fixture.loaded[0]);
  assert.equal(url.protocol, 'file:');
  assert.match(url.href, /first-run\.html$/);
});

test('the first-run page URL survives a checkout path with a fragment and a percent sign', () => {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'client #1 100% done-'));
  fs.copyFileSync(path.join(SRC, 'window.js'), path.join(checkout, 'window.js'));
  const { load } = desktopContext({ electron: {}, externals: { './origin.js': originRules } });
  const parsed = new URL(load(path.join(checkout, 'window.js')).FIRST_RUN_URL);
  fs.rmSync(checkout, { recursive: true, force: true });
  assert.equal(parsed.protocol, 'file:');
  assert.equal(parsed.hash, '', 'a folder name with # must not become a fragment');
  assert.match(decodeURIComponent(parsed.pathname), /client #1 100% done-[^/]+\/first-run\.html$/);
});

test('the native folder dialog hands the Windows path to the UI unchanged', async () => {
  const fixture = await desktop();
  const page = preload(() => fixture.pick());
  assert.equal(await page.bridge.pickFolder(), String.raw`D:\Client Work\fixture`);
  assert.equal(fixture.dialogs.length, 1);
  assert.equal(fixture.dialogs[0].parent.webContents, fixture.contents);
  assert.deepEqual(Array.from(fixture.dialogs[0].settings.properties), ['openDirectory', 'createDirectory']);
});

test('a UNC folder comes back unchanged and cancelling returns null', async () => {
  assert.equal(await (await desktop({ selected: { canceled: false, filePaths: [String.raw`\\server\share\app`] } })).pick(), String.raw`\\server\share\app`);
  assert.equal(await (await desktop({ selected: { canceled: true, filePaths: [] } })).pick(), null);
});

test('the picker refuses a different window, a subframe, or another origin before opening', async () => {
  const fixture = await desktop();
  await assert.rejects(fixture.pick({ ...fixture.event, sender: {} }));
  await assert.rejects(fixture.pick({ ...fixture.event, senderFrame: { url: `${ORIGIN}/team` } }));
  fixture.contents.mainFrame.url = 'https://example.com/';
  await assert.rejects(fixture.pick());
  fixture.contents.mainFrame.url = 'http://127.0.0.1:7433/team';
  await assert.rejects(fixture.pick());
  assert.equal(fixture.dialogs.length, 0);
});

test('the window may navigate only to the current dynamic origin', () => {
  const allowed = originRules;
  assert.equal(allowed.isAllowedNavigation(`${ORIGIN}/team`, ORIGIN), true);
  assert.equal(allowed.isAllowedNavigation(`${ORIGIN}/team/tasks`, ORIGIN), true);
  assert.equal(allowed.isAllowedNavigation('http://127.0.0.1:7433/team', ORIGIN), false);
  assert.equal(allowed.isAllowedNavigation('http://127.0.0.1:9999/team', ORIGIN), false);
  assert.equal(allowed.isAllowedNavigation('http://localhost:58123/team', ORIGIN), false);
  assert.equal(allowed.isAllowedNavigation('https://example.com/', ORIGIN), false);
  assert.equal(allowed.isAllowedNavigation('file:///C:/Windows/System32/calc.exe', ORIGIN), false);
  assert.equal(allowed.isAllowedNavigation('javascript:alert(1)', ORIGIN), false);
  // Before the engine reports an origin there is nothing the window may show.
  assert.equal(allowed.isAllowedNavigation(`${ORIGIN}/team`, null), false);
  assert.equal(allowed.isAllowedNavigation('', ORIGIN), false);
});

test('only the engine this app forked is trusted, not any 200', () => {
  const body = JSON.stringify({
    status: 'ok', pid: 42, eventLoop: { healthy: true }, routeTimings: {}, slowOperations: { healthy: true },
    bind: { mode: 'explicit', hosts: ['127.0.0.1'], tailscaleDetected: false },
  });
  assert.equal(originRules.isDaemonHealth(body, 42), true);
  assert.equal(originRules.isDaemonHealth(body, 43), false, 'another daemon on the port is refused');
  assert.equal(originRules.isDaemonHealth(body), false, 'no reported pid means nothing to match');
  assert.equal(originRules.isDaemonHealth('{"status":"ok"}', 42), false);
  assert.equal(originRules.isDaemonHealth('{"status":"starting","pid":42}', 42), false);
  assert.equal(originRules.isDaemonHealth('<html>hello</html>', 42), false);
  assert.equal(originRules.isDaemonHealth('', 42), false);
});

test('dependency rows carry the resolved Windows path or one install line', () => {
  const rows = dependencyRows([
    { ok: true, client: 'claude', path: String.raw`D:\dev\npm-global\node_modules\@anthropic-ai\claude-code\bin\claude.exe`, source: 'shim' },
    { ok: true, client: 'codex', path: String.raw`D:\dev\codex.exe`, source: 'shim' },
    { ok: true, client: 'git', path: String.raw`D:\git\Git\cmd\git.exe`, source: 'path' },
    { ok: false, client: 'gh', reason: 'not-found', tried: [] },
  ]);
  assert.deepEqual(rows.map(row => row.client), ['git', 'gh', 'claude', 'codex']);
  assert.deepEqual(rows.find(row => row.client === 'git'), { client: 'git', label: 'Git', ok: true, path: String.raw`D:\git\Git\cmd\git.exe` });
  assert.equal(rows.find(row => row.client === 'claude').path, String.raw`D:\dev\npm-global\node_modules\@anthropic-ai\claude-code\bin\claude.exe`);
  const missing = rows.find(row => row.client === 'gh');
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'not-found');
  assert.match(missing.hint, /gh\.exe|cli\.github\.com/);
  assert.equal(missing.path, undefined);
});

test('a client the resolver never reported reads as missing', () => {
  const rows = dependencyRows([]);
  assert.equal(rows.length, 4);
  for (const row of rows) assert.equal(row.ok, false);
});

test('preload hands over the anti-forgery token and adds no title bar, footer or padding', async () => {
  const page = preload();
  assert.equal(page.storage.get('multi-agent.desktop.csrf'), 'fixture-session-handoff');
  assert.equal(await page.bridge.status(), page.status);
  page.loaded();
  assert.equal(page.document.documentElement.dataset.desktop, 'true');
  const received = [];
  const unsubscribe = page.bridge.onStatus(value => received.push(value));
  page.publish(page.status);
  unsubscribe();
  page.publish({ ...page.status, connected: false });
  assert.equal(received.length, 1);
  assert.equal(page.events[0].type, 'desktop-status');
  assert.equal(page.writes.length, 0);
});

test('preload exposes only the native reconnect action, never the cookie', async () => {
  const page = preload();
  assert.equal(typeof page.bridge.reconnect, 'function');
  assert.equal(typeof page.bridge.reconnectEngine, 'function');
  assert.equal(await page.bridge.reconnect(), page.status);
  assert.equal(page.bridge.cookie, undefined);
  assert.equal(page.bridge.run, undefined, 'no generic channel builder is exposed');
});

test('the engine host adds no listener on the daemon port, so its own answers reach the parent', () => {
  const text = fs.readFileSync(path.join(SRC, 'engine-host.js'), 'utf8');
  assert.equal(/parentPort\.on\(/.test(text), false, 'engine-host.js must not listen on the daemon port');
  assert.match(text, /mod\.startServer\(0\)/, 'the daemon still binds an OS-assigned port');
});

test('the desktop source carries no WSL path and no fixed daemon port', () => {
  for (const file of fs.readdirSync(SRC)) {
    const text = fs.readFileSync(path.join(SRC, file), 'utf8');
    assert.equal(/wsl/i.test(text), false, `${file} must not mention WSL`);
    assert.equal(/\b7433\b/.test(text), false, `${file} must not carry a fixed daemon port`);
  }
  assert.equal(fs.existsSync(path.join(SRC, 'wsl.js')), false, 'wsl.js is deleted');
});

test('the desktop never starts a process by name, so no wsl.exe can be spawned', () => {
  for (const file of fs.readdirSync(SRC)) {
    const text = fs.readFileSync(path.join(SRC, file), 'utf8');
    assert.equal(/node:child_process/.test(text), false, `${file} must not spawn a child process directly`);
    assert.equal(/spawn\s*\(/.test(text), false, `${file} must not spawn a child process directly`);
  }
});