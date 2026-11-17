'use strict';
/**
 * Tests for the engine bridge: fork, ready IPC, port capture, crash, shutdown, and the pairing
 * and dependency requests over the private parent channel.
 *
 * These tests mock Electron's `utilityProcess.fork` and follow the same `vm.runInContext` pattern
 * as `desktop.test.js`. Each fork produces a fresh fake child, so a test can prove that a late
 * exit from a replaced child leaves the current one alone.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ---------------------------------------------------------------------------
// Test context factory
// ---------------------------------------------------------------------------

function bridgeContext() {
  let forkEntry = null;
  let forkArgs = null;
  let forkOpts = null;
  const children = [];

  class Child {
    constructor() {
      this.listeners = new Map();
      this.posted = [];
      this.destroyed = false;
    }
    on(event, fn) {
      const list = this.listeners.get(event) || [];
      list.push(fn);
      this.listeners.set(event, list);
    }
    once(event, fn) {
      const wrapper = (...args) => {
        fn(...args);
        this.listeners.set(event, (this.listeners.get(event) || []).filter(item => item !== wrapper));
      };
      this.on(event, wrapper);
    }
    emit(event, ...args) {
      for (const fn of [...(this.listeners.get(event) || [])]) fn(...args);
    }
    postMessage(msg) {
      this.posted.push(msg);
      // The fake daemon answers a request on the next tick, the way the real child does.
      if (!this.handler) setImmediate(() => this.emit('message', msg));
    }
    /** Answer subsequent requests with `handler(msg, reply)` instead of echoing them. */
    answer(handler) {
      this.handler = handler;
      this.postMessage = (msg) => { this.posted.push(msg); handler(msg, message => this.emit('message', message)); };
    }
    kill() {
      this.destroyed = true;
      this.emit('exit', 0);
    }
  }

  const bridgeExports = {};
  const ctx = vm.createContext({
    __dirname: path.resolve(__dirname, '../src'),
    console,
    URL,
    path,
    Buffer,
    setImmediate,
    clearTimeout,
    setTimeout,
    Promise,
    Error,
    Object,
    Array,
    String,
    Number,
    Boolean,
    JSON,
    Math,
    Date,
    RegExp,
    Map,
    Set,
    Symbol,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    module: { exports: bridgeExports },
    exports: bridgeExports,
    require: (name) => {
      if (name === 'electron') {
        return {
          app: { getPath: () => path.join('C:', 'ma', 'data') },
          utilityProcess: {
            fork(entry, args, opts) {
              forkEntry = entry;
              forkArgs = args;
              forkOpts = opts;
              const child = new Child();
              children.push(child);
              return child;
            },
          },
        };
      }
      if (name === 'node:path') return path;
      return require(name);
    },
  });

  vm.runInContext(
    fs.readFileSync(path.resolve(__dirname, '../src/engine-bridge.js'), 'utf8'),
    ctx,
  );

  return {
    ctx,
    bridgeExports,
    forkEntry: () => forkEntry,
    forkArgs: () => forkArgs,
    forkOpts: () => forkOpts,
    /** The most recently forked child. */
    child: () => children.at(-1),
    children,
    startEngine: (...args) => vm.runInContext('startEngine', ctx)(...args),
  };
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const ENV = { MULTI_AGENT_HOME: path.join('C:', 'tmp', 'rig-home') };
const OPTS = { dataDir: path.join('C:', 'tmp', 'engine-data'), env: ENV };

/** A started bridge whose child has reported ready. */
async function started(overrides = {}) {
  const bridge = bridgeContext();
  const engine = bridge.startEngine({ ...OPTS, ...overrides });
  bridge.child().postMessage({ type: 'ready', port: 54321, pid: 12345 });
  await tick();
  return { bridge, engine };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('startEngine forks utility process with correct entry and env', async () => {
  const bridge = bridgeContext();
  const engine = bridge.startEngine(OPTS);

  assert.ok(bridge.forkEntry(), 'utilityProcess.fork must be called');
  assert.ok(bridge.forkEntry().endsWith('engine-host.js'),
    `entry must end with engine-host.js, got ${bridge.forkEntry()}`);
  assert.equal(bridge.forkOpts().env.MULTI_AGENT_HOME, ENV.MULTI_AGENT_HOME);
  assert.equal(bridge.forkOpts().serviceName, 'multi-agent-daemon');

  bridge.child().postMessage({ type: 'ready', port: 54321, pid: 12345 });

  assert.deepEqual({ ...await engine.ready }, { port: 54321, pid: 12345 });
  assert.ok(engine.isRunning());
  assert.equal(engine.port(), 54321);
});

test('startEngine reports a daemon crash before ready', async () => {
  const bridge = bridgeContext();
  const engine = bridge.startEngine(OPTS);

  bridge.child().postMessage({ type: 'crash', error: 'ENOENT: module not found' });

  await assert.rejects(engine.ready, /Daemon crash/);
});

test('startEngine rejects when the child exits before ready', async () => {
  const { engine } = await started();
  const bridge = bridgeContext();
  const fresh = bridge.startEngine(OPTS);
  bridge.child().emit('exit', 1);
  await assert.rejects(fresh.ready, /Daemon exited with code 1 before ready/);
  assert.equal(fresh.isRunning(), false);
  assert.ok(engine.isRunning(), 'an unrelated handle is untouched');
});

test('shutdown sends the shutdown message and waits for exit', async () => {
  const { bridge, engine } = await started();
  const child = bridge.child();
  child.answer(msg => { if (msg.type === 'shutdown') setImmediate(() => child.emit('exit', 0)); });

  await engine.shutdown();

  assert.ok(child.posted.some(msg => msg.type === 'shutdown'), 'the shutdown message is sent');
  assert.equal(engine.isRunning(), false);
  assert.equal(engine.port(), null);
});

test('shutdown is idempotent', async () => {
  const { bridge, engine } = await started();
  const child = bridge.child();
  child.answer(msg => { if (msg.type === 'shutdown') setImmediate(() => child.emit('exit', 0)); });

  await engine.shutdown();
  assert.equal(engine.isRunning(), false);
  await engine.shutdown();
  await engine.shutdown();
  assert.equal(engine.isRunning(), false);
});

test('kill ends the child immediately', async () => {
  const { engine } = await started();
  engine.kill();
  assert.equal(engine.isRunning(), false);
});

test('the bridge has no module-level process state left behind', async () => {
  const before = await started();
  const after = await started();
  // Two live handles from the same module: neither sees the other's child.
  assert.equal(before.engine.isRunning(), true);
  assert.equal(after.engine.isRunning(), true);
  assert.notEqual(before.bridge.child(), after.bridge.child());
  before.engine.kill();
  assert.equal(before.engine.isRunning(), false);
  assert.equal(after.engine.isRunning(), true, "one handle's kill does not touch the other child");
  assert.equal(after.engine.port(), 54321);
});

test('no LAN bind: the bridge passes the daemon its own env and reads back its port', () => {
  const bridge = bridgeContext();
  assert.ok(bridge, 'engine bridge loads without error');
  assert.ok(!('MULTI_AGENT_BIND_HOST' in ENV), 'the bridge adds no bind override; the daemon binds loopback');
});

test('an unexpected exit reaches onExit and an expected one does not', async () => {
  const bridge = bridgeContext();
  const exits = [];
  const engine = bridge.startEngine({ ...OPTS, onExit: exit => exits.push(exit) });
  bridge.child().postMessage({ type: 'ready', port: 54321, pid: 12345 });
  await tick();
  bridge.child().emit('exit', 0);
  assert.equal(exits.length, 1, 'a daemon exit nobody asked for is reported');
  assert.equal(exits[0].code, 0);
  assert.match(exits[0].reason, /exit code 0/);
  assert.equal(engine.isRunning(), false);
});

test('an exit after shutdown is not reported as unexpected', async () => {
  const { bridge, engine } = await started({ onExit: () => { throw new Error('unexpected exit reported'); } });
  const child = bridge.child();
  child.answer(msg => { if (msg.type === 'shutdown') setImmediate(() => child.emit('exit', 0)); });
  await engine.shutdown();
});

test('a late exit from a replaced child does not settle the new child', async () => {
  const bridge = bridgeContext();
  const exits = [];
  const first = bridge.startEngine({ ...OPTS, onExit: exit => exits.push(exit) });
  const firstChild = bridge.child();
  first.ready.catch(() => {}); // the first start never reached ready; that is not the subject here
  firstChild.emit('exit', 0);
  await tick();

  const second = bridge.startEngine({ ...OPTS, onExit: exit => exits.push(exit) });
  const secondChild = bridge.child();
  secondChild.postMessage({ type: 'ready', port: 54322, pid: 999 });
  await tick();
  assert.equal(second.port(), 54322);
  assert.equal(exits.length, 1, 'the first child exit, nobody asked for it, was reported');

  // The previous child emits one more exit, late, after its replacement is live.
  firstChild.emit('exit', 3);

  assert.equal(second.port(), 54322, "the replacement's port survives a stale exit");
  assert.equal(second.isRunning(), true, 'the replacement is still the running child');
  assert.equal(exits.length, 1, 'a stale exit is not reported as the current engine going away');
  assert.deepEqual({ ...await second.ready }, { port: 54322, pid: 999 });
});

// ---------------------------------------------------------------------------
// The first-run dependency probe over the private parent channel
// ---------------------------------------------------------------------------

test('dependencies posts the probe and resolves the daemon resolver output', async () => {
  const { bridge, engine } = await started();
  const child = bridge.child();
  const resolutions = [{ ok: true, client: 'git', path: 'D:\\git.exe', source: 'path' }];
  child.answer((msg, reply) => { if (msg.type === 'dependencies') setImmediate(() => reply({ type: 'dependencies', resolutions })); });

  assert.deepEqual(await engine.dependencies(), resolutions);
  assert.ok(child.posted.some(msg => msg.type === 'dependencies'), 'the probe goes over the port');
});

test('dependencies rejects with the daemon answer and when no daemon is running', async () => {
  const { bridge, engine } = await started();
  const child = bridge.child();
  child.answer((msg, reply) => { if (msg.type === 'dependencies') setImmediate(() => reply({ type: 'dependencies-error', error: 'probe_failed' })); });
  await assert.rejects(engine.dependencies(), /probe_failed/);

  engine.kill();
  await assert.rejects(engine.dependencies(), /not running/);
});

// ---------------------------------------------------------------------------
// Minting a one-time pairing code over the private parent channel
// ---------------------------------------------------------------------------

test('mintPairing posts mint-pairing and resolves the daemon code', async () => {
  const { bridge, engine } = await started();
  const child = bridge.child();
  child.answer((msg, reply) => { if (msg.type === 'mint-pairing') setImmediate(() => reply({ type: 'pairing-code', code: 'one-time-code' })); });

  assert.equal(await engine.mintPairing(), 'one-time-code');
  assert.ok(child.posted.some(msg => msg.type === 'mint-pairing'), 'the mint request goes over the port');
});

test('mintPairing rejects when the daemon reports a mint error', async () => {
  const { bridge, engine } = await started();
  const child = bridge.child();
  child.answer((msg, reply) => { if (msg.type === 'mint-pairing') setImmediate(() => reply({ type: 'pairing-error', error: 'owner_session_unavailable' })); });

  await assert.rejects(engine.mintPairing(), /owner_session_unavailable/);
});

test('mintPairing rejects when the daemon is not running', async () => {
  const { engine } = await started();
  engine.kill();
  await assert.rejects(engine.mintPairing(), /not running/);
});