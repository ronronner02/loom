'use strict';
/**
 * The engine lifecycle: the startup path, the races between owner actions and a start in
 * flight, and the close confirmation.
 *
 * These drive `src/main.js` against a mocked Electron, a fake engine bridge and a fake daemon on
 * the other end of `fetch`, so they prove the wiring the app ships.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { desktopApp, settle, ORIGIN } = require('./fixtures/desktop-app.js');

test('the engine starts after app readiness and the window loads the dynamic origin', async () => {
  const app = desktopApp();
  await app.ready;
  await settle();
  assert.equal(app.started(), 1, 'the bridge must fork exactly one daemon');
  assert.ok(app.loaded.some(url => url === `${ORIGIN}/team`),
    `the window must load the dynamic origin, got ${JSON.stringify(app.loaded)}`);
  assert.equal(app.origin(), ORIGIN);
  assert.equal(app.phase(), 'running');
  assert.equal(app.state().phase, 'ready');
});

test('the window pairs over the private parent channel and only the anti-forgery token reaches it', async () => {
  const app = desktopApp();
  await app.ready;
  await settle();
  const [code] = app.mints;
  assert.equal(app.mints.length, 1, 'the desktop mints exactly one code for the window');
  assert.ok(code, 'a one-time code was minted');

  const [exchange] = app.exchangeRequests;
  assert.ok(exchange, 'the code is exchanged over HTTP');
  assert.equal(exchange.url, `${ORIGIN}/api/team-control/owner-session/exchange`);
  assert.ok(!exchange.url.includes(code), 'the code never appears in the exchange URL');
  assert.equal(exchange.init.headers.Origin, ORIGIN);
  assert.equal(exchange.init.headers['Sec-Fetch-Site'], 'same-origin');
  assert.deepEqual(JSON.parse(exchange.init.body), { code });

  assert.equal(app.cookies.length, 1, 'the HttpOnly cookie goes into the window jar');
  const [cookie] = app.cookies;
  assert.equal(cookie.name, 'multi_agent_owner');
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, 'strict');
  assert.equal(cookie.path, '/api');
  assert.equal(cookie.url, ORIGIN);

  assert.ok(app.loaded.some(url => url === `${ORIGIN}/team`));
  assert.equal(app.state().phase, 'ready');
  assert.ok(!JSON.stringify(app.state()).includes(code), 'the code never reaches the renderer state');
});

test('the first-run page receives the dependency list with resolved paths and a missing hint', async () => {
  const app = desktopApp();
  await app.ready;
  await settle();
  const dependencies = app.state().dependencies;
  assert.ok(Array.isArray(dependencies) && dependencies.length === 4, `the page must receive the dependency list, got ${JSON.stringify(dependencies)}`);
  assert.deepEqual(dependencies.map(row => row.client), ['git', 'gh', 'claude', 'codex']);
  assert.equal(dependencies.find(row => row.client === 'claude').path, String.raw`D:\claude.exe`);
  assert.equal(dependencies.find(row => row.client === 'gh').ok, false);
  assert.match(dependencies.find(row => row.client === 'gh').hint, /gh\.exe|cli\.github\.com/);
});

test('a dependency probe failure still lets the window connect', async () => {
  const app = desktopApp({ dependenciesError: new Error('dependency probe failed') });
  await app.ready;
  await settle();
  assert.deepEqual(app.state().dependencies.map(row => row.ok), [false, false, false, false]);
  assert.equal(app.state().phase, 'ready');
});

test('the engine env keeps the parent HOME, USERPROFILE, CODEX_HOME and CLAUDE_CONFIG_DIR', async () => {
  const app = desktopApp();
  await app.ready;
  await settle();
  const env = app.lastStartEnv();
  assert.ok(env, 'startEngine must have been called');
  assert.equal(env.HOME, 'D:\\Users\\fixture', 'HOME must pass through from the parent');
  assert.equal(env.USERPROFILE, 'D:\\Users\\fixture', 'USERPROFILE must pass through from the parent');
  assert.equal(env.CODEX_HOME, 'D:\\Users\\fixture\\.codex', 'CODEX_HOME must pass through from the parent');
  assert.equal(env.CLAUDE_CONFIG_DIR, 'D:\\Users\\fixture\\.claude', 'CLAUDE_CONFIG_DIR must pass through from the parent');
  assert.equal(env.MULTI_AGENT_MODE, 'managed', 'MULTI_AGENT_MODE must be set');
  assert.equal(env.MULTI_AGENT_BIND_HOST, '127.0.0.1', 'MULTI_AGENT_BIND_HOST must be loopback');
  assert.equal(env.MULTI_AGENT_UI_ENABLED, 'true', 'MULTI_AGENT_UI_ENABLED must be set');
  assert.equal(env.MULTI_AGENT_OWNER_TOKEN, undefined, 'owner token must be cleared');
});

test('MULTI_AGENT_HOME is identical across two launches', async () => {
  const first = desktopApp();
  await first.ready;
  await settle();
  const home = first.lastStartEnv().MULTI_AGENT_HOME;
  const second = desktopApp();
  await second.ready;
  await settle();
  assert.ok(home && second.lastStartEnv().MULTI_AGENT_HOME, 'MULTI_AGENT_HOME must be set in both launches');
  assert.equal(home, second.lastStartEnv().MULTI_AGENT_HOME, 'MULTI_AGENT_HOME must be identical across launches');
});

test('a missing engine build says so instead of forking', async () => {
  const app = desktopApp({ engineEntryExists: false });
  await app.ready;
  await settle();
  assert.equal(app.started(), 0);
  assert.equal(app.state().phase, 'engine-missing');
});

test('an engine that fails before ready reports the failure and stays on the first-run page', async () => {
  const app = desktopApp({ readyError: new Error('Daemon crash: ENOENT') });
  await app.ready;
  await settle();
  assert.equal(app.state().phase, 'start-failed');
  assert.match(app.state().message, /Daemon crash/);
  assert.ok(!app.loaded.some(url => url.includes('/team')));
  assert.equal(app.phase(), 'stopped', 'a failed engine is not held as running');
  assert.ok(app.options(), 'the window still exists after a daemon crash');
});

test('an unexpected engine exit shows a reconnect action instead of a dead page', async () => {
  const app = desktopApp();
  await app.ready;
  await settle();
  assert.equal(app.state().phase, 'ready');
  app.exit()({ code: 1, reason: 'exit code 1' });
  assert.equal(app.state().phase, 'engine-exited');
  assert.match(app.state().message, /exit code 1/);
  assert.equal(app.origin(), null, 'a stopped engine has no origin to trust');
  assert.match(app.loaded.at(-1), /first-run\.html$/, 'the dead team page is replaced by the reconnect page');

  // Reconnect starts a fresh engine and connects the window again.
  const before = app.loaded.length;
  await app.ipcHandlers.get('desktop:reconnect-engine')();
  await settle();
  assert.equal(app.started(), 2, 'Reconnect forks the engine again');
  assert.ok(app.loaded.length > before, 'Reconnect loads the new origin');
  assert.equal(app.state().phase, 'ready');
});

test('Stop engine asks the bridge for the bounded shutdown and clears the origin', async () => {
  const app = desktopApp();
  await app.ready;
  await settle();
  await app.click('Stop engine');
  await settle();
  assert.equal(app.shutdowns.length, 1, 'the daemon shutdown runs exactly once');
  assert.equal(app.phase(), 'stopped', 'the engine handle is cleared so no child is left behind');
  assert.equal(app.origin(), null);
  assert.equal(app.state().phase, 'stopped');
});

test('an exit the app asked for is not reported as a crash', async () => {
  const app = desktopApp();
  await app.ready;
  await settle();
  await app.click('Stop engine');
  await settle();
  // The bridge suppresses the expected exit itself; a late report must not change the phase.
  app.exit()({ code: 0, reason: 'exit code 0' });
  assert.equal(app.state().phase, 'stopped', 'the stop the app asked for is not a crash');
});

test('no child is left when the shutdown runs before quit', async () => {
  const app = desktopApp();
  await app.ready;
  await settle();
  const beforeQuit = app.lifecycleModule().requestQuit;
  assert.equal(typeof beforeQuit, 'function');
  let prevented = false;
  beforeQuit({ preventDefault: () => { prevented = true; } });
  await settle();
  assert.equal(prevented, true, 'quit waits for the daemon shutdown');
  assert.equal(app.shutdowns.length, 1, 'the daemon shutdown runs exactly once');
  assert.equal(app.phase(), 'stopped');
});

test('quitting with no engine running does not prevent the quit', async () => {
  const app = desktopApp({ engineEntryExists: false });
  await app.ready;
  await settle();
  const beforeQuit = app.lifecycleModule().requestQuit;
  let prevented = false;
  beforeQuit({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(app.shutdowns.length, 0);
});

test('closing while attempts run asks for confirmation and cancel keeps the app open', async () => {
  const app = desktopApp({ closeResponse: 1, runningAttempts: 2 });
  await app.ready;
  await settle();
  const close = app.close();
  let prevented = false;
  close({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true, 'the close must be held synchronously for confirmation');
  await settle();
  assert.equal(app.messageBoxes.length, 1);
  assert.match(app.messageBoxes[0].message, /Resume continues/);
  assert.equal(app.window().destroyed, false, 'cancelling keeps the window open');
});

test('confirming the close stops the agents and proceeds', async () => {
  const app = desktopApp({ closeResponse: 0, runningAttempts: 1 });
  await app.ready;
  await settle();
  const close = app.close();
  close({ preventDefault: () => {} });
  await settle();
  assert.equal(app.shutdowns.length, 1, 'shutdown completes before the confirmed quit');
  assert.equal(app.messageBoxes.length, 1);
  assert.equal(app.windowCount(), 0, 'approving closes the window');
});

test('no close confirmation is shown when no attempt is running', async () => {
  const app = desktopApp({ closeResponse: 0, runningAttempts: 0 });
  await app.ready;
  await settle();
  const close = app.close();
  let prevented = false;
  close({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true, 'the close waits for the asynchronous activity check');
  await settle();
  assert.equal(app.messageBoxes.length, 0);
  assert.equal(app.shutdowns.length, 1);
  assert.equal(app.windowCount(), 0, 'the window closed');
});

test('second-instance focuses the existing window', async () => {
  const app = desktopApp();
  await app.ready;
  await settle();
  const secondInstance = app.lifecycle('second-instance');
  assert.equal(typeof secondInstance, 'function');
  secondInstance();
  assert.equal(app.window().focused, true);
});

test('a non-loopback health answer is refused before the window loads it', async () => {
  const app = desktopApp({
    fetch: async (url) => String(url).endsWith('/healthz')
      ? { ok: true, status: 200, text: async () => JSON.stringify({ status: 'ok' }) }
      : { ok: false, status: 404, text: async () => '', json: async () => ({}) },
  });
  await app.ready;
  await settle();
  assert.equal(app.state().phase, 'connection-failed');
  assert.ok(!app.loaded.some(url => url.includes('/team')));
});

test('renewal mints and exchanges again without navigating the window', async () => {
  const app = desktopApp();
  await app.ready;
  await settle();
  const before = app.loaded.length;
  const exchangedBefore = app.exchangeRequests.length;
  app.mainFrame.url = `${ORIGIN}/team`;

  const event = { sender: app.contents, senderFrame: app.mainFrame };
  const token = await app.ipcHandlers.get('desktop:reconnect')(event);

  assert.equal(token, 'C'.repeat(43), 'renewal returns a fresh anti-forgery token');
  assert.equal(app.mints.length, 2, 'renewal mints a new one-time code');
  assert.equal(app.exchangeRequests.length, exchangedBefore + 1, 'renewal exchanges the new code');
  assert.equal(app.loaded.length, before, 'renewal does not navigate the window');
});

test('Open in browser mints a fresh code, copies it, and never puts it in the opened URL', async () => {
  // The close dialog defaults to Keep running; this one dialog is answered with Open browser.
  const app = desktopApp({ closeResponse: box => (String(box.title) === 'Open in browser' ? 0 : 1) });
  await app.ready;
  await settle();
  const item = app.menuItem('Open in browser');
  assert.ok(item && typeof item.click === 'function', 'the Engine menu offers Open in browser');

  await item.click();
  await settle();

  assert.equal(app.mints.length, 2, 'Open in browser mints a fresh code, separate from the window pairing');
  const code = app.mints[app.mints.length - 1];
  assert.deepEqual(app.clipboardWrites, [code], 'the code is copied to the clipboard');
  assert.equal(app.externalUrls.length, 1, 'exactly one browser page is opened');
  const [url] = app.externalUrls;
  assert.equal(url, `${ORIGIN}/team`);
  assert.ok(!url.includes(code), 'the code never appears in the opened URL');
  assert.ok(app.messageBoxes.find(box => String(box.detail || '').includes(code)), 'the code is shown to the owner in a dialog');
});

test('Open in browser opens nothing when the dialog is dismissed', async () => {
  const app = desktopApp({ closeResponse: box => (String(box.title) === 'Open in browser' ? 1 : 0) });
  await app.ready;
  await settle();
  await app.click('Open in browser');
  await settle();
  assert.equal(app.messageBoxes.length, 1, 'the code dialog was shown');
  assert.deepEqual(app.externalUrls, [], 'Cancel does not open a browser');
});

test('the Engine menu offers Stop engine and Reconnect', async () => {
  const app = desktopApp();
  await app.ready;
  await settle();
  assert.equal(typeof app.menuItem('Stop engine').click, 'function');
  assert.equal(typeof app.menuItem('Reconnect').click, 'function');
  await app.click('Stop engine');
  await settle();
  assert.equal(app.shutdowns.length, 1);
  assert.equal(app.state().phase, 'stopped');
});

// ---------------------------------------------------------------------------
// Races between an owner action and a startup still in flight
// ---------------------------------------------------------------------------

test('Stop engine during startup publishes stopped and never start-failed', async () => {
  const app = desktopApp({ readyPending: true });
  await app.ready;
  await settle();
  assert.equal(app.phase(), 'starting', 'the engine has been forked but is not ready yet');

  await app.click('Stop engine');
  await settle();
  // Readiness resolves late, after the owner already stopped the engine.
  app.resolveReady();
  await settle();

  assert.equal(app.phase(), 'stopped');
  assert.ok(!app.phases().includes('start-failed'), `Start-failed must not be published, got ${JSON.stringify(app.phases())}`);
  assert.deepEqual(app.phases().filter(phase => phase === 'stopped').length, 1, 'exactly one stopped publish');
  assert.ok(app.engineHandle().killed, 'a child that never reached ready is ended directly');
  assert.equal(app.state().phase, 'stopped');
});

test('Reconnect during startup waits for it instead of publishing checking', async () => {
  const app = desktopApp({ readyPending: true });
  await app.ready;
  await settle();
  const phasesBefore = app.phases().length;

  const reconnect = app.ipcHandlers.get('desktop:reconnect-engine')();
  await settle();
  assert.equal(app.started(), 1, 'Reconnect does not fork a second engine');
  assert.ok(!app.phases().slice(phasesBefore).includes('checking'),
    `Reconnect must not publish a phase while a start is in flight, got ${JSON.stringify(app.phases().slice(phasesBefore))}`);

  app.resolveReady();
  await settle();
  await reconnect;
  assert.equal(app.phase(), 'running');
  assert.equal(app.state().phase, 'ready');
});

test('a stop during startup ignores the readiness that arrives afterwards', async () => {
  const app = desktopApp({ readyPending: true });
  await app.ready;
  await settle();
  await app.click('Stop engine');
  app.resolveReady();
  await settle();
  assert.equal(app.origin(), null, 'a stopped engine never publishes an origin');
  assert.deepEqual(app.published().filter(message => message.phase === 'ready'), [], 'the window is never told it is ready');
  assert.equal(app.window().getURL?.() ?? 'file', 'file', 'the window stays on the first-run page');
});

test('a stop while connecting stops before the window can load the team page', async () => {
  let releaseDependencies;
  const app = desktopApp({
    // Hold the dependency probe so the stop lands inside the startup chain.
    fetch: async (url) => {
      const href = String(url);
      if (href.endsWith('/healthz')) return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'ok', pid: 4321, runningAttempts: 0 }) };
      if (href.includes('/owner-session/exchange')) {
        await new Promise(resolve => { releaseDependencies = resolve; });
        return {
          ok: true, status: 200,
          headers: { get: () => 'multi_agent_owner=COOKIE_' + 'X'.repeat(36) + '; HttpOnly; Path=/api' },
          json: async () => ({ antiForgeryToken: 'C'.repeat(43) }),
        };
      }
      return { ok: false, status: 404, text: async () => '' };
    },
  });
  await app.ready;
  await settle();
  await app.click('Stop engine');
  await settle();
  releaseDependencies();
  await settle();
  assert.ok(!app.loaded.some(url => url.endsWith('/team')), 'a stopped engine leaves the window on the first-run page');
  assert.equal(app.phase(), 'stopped');
});

test('Reconnect while the engine is running pairs again without forking another child', async () => {
  const app = desktopApp();
  await app.ready;
  await settle();
  const forks = app.started();
  const exchanged = app.exchangeRequests.length;
  await app.click('Reconnect');
  await settle();
  assert.equal(app.started(), forks, 'the running engine is reused');
  assert.equal(app.exchangeRequests.length, exchanged + 1, 'the window is paired again');
  assert.equal(app.phase(), 'running');
});

test('a live engine whose page will not load is unreachable, not running', async () => {
  let healthy = false;
  const app = desktopApp({
    fetch: async (url, init) => {
      const href = String(url);
      if (href.endsWith('/healthz')) {
        if (!healthy) return { ok: false, status: 503, text: async () => '' };
        return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'ok', pid: 4321, runningAttempts: 0 }) };
      }
      if (href.includes('/owner-session/exchange')) {
        return {
          ok: true, status: 200,
          headers: { get: () => 'multi_agent_owner=COOKIE_' + 'X'.repeat(36) + '; HttpOnly; Path=/api' },
          json: async () => ({ antiForgeryToken: 'C'.repeat(43) }),
        };
      }
      return { ok: false, status: 404, text: async () => '' };
    },
  });
  await app.ready;
  await settle();
  assert.equal(app.state().phase, 'connection-failed');
  assert.equal(app.phase(), 'unreachable', 'the child is alive, the page never loaded');
  assert.ok(!app.loaded.some(url => url.endsWith('/team')));

  // Reconnect pairs the same child again rather than forking another.
  healthy = true;
  const forks = app.started();
  await app.click('Reconnect');
  await settle();
  assert.equal(app.started(), forks, 'the live engine is reused');
  assert.equal(app.phase(), 'running');
  assert.ok(app.loaded.some(url => url.endsWith('/team')));
});

test('quitting while the engine is unreachable still asks, because the count is unknown', async () => {
  const app = desktopApp({
    fetch: async (url) => (String(url).endsWith('/healthz')
      ? { ok: false, status: 503, text: async () => '' }
      : { ok: false, status: 404, text: async () => '', json: async () => ({}) }),
  });
  await app.ready;
  await settle();
  assert.equal(app.phase(), 'unreachable');
  app.electron.app.quit();
  await settle();
  assert.equal(app.messageBoxes.length, 1, 'an unknown activity answer asks rather than assumes idle');
  assert.equal(app.shutdowns.length, 0, 'Keep running leaves the engine up');
});