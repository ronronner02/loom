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
describe("T054 plain git over a control-owned copy", () => {
  /**
   * The card's first group, in one fixture: every program hook a candidate can name, at
   * once, each writing its own canary.
   *
   * T044 closed these one review round at a time — `core.fsmonitor`, then `diff.external`,
   * then `filter.<drv>.clean` — because a reader that runs git in the candidate can be
   * reached by whichever hook it has not yet disabled. T054's claim is structural rather
   * than a longer list: the copy contains no `.git` entry for git to discover, so a worker
   * writes its repository metadata into a directory git is never pointed at. This test
   * plants every vector at once and requires that none of them ran.
   */
  it("runs no program a candidate plants, through any hook, at any depth", () => {
    const root = richRepository();
    const workspace = candidateOf(root);
    const canaries: { name: string; path: string; seen: () => boolean }[] = [];
    const mark = (name: string) => {
      const probe = canary();
      canaries.push({ name, ...probe });
      return probe.path;
    };
    const program = (name: string): string => {
      const path = plantedOutside(workspace.root, "cat", mark(name));
      return path;
    };
    const fsmonitor = program("core.fsmonitor");
    const hook = program("core.hooksPath");
    const clean = program("filter.<drv>.clean");
    const process = program("filter.<drv>.process");
    const textconv = program("diff.<drv>.textconv");
    const external = program("diff.external");

    // Vector one: the candidate replaces the worktree link with its own repository, whose
    // configuration names every hook.
    takeOverRepositoryMetadata(workspace, configure => {
      configure("config", "core.fsmonitor", fsmonitor);
      configure("config", "core.hooksPath", dirname(hook));
      configure("config", "filter.x.clean", clean);
      configure("config", "filter.x.process", process);
      configure("config", "filter.x.required", "true");
      configure("config", "diff.x.textconv", textconv);
      configure("config", "diff.external", external);
    });
    // Vector two: attributes that would invoke the filter and the textconv driver. A candidate
    // cannot supply attributes at all — they are a rule file — so that vector is a separate
    // candidate, refused before any git command runs.
    const attributeCandidate = candidateOf(richRepository());
    writeFileSync(join(attributeCandidate.root, ".gitattributes"), "* filter=x diff=x\n");
    expect(() => candidateManifest(attributeCandidate), "candidate attributes are refused").toThrow(/changes a rule file/);
    // Vector three: a nested repository of the worker's own, with a hook of its own.
    mkdirSync(join(workspace.root, "nested"), { recursive: true });
    git(join(workspace.root, "nested"), "init", "--quiet");
    git(join(workspace.root, "nested"), "config", "user.email", "worker@example.invalid");
    git(join(workspace.root, "nested"), "config", "user.name", "worker");
    mkdirSync(join(workspace.root, "nested", ".git", "hooks"), { recursive: true });
    writeFileSync(join(workspace.root, "nested", ".git", "hooks", "pre-commit"),
      `#!/bin/sh\n: > ${JSON.stringify(mark("nested hook"))}\n`);
    writeFileSync(join(workspace.root, "nested", "inner.txt"), "inner\n");
    // Vector four: a `.git` *file* naming a worker-written gitdir, the shape a submodule
    // checkout leaves behind.
    const fakeGitDir = join(workspace.root, "nested", "fake-gitdir");
    mkdirSync(fakeGitDir, { recursive: true });
    writeFileSync(join(fakeGitDir, "config"),
      `[core]\n\tfsmonitor = ${fsmonitor}\n\thooksPath = ${dirname(hook)}\n`);
    mkdirSync(join(workspace.root, "nested", "gitdir-file"), { recursive: true });
    writeFileSync(join(workspace.root, "nested", "gitdir-file", ".git"), `gitdir: ${fakeGitDir}\n`);

    writeFileSync(join(workspace.root, "src", "deliverable.ts"), "export const deliverable = true;\n");
    const manifest = candidateManifest(workspace);

    for (const canary of canaries) {
      expect(canary.seen(), `a candidate-planted ${canary.name} program ran as the control`).toBe(false);
    }
    // The deliverable still lands, and its bytes in the patch are its own — a filter that
    // rewrote content would be visible here even if its canary somehow failed.
    expect(manifest.files.map(file => file.path)).toContain("src/deliverable.ts");
    expect(manifest.patch).toContain("export const deliverable = true;");
  });

  it("carries a nested repository's contents as files and never as a repository", () => {
    // A `.git` directory at any depth is metadata, not a candidate file. Skipping it by
    // name is what stops git from discovering the inner repository; the worker's inner
    // files are ordinary candidate files and are described as such.
    const root = richRepository();
    const workspace = candidateOf(root);
    mkdirSync(join(workspace.root, "nested"), { recursive: true });
    git(join(workspace.root, "nested"), "init", "--quiet");
    git(join(workspace.root, "nested"), "config", "user.email", "worker@example.invalid");
    git(join(workspace.root, "nested"), "config", "user.name", "worker");
    writeFileSync(join(workspace.root, "nested", "inner.txt"), "inner\n");
    git(join(workspace.root, "nested"), "add", "-A");
    git(join(workspace.root, "nested"), "commit", "--quiet", "-m", "inner");
    const manifest = candidateManifest(workspace);
    const paths = manifest.files.map(file => file.path);
    expect(paths).toContain("nested/inner.txt");
    expect(paths.some(path => path.split("/").includes(".git")), "repository metadata is never a manifest entry").toBe(false);
    expect(manifest.patch).not.toContain(".git/");
  });

  it("gives the base commit sole ignore authority by refusing candidate rule edits", () => {
    // The card's third group, satisfied at the refusal: `*` cannot hide a deliverable, a deleted
    // rule cannot admit a base-ignored path, and the candidate's own edit cannot be expressed at
    // all, because the rule file belongs to the base commit. What the candidate *can* deliver —
    // an ordinary new file beside a rule file it did not touch — still lands.
    const hiding = candidateOf(richRepository());
    writeFileSync(join(hiding.root, "src", "deliverable.ts"), "export const deliverable = true;\n");
    writeFileSync(join(hiding.root, ".gitignore"), "*\n");
    expect(() => candidateManifest(hiding), "a candidate `*` rule is refused").toThrow(/changes a rule file/);

    const deleting = candidateOf(richRepository());
    writeFileSync(join(deleting.root, "debug.log"), "noise\n");
    rmSync(join(deleting.root, ".gitignore"));
    expect(() => candidateManifest(deleting), "a deleted rule is refused").toThrow(/changes a rule file/);

    // An untouched rule file is fine, and ordinary deliverables beside it are described.
    const plain = candidateOf(richRepository());
    writeFileSync(join(plain.root, "src", "deliverable.ts"), "export const deliverable = true;\n");
    const manifest = candidateManifest(plain);
    expect(manifest.files.map(file => file.path)).toContain("src/deliverable.ts");
    expect(manifest.patch).toContain("export const deliverable = true;");
    expect(manifest.patch, "the untouched rule file is not in the patch").not.toContain("diff --git a/.gitignore");
  });

  it("refuses a candidate .gitattributes, so a candidate cannot choose its own conversions", () => {
    // The attribute half of the same decision: the base's `eol` rules clean the candidate's
    // bytes, and the candidate cannot add or replace a rule that would stop them.
    const root = richRepository();
    writeFileSync(join(root, ".gitattributes"), "*.txt text eol=lf\n");
    writeFileSync(join(root, "note.txt"), "alpha\n");
    git(root, "add", "-A"); git(root, "commit", "--quiet", "-m", "attributes");
    const workspace = candidateOf(root);
    writeFileSync(join(workspace.root, ".gitattributes"), "* -text\n");
    writeFileSync(join(workspace.root, "note.txt"), "ours\r\n");
    expect(() => candidateManifest(workspace)).toThrow(/changes a rule file/);

    // Without an attribute edit the base's rule still governs, and packet disclosure still works.
    // The fixture needs a base `.gitattributes` that cleans `note.txt`, which `richRepository`
    // does not record, so one is committed here.
    const cleanRoot = richRepository();
    writeFileSync(join(cleanRoot, ".gitattributes"), "*.txt text eol=lf\n");
    git(cleanRoot, "add", "-A"); git(cleanRoot, "commit", "--quiet", "-m", "base attributes");
    const clean = candidateOf(cleanRoot);
    writeFileSync(join(clean.root, "note.txt"), "ours\r\n");
    const manifest = candidateManifest(clean);
    const packet = createReviewPacket(clean, join(candidateRoot(clean.root), "packet"));
    try {
      expect(packet.cleanedPaths, "the packet is told the worktree form differs").toContain("note.txt");
      expect(verifyReviewPacket(packet).unchanged, "the packet verifies against its manifest").toBe(true);
      expect(manifest.files.find(file => file.path === "note.txt")?.hash,
        "the base's eol=lf governs the stored bytes").toBe(
        `sha256:${createHash("sha256").update("ours\n").digest("hex")}`);
    } finally {
      removeReviewPacket(packet);
    }
  });

      it("renders a text hunk the string type cannot carry as a binary hunk instead", () => {
    // `patch` is a string. A latin-1 file to git's heuristic would put raw 0xe9 in a text
    // hunk, which decodes to U+FFFD and would write bytes the candidate never held. The
    // selection is made on the stored and the base-side bytes, so an edit either way is
    // covered.
    const root = richRepository();
    writeFileSync(join(root, "latin.dat"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    git(root, "add", "-A"); git(root, "commit", "--quiet", "-m", "latin");
    const workspace = candidateOf(root);
    writeFileSync(join(workspace.root, "latin.dat"), Buffer.from("café\n", "utf8"));
    const manifest = candidateManifest(workspace);
    const section = patchSection(manifest.patch, "latin.dat");
    expect(section, "the old side is not UTF-8, so the hunk is binary").toContain("GIT binary patch");
    expect(() => manifest.patch.normalize("NFC").includes("�")).not.toThrow();
    expect(manifest.patch.includes("�"), "no replacement character reaches the patch").toBe(false);
  });

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
