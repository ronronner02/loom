import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { candidateManifest, createCandidateWorkspace, createReviewPacket, removeReviewPacket, resolveWorkspaceBase, verifyReviewPacket } from "../src/domain/team-workspace.js";
import { symlinkRefusal } from "./helpers/symlink.js";
import {
  canary, candidateOf, candidateRoot, git, gitWithByteExactConfig, patchSection, plantedOutside,
  richRepository, roots, outsideRoots, takeOverRepositoryMetadata,
} from "./helpers/t044-fixture.js";

afterEach(() => {
  for (const root of [...roots.splice(0), ...outsideRoots.splice(0)]) rmSync(root, { recursive: true, force: true });
});

// The shapes a POSIX candidate can hold and Windows cannot: a symlink to a POSIX-only path, a
// FIFO, and a file name holding a newline or a colon. Each case states the shape itself, so it
// runs where the shape can exist. The product behaviour it pins is host-independent — a link is
// recorded as its own text and never followed, an unreadable entry refuses the manifest, and a
// hostile name is quoted — and the Windows-specific boundaries are covered by
// `team-workspace-windows.test.ts`.
const posixShapesOnly = process.platform === "win32";

describe.skipIf(symlinkRefusal !== null)("T044 commit-lane manifest without a git in the candidate", () => {
/**
 * One table-driven oracle over every patch shape the round-2 reviews found; it replaces
 * the per-case `git apply` tests. Each row starts from a base commit, changes a real
 * checkout of it, then asks the only question that matters for evidence: applied at a
 * base checkout, does the patch reproduce exactly the bytes the manifest hashed? An
 * `unmodified` row instead requires an empty patch, because rewriting a tree nobody
 * touched is a false accusation.
 */
describe("T054 plain git over a control-owned copy: patch fidelity", () => {
  it("copies a realistic candidate in well under a few seconds", () => {
    // The card's stop-if: copying must not become the cost that tempts an exclusion
    // mechanism. The fixture is a few thousand small files, which is what a source tree of
    // this repository's size is; the bound is deliberately loose so a slow host does not
    // turn a reportable measurement into a flaky failure.
    const root = mkdtempSync(join(tmpdir(), "t054-scale-")); roots.push(root);
    git(root, "init", "--quiet", "--initial-branch=main");
    git(root, "config", "user.email", "test@example.invalid"); git(root, "config", "user.name", "test");
    for (let directory = 0; directory < 20; directory += 1) {
      mkdirSync(join(root, "src", `module-${directory}`), { recursive: true });
      for (let file = 0; file < 100; file += 1) {
        writeFileSync(join(root, "src", `module-${directory}`, `file-${file}.ts`),
          `export const value${file} = ${directory * 100 + file};\n`);
      }
    }
    git(root, "add", "-A"); git(root, "commit", "--quiet", "-m", "scale");
    const workspace = candidateOf(root);
    const started = Date.now();
    const manifest = candidateManifest(workspace);
    const elapsed = Date.now() - started;
    expect(manifest.files.length).toBe(2000);
    expect(manifest.patch, "an untouched candidate is still an empty patch").toBe("");
    expect(elapsed, `a 2,000-file candidate took ${elapsed}ms`).toBeLessThan(30_000);
    // The case's own bound is 30 s, so the suite's 20 s test timeout would fire before this
    // assertion could report the measurement it exists to make. Windows file-system work on a
    // runner is slow enough to reach it: measured 27.5 s there, against about 3 s here.
  }, 90_000);

  /**
   * The card's second group, as one candidate: CRLF under `eol`, a BOM-prefixed name, a
   * non-ASCII name, a symlink, an executable, a nested directory, an edit, an addition and
   * a deletion. The assertion is the only one that matters for evidence: applied at a base
   * checkout, does the patch reproduce exactly the entries the manifest recorded?
   */
  it("reproduces the manifest's entries when the patch is applied at a base checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "t054-round-")); roots.push(root);
    git(root, "init", "--quiet", "--initial-branch=main");
    git(root, "config", "user.email", "test@example.invalid"); git(root, "config", "user.name", "test");
    writeFileSync(join(root, ".gitattributes"), "*.txt text eol=lf\n");
    mkdirSync(join(root, "src", "nested", "deep"), { recursive: true });
    writeFileSync(join(root, "crlf.txt"), "alpha\n");
    writeFileSync(join(root, "anchor.txt"), "anchor\n");
    writeFileSync(join(root, "src", "edited.ts"), "export const edited = 1;\n");
    writeFileSync(join(root, "src", "gone.ts"), "export const gone = 1;\n");
    writeFileSync(join(root, "src", "nested", "deep", "leaf.ts"), "export const leaf = 1;\n");
    writeFileSync(join(root, "src", "run.sh"), "#!/bin/sh\necho hi\n");
    chmodSync(join(root, "src", "run.sh"), 0o644);
    symlinkSync("edited.ts", join(root, "src", "link.ts"));
    git(root, "add", "-A"); git(root, "commit", "--quiet", "-m", "base");
    const base = (resolveWorkspaceBase(root) as { commit: string }).commit;
    const workspace = createCandidateWorkspace({ root, base: resolveWorkspaceBase(root), workspaceRoot: candidateRoot(root), label: "T054" });
    roots.push(workspace.root);

    // Every shape at once, in the candidate.
    writeFileSync(join(workspace.root, "crlf.txt"), "beta\r\n");
    writeFileSync(join(workspace.root, "﻿anchor.txt"), "bom\n");
    writeFileSync(join(workspace.root, "src", "café.txt"), "café\n");
    writeFileSync(join(workspace.root, "src", "edited.ts"), "export const edited = 2;\n");
    rmSync(join(workspace.root, "src", "gone.ts"));
    chmodSync(join(workspace.root, "src", "run.sh"), 0o755);
    writeFileSync(join(workspace.root, "src", "nested", "deep", "leaf.ts"), "export const leaf = 2;\n");
    writeFileSync(join(workspace.root, "src", "fresh.ts"), "export const fresh = true;\n");
    const manifest = candidateManifest(workspace);

    const checkout = candidateRoot(root);
    git(tmpdir(), "clone", "--quiet", root, checkout);
    git(checkout, "checkout", "--quiet", base);
    const patchFile = join(candidateRoot(root), "candidate.patch");
    writeFileSync(patchFile, manifest.patch);
    execFileSync("git", ["-C", checkout, ...gitWithByteExactConfig, "apply", "--binary", patchFile], { stdio: ["ignore", "pipe", "pipe"] });
    git(checkout, "add", "-A");

    // The applied tree against the manifest, by content: a git blob id and the manifest's
  // sha256 are different hashes of the same bytes, so the comparison is made on the bytes
  // the patch actually wrote.
  // `-z` keeps a non-ASCII name as itself; without it `ls-files` quotes it, and the
  // comparison would fail on the quoting rather than on the content.
  const applied = execFileSync("git", ["-C", checkout, "ls-files", "-z", "--cached"], { encoding: "utf8" })
    .split("\0").filter(Boolean).sort();
  expect(applied).toEqual(manifest.files.map(file => file.path).sort());
  for (const file of manifest.files) {
    const path = join(checkout, file.path);
    // A link's reading is its target text; `readFileSync` would follow it and compare the
    // target's bytes against the link's recorded hash.
    const written = lstatSync(path).isSymbolicLink() ? Buffer.from(readlinkSync(path), "utf8") : readFileSync(path);
    const hash = `sha256:${createHash("sha256").update(written).digest("hex")}`;
    expect(hash, `${file.path} reproduces the manifest's reading`).toBe(file.hash);
  }
    // And the properties that are not visible in a blob id.
    expect(lstatSync(join(checkout, "src", "link.ts")).isSymbolicLink(), "a link stays a link").toBe(true);
    // Windows keeps no owner-executable bit on an ordinary file, so the mode change the fixture
    // makes cannot exist there; the host that can hold the bit asserts the whole round trip.
    if (process.platform !== "win32") {
      expect(statSync(join(checkout, "src", "run.sh")).mode & 0o100, "the executable bit arrives").toBe(0o100);
    }
    expect(existsSync(join(checkout, "src", "gone.ts")), "the deletion is applied").toBe(false);
    expect(readFileSync(join(checkout, "crlf.txt"), "utf8"), "the base's eol=lf governs the patch too").toBe("beta\n");
    expect(existsSync(join(checkout, "﻿anchor.txt")), "a BOM-prefixed name is its own file").toBe(true);
  });

  it("gives an unmodified candidate an empty patch", () => {
    // The other half of the round trip: rewriting a tree nobody touched is a false
    // accusation, and it is what every recorded identity depends on staying stable.
    const root = richRepository();
    const workspace = candidateOf(root);
    expect(candidateManifest(workspace).patch).toBe("");
  });

});
});
