import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * The only directory under `engine/docs/` that may hold tracked files.
 *
 * `reference/` ships: `scripts/build-package.sh` stages it into the CLI package and the daemon
 * serves it to agents from `daemon/docs/reference/`. Every other document there is either a
 * source for that pack or a note, and notes are not shipped — so a tracked file elsewhere under
 * `engine/docs/` is a document in the wrong repository location.
 *
 * Durable developer documentation belongs at the repository root or in `docs/`, which this guard
 * leaves alone. A new page written to `engine/docs/architecture.md` would be silently ignored on
 * the next commit (`engine/.gitignore` keeps `docs/*` untracked), and this guard refuses it if it
 * arrives some other way.
 */
const SHIPPED_DOCS_ROOT = "docs/reference/";

export function findBlockedDocsPaths(paths) {
  return [...new Set(paths)]
    .filter((file) => file.startsWith("docs/"))
    .filter((file) => !file.startsWith(SHIPPED_DOCS_ROOT))
    .sort();
}

export function listTrackedDocsPaths(exec = execFileSync) {
  const output = exec("git", ["ls-files", "-z", "docs/**"], { encoding: "utf8" });
  return output
    .split("\0")
    .filter(Boolean);
}

export function buildDocsGuardMessage(blockedPaths) {
  return [
    `Blocked tracked docs paths detected outside ${SHIPPED_DOCS_ROOT}:`,
    ...blockedPaths.map((file) => `- ${file}`),
    "",
    `Only ${SHIPPED_DOCS_ROOT} is tracked under engine/docs/; the package build ships that directory.`,
    "Put durable developer documentation at the repository root or in docs/; keep plans, notes and",
    "evidence in the pull request and git history.",
  ].join("\n");
}

export function main() {
  const blockedPaths = findBlockedDocsPaths(listTrackedDocsPaths());
  if (blockedPaths.length === 0) return;
  console.error(buildDocsGuardMessage(blockedPaths));
  process.exitCode = 1;
}

// pathToFileURL normalizes a Windows argv[1] into the same shape as import.meta.url; the naive
// `file://${argv[1]}` comparison never matches on win32 and turns the guard into a silent no-op.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}