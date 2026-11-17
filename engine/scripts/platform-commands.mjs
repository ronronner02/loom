// Platform facts the repository scripts and their tests need to stay portable.

import { mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * How to run npm without a shell.
 *
 * `spawn("npm", ...)` fails with ENOENT on Windows (npm is a `.cmd` shim) and `spawn("npm.cmd",
 * ...)` fails with EINVAL (Node refuses `.cmd` without a shell). Running npm's own CLI entry under
 * the current Node works on every platform and, unlike `shell: true`, keeps each argument escaped.
 */
export function npmCommand() {
  const execpath = process.env.npm_execpath;
  if (execpath) return { command: process.execPath, prefix: [execpath] };
  const nodeDir = dirname(process.execPath);
  for (const entry of [
    join(nodeDir, "node_modules/npm/bin/npm-cli.js"),
    join(nodeDir, "../lib/node_modules/npm/bin/npm-cli.js"),
  ]) {
    if (existsSync(entry)) return { command: process.execPath, prefix: [entry] };
  }
  throw new Error(`npm CLI entry not found next to ${process.execPath}; set npm_execpath`);
}

let symlinkSupport;

/**
 * Whether this machine can create symlinks.
 *
 * Windows needs Developer Mode or an elevated token for file symlinks, and a Git checkout made
 * with `core.symlinks=false` stores them as plain files. Fixtures that need either should skip
 * with this fact rather than fail.
 */
export function supportsSymlinks() {
  if (symlinkSupport !== undefined) return symlinkSupport;
  let root;
  try {
    root = mkdtempSync(join(tmpdir(), "symlink-probe-"));
    writeFileSync(join(root, "target"), "probe");
    symlinkSync(join(root, "target"), join(root, "link"));
    symlinkSupport = true;
  } catch {
    symlinkSupport = false;
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
  }
  return symlinkSupport;
}

let rsyncPresent;

/**
 * Whether `rsync` is on this machine.
 *
 * The skill mirror's legacy apply modes are written against rsync; Windows has none, and the
 * digest check (`mirror-skills.mjs --check`) needs no external tool at all. Callers that depend on
 * rsync skip with this fact instead of failing a test run.
 */
export function hasRsync() {
  if (rsyncPresent !== undefined) return rsyncPresent;
  rsyncPresent = spawnSync("rsync", ["--version"], { encoding: "utf8", stdio: "ignore" }).status === 0;
  return rsyncPresent;
}