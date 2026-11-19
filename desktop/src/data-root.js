'use strict';
/**
 * Where the desktop host keeps the owner's data, and the one-time move of an installation that
 * predates Loom.
 *
 * The rule matches the engine's: an explicit LOOM_DESKTOP_DATA_DIR names a location the caller
 * chose and is never migrated; otherwise state is `%LOCALAPPDATA%\Loom` and configuration is
 * `%APPDATA%\Loom`, and an installation under the former name is carried over before the engine
 * starts. The move itself is the engine's single implementation, so the desktop and a
 * CLI-started daemon cannot drift apart on what counts as a complete migration.
 */

const path = require('node:path');

/** The engine's own module for the move; its location is already the one this app runs. */
function migrateModule() {
  return require('./engine-paths.js').dataRootMigration();
}

/**
 * Both roots this host uses.
 *
 * @param {object} opts
 * @param {string} opts.localAppData – the per-user local application data folder
 * @param {string} opts.appData – the per-user roaming application data folder
 * @param {object} opts.env – the process environment, for the explicit override
 */
function resolveDataRoots(opts) {
  const override = opts.env.LOOM_DESKTOP_DATA_DIR;
  if (override) return { dataRoot: override, configRoot: override, explicit: true };
  return {
    dataRoot: path.join(opts.localAppData, 'Loom'),
    configRoot: path.join(opts.appData, 'Loom'),
    explicit: false,
  };
}

/**
 * Move a carried-over installation into Loom's root.
 *
 * @param {object} opts
 * @param {string} opts.localAppData
 * @param {string} opts.appData
 * @param {object} opts.env
 * @returns {{dataRoot: string, configRoot: string, outcome: string, error: Error|null}}
 */
function migrateInstallation(opts) {
  const roots = resolveDataRoots(opts);
  if (roots.explicit) return { ...roots, outcome: 'none', error: null };
  try {
    const { migrateDataRoot } = migrateModule();
    const result = migrateDataRoot({
      dataRoot: roots.dataRoot,
      legacyRoot: path.join(opts.localAppData, 'Multi-Agent'),
      extraPairs: [{ dataRoot: roots.configRoot, legacyRoot: path.join(opts.appData, 'Multi-Agent') }],
    });
    return { ...roots, outcome: result.outcome, error: null };
  } catch (error) {
    // A migration that could not finish must stop the start rather than boot against a half-moved
    // tree; the error already names both paths.
    return { ...roots, outcome: 'failed', error };
  }
}

module.exports = { resolveDataRoots, migrateInstallation };
