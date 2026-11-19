import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDocsGuardMessage, findBlockedDocsPaths, listTrackedDocsPaths } from "./check-docs-guard.mjs";

test("findBlockedDocsPaths allows the shipped reference directory and rejects any other docs path", () => {
  const blocked = findBlockedDocsPaths([
    "docs/reference/sdlc-conventions.md",
    "docs/reference/agent-state-taxonomy.md",
    "docs/as-built/architecture.md",
    "docs/releases/v0.1.12.md",
    "docs/DESIGN.md",
    "docs/plans/2026-04-10-thing.md",
    "docs/local/notes.md",
    "README.md",
    "docs/plans/2026-04-10-thing.md",
  ]);

  assert.deepEqual(blocked, [
    "docs/DESIGN.md",
    "docs/as-built/architecture.md",
    "docs/local/notes.md",
    "docs/plans/2026-04-10-thing.md",
    "docs/releases/v0.1.12.md",
  ]);
});

test("buildDocsGuardMessage explains the policy and names the offending files", () => {
  const message = buildDocsGuardMessage([
    "docs/DESIGN.md",
    "docs/plans/example.md",
  ]);

  assert.match(message, /Blocked tracked docs paths/);
  assert.match(message, /docs\/DESIGN\.md/);
  assert.match(message, /docs\/plans\/example\.md/);
  assert.match(message, /docs\/reference\//);
  assert.match(message, /repository root or in docs\//);
});

// Guard-of-the-guard: a durable page added directly under `engine/docs/` is the mistake this
// guard exists to catch. If this ever goes green for `engine/docs/architecture.md`, the shipped
// root has widened into a hole and a document that never reaches a user would be tracked under a
// directory whose only tracked content is supposed to ship.
test("a durable page added under engine/docs/ root is still blocked", () => {
  assert.deepEqual(
    findBlockedDocsPaths(["docs/architecture.md", "docs/development.md", "docs/reference/help.md"]),
    ["docs/architecture.md", "docs/development.md"],
  );
});

// Integration: the unit contract above is worthless if the real script still fails on the real
// tree. This asserts the actual operator-visible outcome: `npm run test:repo` is green and can
// therefore be trusted.
test("the real check-docs-guard.mjs exits 0 against the actual repository", () => {
  // process.execPath, not ambient "node": pins the child to the SAME runtime executing this
  // test rather than whatever PATH happens to resolve.
  // fileURLToPath, not URL.pathname: pathname stays percent-encoded, so a checkout under a
  // path containing spaces would silently resolve to the wrong cwd.
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