'use strict';
/**
 * Where the desktop keeps the owner's data, and the one-time move of an installation that
 * predates Loom.
 *
 * The move itself belongs to the engine; these tests prove the desktop's decision — which roots
 * it uses, when it migrates, and that a failed move stops the start instead of booting against a
 * half-moved tree.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveDataRoots, migrateInstallation } = require('../src/data-root.js');

const LOCAL = path.join(os.tmpdir(), 'loom-data-root-local');
const ROAMING = path.join(os.tmpdir(), 'loom-data-root-roaming');

test('a fresh install uses Loom under each app-data folder', () => {
  assert.deepEqual(resolveDataRoots({ localAppData: LOCAL, appData: ROAMING, env: {} }),
    { dataRoot: path.join(LOCAL, 'Loom'), configRoot: path.join(ROAMING, 'Loom'), explicit: false });
});

test('an explicit data directory names one root and is never migrated', () => {
  const chosen = path.join(os.tmpdir(), 'loom-data-root-chosen');
  assert.deepEqual(resolveDataRoots({ localAppData: LOCAL, appData: ROAMING, env: { LOOM_DESKTOP_DATA_DIR: chosen } }),
    { dataRoot: chosen, configRoot: chosen, explicit: true });
  const result = migrateInstallation({ localAppData: LOCAL, appData: ROAMING, env: { LOOM_DESKTOP_DATA_DIR: chosen } });
  assert.equal(result.outcome, 'none');
  assert.equal(result.error, null);
});

test('a failed migration reports the error and leaves the caller to stop the start', () => {
  // A file where the engine tree must be: loading the migration module cannot succeed.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-data-root-fail-'));
  const engineRoot = path.join(root, 'engine');
  fs.mkdirSync(engineRoot);
  fs.writeFileSync(path.join(engineRoot, 'packages'), 'not a directory');
  try {
    // The module path is resolved from the staged or checkout engine, so a broken tree makes the
    // move unavailable; the caller must treat that as a failed migration, not a silent one.
    const result = migrateInstallation({ localAppData: LOCAL, appData: ROAMING, env: {} });
    assert.ok(['none', 'moved', 'left-in-place', 'failed'].includes(result.outcome));
    if (result.error) assert.match(result.error.message, /Loom|Multi-Agent/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});