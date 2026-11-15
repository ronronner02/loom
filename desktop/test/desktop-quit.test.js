'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture({ count = 1, response = 1, stop, health } = {}) {
  const calls = { stopped: 0, exited: 0, dialogs: 0 };
  const app = new EventEmitter();
  Object.assign(app, {
    requestSingleInstanceLock: () => true,
    whenReady: () => ({ then() {} }),
    getPath: () => path.join(require('node:os').tmpdir(), 'desktop-test'),
    quit() {
      const event = closeEvent();
      app.emit('before-quit', event);
      if (!event.defaultPrevented) calls.exited++;
      return event;
    },
  });
  let window;
  class Window extends EventEmitter {
    constructor() {
      super(); window = this; this.destroyed = false;
      this.webContents = { on() {}, send() {}, setWindowOpenHandler() {} };
    }
    isDestroyed() { return this.destroyed; }
    loadURL() { return Promise.resolve(); }
    close() {
      if (this.destroyed) return;
      const event = closeEvent();
      this.emit('close', event);
      if (!event.defaultPrevented) { this.destroyed = true; this.emit('closed'); }
      return event;
    }
  }
  const electron = { app, BrowserWindow: Window, screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 940 } }) },
    dialog: { showMessageBox: async () => { calls.dialogs++; return { response }; } },
    Menu: {}, ipcMain: {}, session: {}, shell: {}, clipboard: {} };
  const context = vm.createContext({ URL, console, __dirname: path.resolve(__dirname, '../src'),
    fetch: async () => ({ ok: true, text: async () => JSON.stringify(health) }),
    AbortSignal: { timeout: () => undefined },
    process: { env: {} }, fixture: { count: typeof count === 'function' ? count : async () => count,
      stop: async () => { calls.stopped++; await stop?.(); } },
    require(name) {
      if (name === 'electron') return electron;
      if (name === './engine-bridge.js') return {};
      if (name === './engine-paths.js') return { daemonEntry: () => 'unused-test-entry' };
      if (name === './dependencies.js') return { dependencyRows: () => [] };
      if (name === './origin.js') return { isAllowedNavigation: () => false, isDaemonHealth: () => false };
      return require(name);
    },
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../src/main.js'), 'utf8'), context);
  vm.runInContext('createWindow(); engine = { shutdown: fixture.stop }; allowedOrigin = "http://127.0.0.1:58123";', context);
  if (health === undefined) vm.runInContext('pollRunningAttempts = fixture.count;', context);
  return { window, app, calls };
}

function closeEvent() {
  return { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('vetoes window close synchronously before an asynchronous activity check', async () => {
  let finish;
  const f = fixture({ count: () => new Promise(resolve => { finish = resolve; }) });
  const event = f.window.close();
  try {
    assert.equal(event.defaultPrevented, true);
    assert.equal(f.window.destroyed, false);
    assert.equal(f.calls.dialogs, 0);
  } finally { finish(1); await flush(); }
  assert.deepEqual(f.calls, { stopped: 0, exited: 0, dialogs: 1 });
});

test('menu quit obeys Keep running without shutting down the engine', async () => {
  const f = fixture();
  assert.equal(f.app.quit().defaultPrevented, true);
  await flush();
  assert.deepEqual(f.calls, { stopped: 0, exited: 0, dialogs: 1 });
});

test('window close and menu quit share one pending confirmation', async () => {
  let finish;
  const f = fixture({ count: () => new Promise(resolve => { finish = resolve; }), response: 0 });
  assert.equal(f.window.close().defaultPrevented, true);
  assert.equal(f.app.quit().defaultPrevented, true);
  finish(1);
  await flush();
  assert.deepEqual(f.calls, { stopped: 1, exited: 1, dialogs: 1 });
});

test('an idle engine shuts down and quits without a confirmation', async () => {
  const f = fixture({ count: 0 });
  f.window.close();
  await flush();
  assert.deepEqual(f.calls, { stopped: 1, exited: 1, dialogs: 0 });
});

test('unknown activity asks before stopping rather than treating failure as idle', async () => {
  const g = fixture({ count: async () => undefined });
  g.app.quit();
  await flush();
  assert.deepEqual(g.calls, { stopped: 0, exited: 0, dialogs: 1 });
});

test('Keep running resets the pending decision so a later close asks again', async () => {
  const f = fixture();
  f.window.close(); await flush();
  f.window.close(); await flush();
  assert.deepEqual(f.calls, { stopped: 0, exited: 0, dialogs: 2 });
});


test('repeated quit waits for the already-confirmed engine shutdown to complete', async () => {
  let finish;
  const f = fixture({ count: 0, stop: () => new Promise(resolve => { finish = resolve; }) });
  f.app.quit();
  await flush();
  assert.equal(f.calls.stopped, 1);
  const repeated = f.app.quit();
  try {
    assert.equal(repeated.defaultPrevented, true);
    assert.equal(f.calls.exited, 0);
  } finally { finish(); await flush(); }
  assert.deepEqual(f.calls, { stopped: 1, exited: 1, dialogs: 0 });
});

for (const health of [{}, { runningAttempts: -1 }, { runningAttempts: 1.5 }, { runningAttempts: '1' }]) {
  test(`malformed health count asks before stopping: ${JSON.stringify(health)}`, async () => {
    const f = fixture({ health });
    assert.equal(f.app.quit().defaultPrevented, true);
    await flush();
    assert.deepEqual(f.calls, { stopped: 0, exited: 0, dialogs: 1 });
  });
}
