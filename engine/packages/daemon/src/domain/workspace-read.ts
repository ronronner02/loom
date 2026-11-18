import { closeSync, fstatSync, openSync, opendirSync, readFileSync, readdirSync, readSync, statSync } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, resolve, sep } from "node:path";
import { isRedirectingEntry, isWindows } from "./platform.js";

/**
 * Bounded reads of a tree the daemon does not own.
 *
 * A candidate, a worker's report and the owner's own documents are all read through here. The
 * rules are the same for each: a path that leaves its root is refused, a link that would redirect
 * a read is refused by name, and a file or a directory listing larger than a browse can carry is
 * refused rather than truncated. Nothing here writes, and nothing here runs a program.
 */

/** `O_NOFOLLOW` refuses a symlink at the leaf instead of reading through it. POSIX-only. */
export const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
/** `O_DIRECTORY` refuses anything that is not a directory, which is how a swap is caught. */
export const O_DIRECTORY = fsConstants.O_DIRECTORY ?? 0;
/** `O_NONBLOCK` keeps a swapped-in FIFO from blocking the control before `fstat` refuses it. */
export const O_NONBLOCK = fsConstants.O_NONBLOCK ?? 0;
export const OPEN_READ = fsConstants.O_RDONLY;

/** The hash a manifest records for one file's bytes. */
export const sha256 = (bytes: Buffer | string): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export type WorkspaceRead =
  | { kind: "missing" }
  | { kind: "directory"; entries: Array<{ name: string; kind: "directory" | "file" }> }
  | { kind: "file"; content: string; hash: string };

/**
 * Refuse a leaf that the host would follow as a link, on hosts without `O_NOFOLLOW`.
 *
 * `O_NOFOLLOW` and `O_DIRECTORY` are POSIX open flags and Node reports them as `undefined` on
 * Windows, so opening the same path there would follow a swapped-in junction or symlink without
 * any error — the guarantee would vanish silently. Windows therefore checks the entry itself:
 * `lstat` reports a junction and a symbolic link as links, and the read is refused by name.
 * POSIX keeps using the flags, which also close the race this check cannot.
 */
export function refuseRedirectedLeaf(target: string, path: string): void {
  if (!isWindows()) return;
  try {
    if (isRedirectingEntry(target)) throw new Error(`Candidate path became a symlink while it was read: ${path}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Candidate path became a symlink")) throw error;
    throw new Error(`Candidate path is unreadable: ${path} (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`);
  }
}

/** Open a directory for traversal, refusing anything that is not a real directory. */
export function openDirectory(parentDescriptor: number, name: string, path: string): number {
  const target = parentDescriptor < 0 ? path : `/proc/self/fd/${parentDescriptor}/${name}`;
  try {
    return openSync(target, OPEN_READ | O_DIRECTORY | O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOTDIR") {
      throw new Error(`Candidate path became a symlink while it was read: ${path}`);
    }
    throw new Error(`Candidate directory is unreadable: ${path} (${code ?? (error as Error).message})`);
  }
}

/** Bounded reads through pinned directories: no Git, temporary stores, or scope callbacks. */
export function readWorkspacePath(root: string, path: string, excluded: (path: string) => boolean): WorkspaceRead {
  const parts = path === "" ? [] : path.split("/");
  if (!isAbsolute(root) || path.length > 4096 || parts.length > 64
    || parts.some(part => !part || part === "." || part === ".." || /[\\\x00-\x1f]/.test(part)) || excluded(path)) {
    throw new Error("Workspace path not available");
  }
  // Windows has no `/proc/self/fd` and no `O_NOFOLLOW`, so the same read is made by path with an
  // explicit reparse-point check on every component: a junction or symlink anywhere below the root
  // refuses the read instead of redirecting it. POSIX keeps the descriptor walk below, which also
  // closes the swap race the check cannot.
  if (isWindows()) return readWorkspacePathByPath(root, parts, path, excluded);
  // Pin the root's ancestors too: replacing an assignment directory must not redirect a read.
  let descriptor = openDirectory(-1, "", sep);
  try {
    for (const part of resolve(root).split(sep).filter(Boolean)) {
      const next = openDirectory(descriptor, part, root);
      closeSync(descriptor);
      descriptor = next;
    }
    for (const part of parts) {
      const next = openSync(`/proc/self/fd/${descriptor}/${part}`, OPEN_READ | O_NOFOLLOW | O_NONBLOCK);
      closeSync(descriptor);
      descriptor = next;
    }
    const stat = fstatSync(descriptor);
    if (stat.isDirectory()) {
      const entries: Array<{ name: string; kind: "directory" | "file" }> = [];
      const directory = opendirSync(`/proc/self/fd/${descriptor}`);
      try {
        let count = 0;
        for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
          if (++count > 1000) throw new Error("Workspace directory exceeds browse limit");
          if (!/[\\\x00-\x1f]/.test(entry.name) && !excluded(path ? `${path}/${entry.name}` : entry.name) && (entry.isDirectory() || entry.isFile())) {
            entries.push({ name: entry.name, kind: entry.isDirectory() ? "directory" : "file" });
          }
        }
      } finally { directory.closeSync(); }
      return { kind: "directory", entries: entries.sort((a, b) => a.name.localeCompare(b.name)) };
    }
    if (!stat.isFile() || stat.size > 262144) throw new Error("Workspace file exceeds browse limit");
    const bytes = Buffer.alloc(262145);
    let size = 0, count: number;
    while (size < bytes.length && (count = readSync(descriptor, bytes, size, bytes.length - size, null)) > 0) size += count;
    if (size > 262144 || bytes.subarray(0, size).includes(0)) throw new Error("Workspace file not available as text");
    return { kind: "file", content: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)), hash: sha256(bytes.subarray(0, size)) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw error;
  } finally { closeSync(descriptor); }
}

/**
 * The same bounded read, by path, for hosts without `/proc/self/fd`.
 *
 * Every component below the root is checked with `lstat` before it is read, so a junction or
 * symbolic link is refused by name rather than followed. A file's own reparse point is refused too,
 * and the byte cap is applied to the opened descriptor, so a file that grew after the check is still
 * bounded.
 */
function readWorkspacePathByPath(root: string, parts: string[], path: string, excluded: (path: string) => boolean): WorkspaceRead {
  let current = resolve(root);
  refuseRedirectedLeaf(current, path);
  for (const part of parts) {
    current = join(current, part);
    refuseRedirectedLeaf(current, path);
  }
  let stat: ReturnType<typeof statSync>;
  try { stat = statSync(current); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw new Error(`Workspace path is unreadable: ${path} (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`);
  }
  if (stat.isDirectory()) {
    const entries: Array<{ name: string; kind: "directory" | "file" }> = [];
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entries.length > 1000) throw new Error("Workspace directory exceeds browse limit");
      if (/[\\\x00-\x1f]/.test(entry.name) || excluded(path ? `${path}/${entry.name}` : entry.name)) continue;
      // A link is neither a directory nor a file for this purpose: it would redirect a later read.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() || entry.isFile()) entries.push({ name: entry.name, kind: entry.isDirectory() ? "directory" : "file" });
    }
    return { kind: "directory", entries: entries.sort((a, b) => a.name.localeCompare(b.name)) };
  }
  if (!stat.isFile() || stat.size > 262144) throw new Error("Workspace file exceeds browse limit");
  const bytes = readFileSync(current);
  if (bytes.length > 262144 || bytes.includes(0)) throw new Error("Workspace file not available as text");
  return { kind: "file", content: new TextDecoder("utf-8", { fatal: true }).decode(bytes), hash: sha256(bytes) };
}