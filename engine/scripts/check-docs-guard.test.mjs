import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { buildDocsGuardMessage, findBlockedDocsPaths, listTrackedDocsPaths } from "./check-docs-guard.mjs";

test("findBlockedDocsPaths allows durable docs folders and rejects other docs paths", () => {
  const blocked = findBlockedDocsPaths([
    "docs/as-built/architecture.md",
    "docs/reference/sdlc-conventions.md",
    "docs/releases/v0.1.12.md",
    "docs/plans/2026-04-10-thing.md",
    "docs/local/notes.md",
    "README.md",
    "docs/plans/2026-04-10-thing.md",
  ]);

  assert.deepEqual(blocked, [
    "docs/local/notes.md",
    "docs/plans/2026-04-10-thing.md",
  ]);
});

test("buildDocsGuardMessage explains the policy and offending files", () => {
  const message = buildDocsGuardMessage([
    "docs/plans/example.md",
  ]);

  assert.match(message, /Blocked tracked docs paths/);
  assert.match(message, /docs\/plans\/example\.md/);
  assert.match(message, /docs\/as-built\/, docs\/reference\/, and docs\/releases\//);
});

// 572bc477 — docs/DESIGN.md is RATIFIED doctrine, and the guard failed to encode it.
//
// `docs/as-built/ui/library-specs-and-design-system.md` §4 states it outright: "The canonical
// Loom visual/design system is `docs/DESIGN.md` (at the repo `docs/` root, NOT under
// `docs/as-built/`). Q1 is ratified: DESIGN.md stays at root, byte-identical."
//
// Root placement is therefore a deliberate, recorded decision — not drift to be tidied away.
// It also cannot be satisfied by relocating into any allowed root:
//   docs/as-built/  — all 24 files there carry `last-verified-against-source`; DESIGN.md is not
//                     source-derived, and Q1 explicitly rules this out anyway
//   docs/reference/ — that directory SHIPS (build-package.sh stages it into the package and the
//                     daemon materializes it to $LOOM_HOME/reference/), so moving there would
//                     start distributing the brand spec to every install
//   docs/releases/  — not a release note
// So this one file is named explicitly rather than relocated, and the directory allowlist is
// left alone. Consequence today: root `npm run test:repo` cannot pass on a clean tree, which
// trains people to ignore a gate that is otherwise doing real work.
test("findBlockedDocsPaths allows the ratified docs/DESIGN.md root placement", () => {
  assert.deepEqual(findBlockedDocsPaths(["docs/DESIGN.md"]), []);
});

// Guard-of-the-guard: the exception must be EXACT-PATH, never a hole in the docs/ root. If this
// ever goes green for a sibling root file, the fix has widened into a directory allowance and
// the ephemera policy the guard exists to enforce is gone.
// Deliberately does NOT include docs/DESIGN.md in the input: this pin must hold IDENTICALLY
// before and after the fix. Coupling it to the new allowance would make it a third RED and
// destroy its value — an invariant that only starts passing once you change the code is not
// an invariant, it is a restatement of the feature.
test("the DESIGN.md exception is exact-path — sibling root docs and plan/note folders stay blocked", () => {
  assert.deepEqual(
    findBlockedDocsPaths([
      "docs/OTHER.md",
      "docs/plans/example.md",
      "docs/notes/scratch.md",
    ]),
    ["docs/OTHER.md", "docs/notes/scratch.md", "docs/plans/example.md"],
  );
});

// Integration: the unit contract above is worthless if the real script still fails on the real
// tree. This asserts the actual operator-visible outcome — `npm run test:repo` can be green and
// therefore trustworthy again.
test("the real check-docs-guard.mjs exits 0 against the actual repository", () => {
  // process.execPath, not ambient "node": pins the child to the SAME runtime executing this
  // test rather than whatever PATH happens to resolve.
  // fileURLToPath, not URL.pathname: pathname stays percent-encoded, so a checkout under a
  // path containing spaces would silently resolve to the wrong cwd — this repo has no spaces,
  // so the naive form passes HERE and fails elsewhere, which is the worst kind of green.
  const result = execFileSync(process.execPath, ["scripts/check-docs-guard.mjs"], {
    encoding: "utf8",
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.trim(), "");
});

// The entry guard is not a formality: `import.meta.url` and process.argv[1] only compare equal
// through pathToFileURL, and a plain `file://${argv[1]}` interpolation made the script exit 0
// without running on Windows. This proves the CLI actually reaches main() by giving it a tree
// whose only tracked doc is blocked.
test("the CLI entry runs the guard when executed directly", () => {
  const repo = mkdtempSync(join(tmpdir(), "loom-docs-guard-entry-"));
  try {
    mkdirSync(join(repo, "docs/plans"), { recursive: true });
    writeFileSync(join(repo, "docs/plans/example.md"), "fixture\n");
    execFileSync("git", ["init", "--quiet", repo]);
    execFileSync("git", ["add", "--", "docs"], { cwd: repo });
    const script = new URL("./check-docs-guard.mjs", import.meta.url);
    const result = execFileSync(process.execPath, [fileURLToPath(script)], {
      cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    assert.fail(`the guard exited 0 on a blocked tree: ${result}`);
  } catch (error) {
    assert.equal(error.status, 1, error.stderr);
    assert.match(error.stderr, /docs\/plans\/example\.md/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// The unusual-filename reader is a POSIX contract: a Windows file name cannot carry `\n` or a
// tab at all, so the fixture is skipped there rather than narrowed into a weaker assertion.
const windowsFilenameLimits = process.platform === "win32" ? "POSIX file names only" : false;

// Git quotes non-ASCII, tabs and newlines in its default line-based output.
test("the real tracked-path reader preserves unusual documentation filenames", { skip: windowsFilenameLimits }, () => {
  const repo = mkdtempSync(join(tmpdir(), "loom-docs-guard-"));
  try {
    const paths = ["docs/notes\nextra.md", "docs/équipe.md", "docs/reference/topic\tname.md"];
    execFileSync("git", ["init", "--quiet", repo]);
    mkdirSync(join(repo, "docs/reference"), { recursive: true });
    for (const file of paths) writeFileSync(join(repo, file), "fixture");
    execFileSync("git", ["add", "--", "docs"], { cwd: repo });
    const tracked = listTrackedDocsPaths((command, args, options) =>
      execFileSync(command, args, { ...options, cwd: repo }));
    assert.deepEqual([...tracked].sort(), [...paths].sort());
    assert.deepEqual(findBlockedDocsPaths(tracked), ["docs/notes\nextra.md", "docs/équipe.md"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
