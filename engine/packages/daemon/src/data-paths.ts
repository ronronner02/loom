import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { migrateDataRoot, legacyRootFor, type DataRootMigrationResult } from "./migrate-data-root.js";

export interface DataRoots {
  state: string;
  config: string;
}

/**
 * Resolve the roots a fresh installation uses. An explicit LOOM_HOME names one root for both
 * state and configuration, and a caller that set it owns that location's history: no migration
 * may move it.
 */
export function resolveDataRoots(options: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
} = {}): DataRoots {
  const env = options.env ?? process.env;
  const override = env.LOOM_HOME?.trim();
  if (override) return { state: override, config: override };
  const home = options.home ?? homedir();
  if ((options.platform ?? process.platform) === "win32") {
    return {
      state: win32.join(env.LOCALAPPDATA || win32.join(home, "AppData", "Local"), "Loom"),
      config: win32.join(env.APPDATA || win32.join(home, "AppData", "Roaming"), "Loom"),
    };
  }
  const root = join(home, ".loom");
  return { state: root, config: root };
}

/**
 * The former installation root this platform would have used, or null when the caller chose its
 * own location and Loom therefore knows of no history to move.
 */
export function legacyDataRoots(options: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
} = {}): DataRoots | null {
  const env = options.env ?? process.env;
  if (env.LOOM_HOME?.trim()) return null;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const legacy = legacyRootFor({ platform, home, env });
  // Windows keeps state and configuration apart; one hidden folder holds both elsewhere.
  const config = platform === "win32"
    ? legacyRootFor({ platform, home, env: { ...env, LOCALAPPDATA: env.APPDATA } })
    : legacy;
  return { state: legacy, config };
}

/**
 * Move an existing installation's data into Loom's root, exactly once, before anything opens the
 * database. Returns what happened so a caller can log it; throws when the move fails, because
 * starting against a half-moved tree would lose rows the owner still expects.
 */
export function migrateDataRootsOnce(options: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  log?: (message: string) => void;
} = {}): DataRootMigrationResult {
  const current = resolveDataRoots(options);
  const legacy = legacyDataRoots(options);
  return migrateDataRoot({
    dataRoot: current.state,
    legacyRoot: legacy?.state ?? null,
    // One folder holds both roots on POSIX; only Windows pairs a second destination.
    extraPairs: legacy === null || legacy.config === legacy.state ? undefined : [{ dataRoot: current.config, legacyRoot: legacy.config }],
    log: options.log,
  });
}

export function getLoomHome(): string {
  return resolveDataRoots().state;
}

export function getStatePath(filename: string): string {
  return join(getLoomHome(), filename);
}

export function getConfigPath(filename: string): string {
  return join(resolveDataRoots().config, filename);
}

export const LOOM_HOME = getLoomHome();