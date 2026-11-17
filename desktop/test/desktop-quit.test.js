'use strict';
/**
 * The close confirmation: what the engine's activity answer means, and how asking for a quit
 * behaves when that answer is slow, unknown or malformed.
 *
 * These drive `src/main.js` with a fake daemon and a fake quit probe, so the decision the dialog
 * acts on is made from the answer the app actually receives.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { desktopApp, settle } = require('./fixtures/desktop-app.js');

/** A ready app whose quit probe answers however `count` says. */
async function ready({ count = 0, closeResponse = 1, stopDelay } = {}) {
  const app = desktopApp({
    countRunningAttempts: typeof count === 'function' ? count : async () => count,
    closeResponse,
    stopDelay,
  });
  await app.ready;
  await settle();
  return app;
}

test('vetoes window close synchronously before an asynchronous activity check', async () => {
  let finish;
  const app = await ready({ count: () => new Promise((resolve) => { finish = resolve; }) });
  const close = app.close();
  let prevented = false;
  close({ preventDefault: () => { prevented = true; } });
  try {
    assert.equal(prevented, true);
    assert.equal(app.window().destroyed, false);
    assert.equal(app.messageBoxes.length, 0);
  } finally { finish(1); await settle(); }
  assert.equal(app.messageBoxes.length, 1);
  assert.equal(app.shutdowns.length, 0, 'Keep running leaves the engine alone');
});

test('menu quit obeys Keep running without shutting down the engine', async () => {
  const app = await ready({ count: 1, closeResponse: 1 });
  const prevented = app.electron.app.quit();
  await settle();
  assert.equal(prevented, true);
  assert.equal(app.messageBoxes.length, 1);
  assert.equal(app.shutdowns.length, 0);
});

test('window close and menu quit share one pending confirmation', async () => {
  let finish;
  const app = await ready({ count: () => new Promise((resolve) => { finish = resolve; }), closeResponse: 0 });
  app.close()({ preventDefault() {} });
  app.electron.app.quit();
  finish(1);
  await settle();
  assert.equal(app.shutdowns.length, 1, 'the confirmed quit shuts the engine down once');
  assert.equal(app.messageBoxes.length, 1, 'one dialog for both actions');
});

test('an idle engine shuts down and quits without a confirmation', async () => {
  const app = await ready({ count: 0 });
  app.close()({ preventDefault() {} });
  await settle();
  assert.equal(app.messageBoxes.length, 0);
  assert.equal(app.shutdowns.length, 1);
  assert.equal(app.phase(), 'stopped');
});

test('unknown activity asks before stopping rather than treating failure as idle', async () => {
  const app = await ready({ count: async () => undefined });
  app.close()({ preventDefault() {} });
  await settle();
  assert.equal(app.messageBoxes.length, 1);
  assert.equal(app.shutdowns.length, 0);
});

test('Keep running resets the pending decision so a later close asks again', async () => {
  const app = await ready({ count: 1, closeResponse: 1 });
  app.close()({ preventDefault() {} }); await settle();
  app.close()({ preventDefault() {} }); await settle();
  assert.equal(app.messageBoxes.length, 2);
  assert.equal(app.shutdowns.length, 0);
});

test('repeated quit waits for the already-confirmed engine shutdown to complete', async () => {
  let finish;
  const app = await ready({ count: 0, stopDelay: () => new Promise((resolve) => { finish = resolve; }) });
  app.electron.app.quit();
  await settle();
  assert.equal(app.shutdowns.length, 1);
  const repeated = app.electron.app.quit();
  try {
    assert.equal(repeated, true, 'a quit during the confirmed shutdown is still held');
    assert.equal(app.window().destroyed, false);
  } finally { finish(); await settle(); }
  assert.equal(app.shutdowns.length, 1);
});

for (const count of [undefined, null, -1, 1.5, '1', Number.NaN]) {
  test(`malformed activity count asks before stopping: ${JSON.stringify(count)}`, async () => {
    const app = await ready({ count: async () => count });
    app.electron.app.quit();
    await settle();
    assert.equal(app.messageBoxes.length, 1);
    assert.equal(app.shutdowns.length, 0);
  });
}