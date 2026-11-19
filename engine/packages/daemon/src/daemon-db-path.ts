import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Resolve existing path components, including a dangling final symlink, while
 * preserving a not-yet-created tail. SQLite paths commonly do not exist yet at
 * first boot, so realpathSync alone cannot answer the containment question. */
function resolveForContainment(path: string, seen = new Set<string>()): string {
  const absolute = resolve(path);
  if (seen.has(absolute)) throw new Error(`symlink cycle while resolving ${path}`);
  seen.add(absolute);
  try {
    return realpathSync.native(absolute);
  } catch (realpathError) {
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(absolute);
    } catch (lstatError) {
      if ((realpathError as NodeJS.ErrnoException).code !== "ENOENT" ||
          (lstatError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw realpathError;
      }
      const parent = dirname(absolute);
      return parent === absolute
        ? absolute
        : join(resolveForContainment(parent, seen), basename(absolute));
    }
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(absolute);
      return resolveForContainment(resolve(dirname(absolute), target), seen);
    }
    // The path exists but realpath could not establish its identity (for
    // example EACCES or ENOTDIR). Treating that as an absent tail would turn
    // an unverified path into authority.
    throw realpathError;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/**
 * D15 — resolve the daemon's SQLite path. An explicit LOOM_DB wins
 * (the operator takes responsibility for that path); otherwise the db is anchored
 * under LOOM_HOME, NEVER a bare CWD-relative filename.
 *
 * Incident 2026-08-07: the entrypoint defaulted `dbPath` to a bare "loom.sqlite"
 * which resolves against the process CWD — so a daemon launched with an isolated
 * LOOM_HOME could still open the SHARED fleet db (whatever sat in its CWD).
 * Anchoring the default to LOOM_HOME makes an isolated-home daemon isolate its
 * db too, which is the whole point of setting LOOM_HOME.
 */
export function resolveDaemonDbPath(explicitDb: string | undefined | null, loomHome: string): string {
  if (explicitDb && explicitDb.length > 0) {
    return explicitDb;
  }
  const dbPath = join(loomHome, "loom.sqlite");
  // A home that exists but is not a directory cannot hold the database, and resolving the
  // path under it would error in a way that reads as a missing tail rather than the shape
  // problem it is. Refuse it here, where the caller can see why.
  const homeStat = lstatSync(loomHome, { throwIfNoEntry: false });
  if (homeStat && !homeStat.isDirectory() && !homeStat.isSymbolicLink()) {
    throw new Error(`LOOM_HOME is not a directory: ${loomHome}`);
  }
  const resolvedHome = resolveForContainment(loomHome);
  const resolvedDb = resolveForContainment(dbPath);
  if (!isWithin(resolvedHome, resolvedDb)) {
    throw new Error(
      `Refusing implicit database outside resolved LOOM_HOME: ${dbPath} resolves to ${resolvedDb}, ` +
      `outside ${resolvedHome}. Set LOOM_DB explicitly to authorize a deliberate split-path configuration.`,
    );
  }
  return dbPath;
}
