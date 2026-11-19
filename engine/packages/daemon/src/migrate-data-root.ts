import Database from "better-sqlite3";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";

/**
 * The one-time move of an installation's state from the product's former data root to Loom's.
 *
 * The old root and the database name are lowercase constants the owner decision fixed; nothing
 * reads them at runtime, because the migration is the only consumer and it runs once.
 */
export const LEGACY_DATA_ROOT_NAME = "Multi-Agent";
export const LEGACY_DB_FILENAME = "multi-agent.sqlite";
export const DB_FILENAME = "loom.sqlite";

/** The files SQLite keeps beside a database, plus the schema-upgrade backups; they move with it. */
const DB_SIDE_SUFFIX = /^-(?:wal|shm|journal|pre-reboot-backup)$|^\.v\d+-\d+\.bak$/;

export interface DataRootMigrationOptions {
  /** The root Loom resolves today. */
  dataRoot: string;
  /** The root installations used before the rename, or null when this platform had none. */
  legacyRoot: string | null;
  /** Extra root pairs that must move together (Windows keeps state and configuration apart). */
  extraPairs?: Array<{ dataRoot: string; legacyRoot: string }>;
  /**
   * The root the database's stored paths name, when that is not the root being moved. A copied
   * installation keeps the paths of the installation it came from, and those are what must follow.
   */
  rewriteFromRoot?: string;
  log?: (message: string) => void;
}

export interface DataRootMigrationResult {
  /** `none` when there is nothing to migrate, `moved` after a same-volume rename. */
  outcome: "none" | "moved" | "left-in-place";
  from: string | null;
  to: string;
  /** How many rows in the moved database named a path under the old root. */
  rewrittenRows: number;
  /** Library paths in this host's `claude_desktop_config.json`, when the root carried that file. */
  desktopPaths: Array<{ file: string; path: string }>;
}

/**
 * Move the legacy data root into place before anything opens the database.
 *
 * Rules, in order:
 * - The new root exists: use it. The old root is left untouched and named in the log. Two roots
 *   are never merged, because a merge that fails halfway leaves no way to tell which rows came
 *   from where.
 * - Only the old root exists: rename it onto the new path (one rename, same volume), then rename
 *   the database and its `-wal`/`-shm` siblings inside it.
 * - Both exist: the new one wins; nothing is written to either.
 * - The rename fails (a locked file, another volume): nothing is left half-moved. The new root is
 *   renamed back when part of the move had landed, and the error names both paths.
 */
export function migrateDataRoot(options: DataRootMigrationOptions): DataRootMigrationResult {
  const log = options.log ?? ((message: string) => console.error(message));
  const pairs = [{ dataRoot: options.dataRoot, legacyRoot: options.legacyRoot }, ...(options.extraPairs ?? [])];
  const pending = pairs.filter((pair): pair is { dataRoot: string; legacyRoot: string } => !!pair.legacyRoot);

  if (pending.length === 0) {
    return { outcome: "none", from: null, to: options.dataRoot, rewrittenRows: 0, desktopPaths: [] };
  }

  // This root pair is the one being asked about; the extras only report their own state, so the
  // caller can name an old configuration root it left behind.
  const newExists = existsSync(options.dataRoot);
  const oldExists = !!options.legacyRoot && existsSync(options.legacyRoot);
  if (newExists) {
    for (const pair of pending) {
      if (existsSync(pair.legacyRoot)) {
        log(`[data-migration] ${pair.legacyRoot} was left in place: ${pair.dataRoot} already exists.`);
      }
    }
    return { outcome: oldExists ? "left-in-place" : "none", from: options.legacyRoot, to: options.dataRoot, rewrittenRows: 0, desktopPaths: [] };
  }
  if (!oldExists || !options.legacyRoot) {
    return { outcome: "none", from: null, to: options.dataRoot, rewrittenRows: 0, desktopPaths: [] };
  }

  const oldPresent = pending.filter(pair => existsSync(pair.legacyRoot));
  const moved: typeof oldPresent = [];
  let rewrites = 0;
  const desktopPaths: Array<{ file: string; path: string }> = [];
  try {
    for (const pair of oldPresent) {
      // `rename` refuses a missing parent; creating it is part of making the move, not a second
      // convention. The parent must exist for the rename to be the only write before opening.
      mkdirp(dirname(pair.dataRoot));
      renameSync(pair.legacyRoot, pair.dataRoot);
      moved.push(pair);
    }
  } catch (error) {
    rollback(moved);
    throw new Error(
      `The Loom data folder could not be moved from ${options.legacyRoot} to ${options.dataRoot}: `
      + `${(error as Error).message}. Close any running Loom or Multi-Agent process and start again; `
      + "nothing was changed.",
    );
  }

  for (const pair of moved) {
    try {
      renameLegacyDatabase(pair.dataRoot);
      // An installation can carry two databases: the daemon's under `engine/`, and an older one
      // the CLI wrote in the root. Each is rewritten, because either could hold a live run.
      for (const dbPath of [join(pair.dataRoot, "engine", DB_FILENAME), join(pair.dataRoot, DB_FILENAME)]) {
        if (existsSync(dbPath)) rewrites += rewriteDataRootPaths(dbPath, options.rewriteFromRoot ?? pair.legacyRoot, pair.dataRoot);
      }
      desktopPaths.push(...rewriteDesktopConfig(pair.dataRoot, pair.legacyRoot, pair.dataRoot));
      repointWorktreeLinks(pair.dataRoot, options.rewriteFromRoot ?? pair.legacyRoot, pair.dataRoot);
    } catch (error) {
      // The root itself already moved; a failed file step must not be reported as a clean
      // migration, and the next start finds the new root and would otherwise skip the file work.
      throw new Error(
        `The Loom data folder moved to ${pair.dataRoot}, but its database could not be renamed `
        + `(${(error as Error).message}). Stop any running process and start again.`,
      );
    }
  }
  log(`[data-migration] moved ${options.legacyRoot} to ${options.dataRoot}`);
  return { outcome: "moved", from: options.legacyRoot, to: options.dataRoot, rewrittenRows: rewrites, desktopPaths };
}

/**
 * Point every worktree that moved with this root at its repository again.
 *
 * `<worktree>/.git` is a pointer file naming the administrative entry git keeps for it under the
 * repository that owns it. The move changes where the worktree sits without changing where its
 * repository's admin directory is, so the pointer is rewritten only when its target is inside the
 * moved root — a worktree of a repository that stayed put, like the owner's own project checkout,
 * names a location that did not move and is left alone.
 */
export function repointWorktreeLinks(dataRoot: string, legacyRoot: string, targetRoot: string): number {
  let repointed = 0;
  for (const base of [join(dataRoot, "engine", "wt"), join(dataRoot, "engine", "state", "workers", "assignments")]) {
    for (const { file, pointer } of worktreePointers(base)) {
      const next = rewritePath(pointer, legacyRoot, targetRoot);
      // The admin entry is written fresh: git records it mode 0444, and an in-place rewrite of a
      // read-only link fails where a replace does not.
      if (next === null || !existsSync(next)) continue;
      rmSync(file, { force: true });
      writeFileSync(file, `gitdir: ${next}\n`);
      repointed += 1;
    }
  }
  return repointed;
}

/** Every `.git` pointer file beneath a directory tree, with the path it names. */
function worktreePointers(directory: string): Array<{ file: string; pointer: string }> {
  return listDirectories(directory).flatMap(child => {
    const file = join(child, ".git");
    if (existsSync(file) && lstatSync(file).isFile()) {
      const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(file, "utf8"));
      const pointer = match?.[1]?.trim();
      if (pointer !== undefined) return [{ file, pointer }];
    }
    // A candidate sits under its worker's assignment directory, and a plan worktree under the
    // run's; the walk goes all the way down because neither depth is fixed.
    return worktreePointers(child);
  });
}

function listDirectories(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => join(directory, entry.name));
  } catch {
    return [];
  }
}

function mkdirp(directory: string): void {
  if (existsSync(directory)) return;
  mkdirp(dirname(directory));
  try { mkdirSync(directory); } catch { /* A concurrent starter may have won. */ }
}

/**
 * Rename the database and each sibling SQLite keeps beside it.
 *
 * The file may sit directly in the data root or in `engine/`, depending on which host wrote it.
 * Both places are tried, and the child is spelled the way the check itself must open it.
 */
export function renameLegacyDatabase(dataRoot: string): void {
  for (const directory of [dataRoot, join(dataRoot, "engine")]) {
    const legacy = join(directory, LEGACY_DB_FILENAME);
    const current = join(directory, DB_FILENAME);
    if (existsSync(current) || !existsSync(legacy)) continue;
    renameSync(legacy, current);
    for (const entry of readdirSync(directory)) {
      if (!entry.startsWith(LEGACY_DB_FILENAME) || entry === LEGACY_DB_FILENAME) continue;
      const suffix = entry.slice(LEGACY_DB_FILENAME.length);
      if (!DB_SIDE_SUFFIX.test(suffix)) continue;
      renameSync(join(directory, entry), join(directory, DB_FILENAME + suffix));
    }
  }
}

/**
 * Rewrite the library paths of this host's MCP client configuration, when the root carried one.
 *
 * Claude Desktop reads that file from its own directory, not from Loom, but the daemon writes it
 * for the owner. Its entries are per-root and are the only non-database file the migration must
 * change: everything else it carries is runtime state that resolves its location on the next boot.
 */
export function rewriteDesktopConfig(dataRoot: string, legacyRoot: string, targetRoot: string): Array<{ file: string; path: string }> {
  const file = join(dataRoot, "claude_desktop_config.json");
  if (!existsSync(file)) return [];
  const config = JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: Record<string, { args?: unknown[] }> };
  const rewritten: Array<{ file: string; path: string }> = [];
  for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
    const args = Array.isArray(server?.args) ? server.args : [];
    for (let index = 0; index < args.length; index++) {
      const value = args[index];
      if (typeof value !== "string") continue;
      const next = rewritePath(value, legacyRoot, targetRoot);
      if (next === null) continue;
      args[index] = next;
      rewritten.push({ file, path: `${name}.args[${index}]` });
    }
  }
  if (rewritten.length > 0) writeFileSync(file, JSON.stringify(config, null, 2) + String.fromCharCode(10));
  return rewritten;
}

/** Path columns whose bytes name a location on disk. */
const PATH_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: "queue_items", column: "target_repo" },
  { table: "nodes", column: "cwd" },
  { table: "nodes", column: "policy_declaring_dir" },
  { table: "rigs", column: "install_root" },
  { table: "rigs", column: "rig_policy_declaring_dir" },
  { table: "team_runs", column: "integration_worktree" },
  { table: "team_runs", column: "integration_repository" },
  { table: "team_integration_intents", column: "worktree" },
  { table: "team_integration_intents", column: "repository" },
  { table: "team_bootstraps", column: "repository" },
];

/**
 * Rewrite every stored absolute path that pointed into the old root.
 *
 * A worktree under the former root is the case that breaks a running installation: the row is
 * read back as a repository, and a path that no longer exists fails where the owner cannot see
 * why. The database is opened directly (no daemon, no schema work) and one transaction covers
 * every table, so a failure leaves the rows as they were.
 */
export function rewriteDataRootPaths(dbPath: string, legacyRoot: string, dataRoot: string): number {
  const db = new Database(dbPath);
  try {
    const columns = new Set<string>(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
      .flatMap(row => (db.prepare(`PRAGMA table_info("${(row as { name: string }).name}")`).all() as Array<{ name: string }>)
        .map(column => `${(row as { name: string }).name}.${column.name}`)));
    // The schema is the live one, so a table or column this installation never created is skipped
    // rather than assumed present; only real rows can name a path this move must follow.
    const rewrites: Array<{ table: string; column: string; from: string; to: string }> = [];
    for (const { table, column } of PATH_COLUMNS) {
      if (!columns.has(`${table}.${column}`)) continue;
      const rows = db.prepare(`SELECT DISTINCT "${column}" AS value FROM "${table}" WHERE "${column}" IS NOT NULL`)
        .all() as Array<{ value: string }>;
      for (const { value } of rows) {
        const rewritten = rewritePath(value, legacyRoot, dataRoot);
        if (rewritten !== null) rewrites.push({ table, column, from: value, to: rewritten });
      }
    }
    if (rewrites.length === 0) return 0;
    db.transaction(() => {
      for (const { table, column, from, to } of rewrites) {
        db.prepare(`UPDATE "${table}" SET "${column}" = ? WHERE "${column}" = ?`).run(to, from);
      }
    })();
    return rewrites.reduce((count, { table, column, from, to }) =>
      count + (db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE "${column}" = ?`).get(to) as { n: number }).n, 0);
  } finally {
    db.close();
  }
}

/** The same path under the new root, or null when it is not under the old one. */
export function rewritePath(value: string, legacyRoot: string, dataRoot: string): string | null {
  if (!isAbsolute(value)) return null;
  const from = normalize(value);
  const root = normalize(legacyRoot);
  if (from !== root && !from.startsWith(root + sep) && !from.startsWith(root + "/")) return null;
  const tail = from.slice(root.length).replace(/^[\\/]+/, "");
  return join(dataRoot, ...tail.split(/[\\/]+/).filter(Boolean));
}

/**
 * A path's canonical spelling, lowercased, with forward slashes.
 *
 * Both sides of every comparison are canonicalized, so a spelling that names one directory twice
 * — the 8.3 short form and the long form on Windows — cannot make them look like two.
 */
function normalize(value: string): string {
  const trimmed = value.trim();
  let canonical = trimmed;
  // `realpathSync.native` asks the OS; the JavaScript resolver leaves an 8.3 short segment as it
  // is. A machine whose TEMP or home is a short path would otherwise compare a short spelling
  // against a long one and call one directory two.
  try { canonical = realpathSync.native(trimmed); } catch { /* the target may be gone; its spelling still counts */ }
  return canonical.replace(/[\\/]+$/, "").replace(/\\/g, "/").replace(/[A-Z]/g, character => character.toLowerCase());
}

function rollback(moved: Array<{ dataRoot: string; legacyRoot: string }>): void {
  for (const pair of [...moved].reverse()) {
    try { renameSync(pair.dataRoot, pair.legacyRoot); } catch { /* Reported by the caller's error. */ }
  }
}

/** Apply a legacy root only when the new one is absent; the shared precondition for both hosts. */
export function legacyRootFor(options: { platform: NodeJS.Platform; home: string; env: NodeJS.ProcessEnv }): string {
  if (options.platform === "win32") {
    const base = options.env.LOCALAPPDATA || join(options.home, "AppData", "Local");
    return join(base, LEGACY_DATA_ROOT_NAME);
  }
  return join(options.home, "." + LEGACY_DATA_ROOT_NAME.toLowerCase());
}