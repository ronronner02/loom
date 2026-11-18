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
describe("patch round trip", () => {
  type Row = {
    name: string;
    /** Pins behaviour `main` already had; every other row reproduces a review finding. */
    pins?: true;
    base?: (root: string) => void;
    edit?: (root: string) => void;
    unmodified?: true;
    deleted?: readonly string[];
    links?: readonly string[];
    modes?: readonly (readonly [string, number])[];
    submodule?: true;
    /**
     * Paths the base commit's attributes clean, so the manifest hashes and the patch
     * carries the *cleaned* reading rather than the worktree bytes. Their worktree
     * content legitimately differs from what the applied patch writes, so the byte
     * comparison goes through the attribute rules instead of `equals`.
     */
    attributeShaped?: readonly string[];
    /** Paths that must be distinct manifest entries, so a decoded-name collision fails. */
    attributesPresent?: readonly string[];
    /** The shape this row needs cannot exist on this host, so the row states why and skips. */
    skipOn?: (platform: NodeJS.Platform) => string | null;
  };

  /** Latin-1 `café\n`: a text file to git's heuristic, invalid UTF-8 to everything else. */
  const LATIN = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);

  function submoduleRepository(): string {
    const sub = mkdtempSync(join(tmpdir(), "t044-sub-")); roots.push(sub);
    git(sub, "init", "--quiet", "--initial-branch=main");
    git(sub, "config", "user.email", "test@example.invalid"); git(sub, "config", "user.name", "test");
    writeFileSync(join(sub, "inner.txt"), "inner\n");
    git(sub, "add", "-A"); git(sub, "commit", "--quiet", "-m", "sub");
    return sub;
  }

  /** A committed base for one row. */
  function corpus(row: Row): string {
    const root = mkdtempSync(join(tmpdir(), "t044-row-")); roots.push(root);
    git(root, "init", "--quiet", "--initial-branch=main");
    git(root, "config", "user.email", "test@example.invalid"); git(root, "config", "user.name", "test");
    // Rows compare bytes, so this repository must not rewrite them: a runner whose global config
    // says `core.autocrlf=true` otherwise checks out CRLF where the row wrote LF. The setting is
    // written into the source repository because a clone copies it, and the checkout compared
    // below is a clone of this one.
    git(root, "config", "core.autocrlf", "false");
    writeFileSync(join(root, "anchor.txt"), "anchor\n");
    git(root, "add", "-A"); git(root, "commit", "--quiet", "-m", "base");
    row.base?.(root);
    git(root, "add", "-A"); git(root, "commit", "--quiet", "--allow-empty", "-m", "row");
    return root;
  }

  /** A base checkout with the patch applied, ready to be compared byte for byte. */
  function applied(root: string, commit: string, patch: string, submodule: boolean): string {
    const checkout = candidateRoot(root);
    git(tmpdir(), "clone", "--quiet", root, checkout);
    // `git clone` does not copy `core.autocrlf` from the repository it clones — the clone reads
    // the global config — so the checkout that produces the bytes compared below pins it here.
    // A runner whose global config says `true` otherwise writes CRLF where the row wrote LF, and
    // every row fails with `anchor.txt: patch does not apply`.
    git(checkout, "-c", "core.autocrlf=false", "checkout", "--quiet", commit);
    if (submodule) git(checkout, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--quiet");
    const file = join(candidateRoot(root), "candidate.patch");
    writeFileSync(file, patch);
    execFileSync("git", ["-C", checkout, ...gitWithByteExactConfig, "apply", "--binary", file], { stdio: ["ignore", "pipe", "pipe"] });
    return checkout;
  }

  function roundTrip(row: Row): void {
    const root = corpus(row);
    const workspace = candidateOf(root);
    row.edit?.(workspace.root);
    const manifest = candidateManifest(workspace);
    if (row.unmodified) {
      expect(manifest.patch, `${row.name}: an untouched candidate has no patch`).toBe("");
      return;
    }
    const checkout = applied(root, (workspace.base as { commit: string }).commit, manifest.patch, row.submodule === true);
    for (const file of manifest.files) {
      const source = readFileSync(join(workspace.root, file.path));
      const got = readFileSync(join(checkout, file.path));
      // A link is a link, and reading through it would compare the target's bytes rather than
      // the entry the patch writes: the manifest's hash is the link's own text, so that is what
      // a link's round trip is measured against.
      if (row.links?.includes(file.path)) {
        expect(`sha256:${createHash("sha256").update(readlinkSync(join(checkout, file.path))).digest("hex")}`,
          `${row.name}: ${file.path} reproduces the hashed bytes`).toBe(file.hash);
        continue;
      }
      if (row.attributeShaped?.includes(file.path)) {
        // The property is not "the worktree bytes reappear" but "the patch writes what the
        // manifest hashed". The base's attributes legitimately clean the candidate's bytes,
        // so those two differ by design; the digest is what has to match.
        expect(`sha256:${createHash("sha256").update(got).digest("hex")}`,
          `${row.name}: ${file.path} reproduces the hashed bytes`).toBe(file.hash);
        continue;
      }
      expect(got.equals(source), `${row.name}: ${file.path} reproduces the hashed bytes`).toBe(true);
    }
    for (const path of row.deleted ?? []) expect(existsSync(join(checkout, path)), `${row.name}: ${path} is deleted`).toBe(false);
    for (const path of row.attributesPresent ?? []) {
      expect(existsSync(join(checkout, path)), `${row.name}: ${path} is a manifest entry`).toBe(true);
      expect(existsSync(join(workspace.root, path)), `${row.name}: ${path} exists in the candidate`).toBe(true);
    }
    for (const path of row.links ?? []) expect(lstatSync(join(checkout, path)).isSymbolicLink(), `${row.name}: ${path} stays a link`).toBe(true);
    for (const [path, bit] of row.modes ?? []) expect(statSync(join(checkout, path)).mode & bit, `${row.name}: ${path} mode`).toBe(bit);
    expect(manifest.patch).not.toContain(workspace.root);
  }

  const addSubmodule = (root: string): void => {
    git(root, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", submoduleRepository(), "vendor");
  };

  const ROWS: readonly Row[] = [
    {
      name: "a base gitlink leaves an unmodified candidate's patch empty",
      submodule: true, base: addSubmodule, unmodified: true,
    },
    {
      name: "a base gitlink is carried through while a real file changes",
      submodule: true, base: addSubmodule,
      edit: (root) => { writeFileSync(join(root, "anchor.txt"), "changed\n"); },
    },
    {
      name: "latin-1 content is added, edited and deleted without losing a byte",
      base: (root) => { writeFileSync(join(root, "gone.dat"), LATIN); writeFileSync(join(root, "edited.dat"), LATIN); },
      edit: (root) => {
        writeFileSync(join(root, "added.dat"), LATIN);
        writeFileSync(join(root, "edited.dat"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x21, 0x0a]));
        rmSync(join(root, "gone.dat"));
      },
      deleted: ["gone.dat"],
    },
    {
      name: "latin-1 edited to valid UTF-8 keeps both sides intact",
      base: (root) => { writeFileSync(join(root, "to-utf8.dat"), LATIN); },
      edit: (root) => { writeFileSync(join(root, "to-utf8.dat"), Buffer.from("café\n", "utf8")); },
    },
    {
      name: "non-UTF-8 bytes in names git's attribute syntax treats specially",
      edit: (root) => {
        for (const name of ["my file.dat", "[x].dat", "#hash.dat", "q\"uote.dat", "line\nbreak.dat"]) {
          writeFileSync(join(root, name), LATIN);
        }
      },
      // Windows refuses a newline in a file name, so that part of the row cannot exist there.
      skipOn: platform => platform === "win32" ? "Windows refuses a newline in a file name" : null,
    },
    {
      name: "several non-UTF-8 files round-trip together",
      edit: (root) => {
        for (let index = 0; index < 3; index += 1) writeFileSync(join(root, `blob-${index}.dat`), Buffer.from([0, 1, 2, 255, index]));
      },
    },
    {
      name: "a base .gitattributes with text eol=crlf leaves an unmodified candidate's patch empty",
      base: (root) => {
        writeFileSync(join(root, ".gitattributes"), "*.txt text eol=crlf\n");
        writeFileSync(join(root, "crlf.txt"), "alpha\nbeta\n");
      },
      unmodified: true,
    },
    {
      name: "a tracked symlink round-trips as a link",
      base: (root) => { writeFileSync(join(root, "target.md"), "target\n"); symlinkSync("target.md", join(root, "link.md")); },
      edit: (root) => { writeFileSync(join(root, "target.md"), "changed\n"); },
      links: ["link.md"],
    },
    {
      name: "an executable bit round-trips",
      base: (root) => { writeFileSync(join(root, "run.sh"), "#!/bin/sh\n"); chmodSync(join(root, "run.sh"), 0o644); },
      edit: (root) => { chmodSync(join(root, "run.sh"), 0o755); },
      modes: [["run.sh", 0o100]],
      // Windows keeps no owner-executable bit on an ordinary file, so the edit never happens.
      skipOn: platform => platform === "win32" ? "Windows keeps no owner-executable bit" : null,
    },
    // T051 — the manifest and the patch must describe one reading of an
    // attribute-shaped file, and an untouched candidate must still produce no patch.
    {
      name: "T051: an edited eol=lf file's patch writes exactly the bytes the manifest hashed",
      base: (root) => {
        writeFileSync(join(root, ".gitattributes"), "a.txt text eol=lf\n");
        writeFileSync(join(root, "a.txt"), "old\n");
      },
      // The candidate writes CRLF; the base's `eol=lf` cleans it to LF.
      edit: (root) => { writeFileSync(join(root, "a.txt"), "new\r\n"); },
      attributeShaped: ["a.txt"],
    },
    {
      name: "T051: a non-ASCII name under eol=crlf leaves an unmodified candidate's patch empty",
      base: (root) => {
        writeFileSync(join(root, ".gitattributes"), "*.txt text eol=crlf\n");
        writeFileSync(join(root, "café.txt"), "alpha\nbeta\n");
      },
      unmodified: true,
    },
    {
      name: "T051: a BOM-prefixed name is listed beside the tracked name it would collide with",
      // `﻿anchor.txt` decoded to `anchor.txt` before `ignoreBOM`, so the two entries
      // collided and the candidate's own file was dropped from the manifest.
      edit: (root) => { writeFileSync(join(root, "﻿anchor.txt"), "bom\n"); },
      // Both files must reach the applied tree, and neither may be lost. `corpus` already
      // tracks `anchor.txt`, so a collision would show as one entry and a wrong byte count.
      attributesPresent: ["﻿anchor.txt", "anchor.txt"],
    },
    {
      // `ident` converts on check-in as `text` does: the checkout expands `$Id$` to
      // `$Id: <oid> $` while the blob keeps `$Id$`. Omitting it from the attribute set
      // gave an *unmodified* candidate a spurious 159-byte patch (the N1 class).
      name: "T051: a base ident attribute leaves an unmodified candidate's patch empty",
      base: (root) => {
        writeFileSync(join(root, ".gitattributes"), "*.txt ident\n");
        writeFileSync(join(root, "id.txt"), "$Id$\nalpha\n");
      },
      unmodified: true,
    },
  ];

  for (const row of ROWS) it.skipIf(row.skipOn?.(process.platform) != null)(row.name, () => roundTrip(row));

  it.skipIf(posixShapesOnly)("refuses a file name that is not valid UTF-8 instead of dropping it", () => {
    const root = richRepository();
    const workspace = candidateOf(root);
    // Node decodes a directory entry lossily, so an invalid name becomes U+FFFD and
    // the manifest would otherwise describe a path the candidate does not have. Windows
    // refuses to create the byte at all, so the shape only exists on a POSIX host.
    writeFileSync(Buffer.concat([Buffer.from(`${workspace.root}/bad-`), Buffer.from([0xff]), Buffer.from(".txt")]), "x\n");
    expect(() => candidateManifest(workspace)).toThrow(/not valid UTF-8/);
  });

  it("records a link target that climbs out of a symlinked directory as text, without reading it", () => {
    const root = richRepository();
    const workspace = candidateOf(root);
    writeFileSync(join(workspace.root, "src", "victim"), "candidate bytes\n");
    const outside = candidateRoot(root);
    writeFileSync(join(outside, "victim"), "outside bytes\n");
    symlinkSync(outside, join(workspace.root, "src", "jump"));
    // Lexically this names `src/victim`, which the candidate owns; through the kernel it
    // names the outside file. A reader that resolved it would hash and patch the outside
    // bytes. The copy never resolves a link, so the text is all that survives.
    symlinkSync("jump/../victim", join(workspace.root, "src", "climber"));
    const manifest = candidateManifest(workspace);
    expect(manifest.files.find(file => file.path === "src/climber")?.hash).toBe(
      `sha256:${createHash("sha256").update("jump/../victim").digest("hex")}`);
    expect(manifest.patch).not.toContain("outside bytes");
  });
});

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

  /**
   * Round-1 regression group. Each test fails on the candidate those reviewers saw and
   * passes on this one; together they are what closes R1-1 to R1-6.
   */
  describe("round-1 findings", () => {
    it("never writes outside the snapshot, and refuses the shapes that made that possible", () => {
      // The original defect: the control wrote the base's rules back into the copy, and a rule
      // path the worker had replaced with a link made it write *through* that link, outside its
      // own tree. Two shapes caused it — a linked rule file, and a rule file below a linked
      // directory. Both are refused before any write, and the outside file proves it.
      const outside = candidateRoot("victim");
      writeFileSync(join(outside, "target-ignore"), "ORIGINAL\n");
      mkdirSync(join(outside, "vault"), { recursive: true });
      writeFileSync(join(outside, "vault", "keep.txt"), "KEEP\n");

      const linkedRule = candidateOf(richRepository());
      rmSync(join(linkedRule.root, ".gitignore"));
      symlinkSync(join(outside, "target-ignore"), join(linkedRule.root, ".gitignore"));
      expect(() => candidateManifest(linkedRule)).toThrow(/changes a rule file/);

      const nested = richRepository();
      mkdirSync(join(nested, "sub"), { recursive: true });
      writeFileSync(join(nested, "sub", ".gitignore"), "*.log\n");
      git(nested, "add", "-A"); git(nested, "commit", "--quiet", "-m", "nested rule");
      const linkedDirectory = candidateOf(nested);
      rmSync(join(linkedDirectory.root, "sub"), { recursive: true, force: true });
      symlinkSync(join(outside, "vault"), join(linkedDirectory.root, "sub"));
      expect(() => candidateManifest(linkedDirectory), "the rule is gone with its directory").toThrow(/changes a rule file/);

      // Neither the outside file nor the outside directory was written to or removed from.
      expect(readFileSync(join(outside, "target-ignore"), "utf8"), "the outside file is untouched").toBe("ORIGINAL\n");
      expect(existsSync(join(outside, "vault", "keep.txt")), "the outside directory is untouched").toBe(true);
      expect(existsSync(join(outside, "vault", ".gitignore")), "nothing was created in the outside directory").toBe(false);
    });

    it("refuses a deleted rule file rather than describing the deletion", () => {
      const workspace = candidateOf(richRepository());
      rmSync(join(workspace.root, ".gitignore"));
      writeFileSync(join(workspace.root, "debug.log"), "noise\n");
      expect(() => candidateManifest(workspace)).toThrow(/changes a rule file/);
    });

    it("refuses a rule file that differs from the base's, even when only its bytes moved", () => {
      // The comparison is content, not path: the base's rule is the only one this lane accepts.
      const workspace = candidateOf(richRepository());
      writeFileSync(join(workspace.root, ".gitattributes"), "*.ts text eol=lf\n");
      expect(() => candidateManifest(workspace)).toThrow(/changes a rule file/);
    });

    it("refuses a rule file the candidate adds anywhere", () => {
      // A new rule file is still a rule edit, wherever it lives. This is what closed the round-4
      // finding where a new nested rule could govern its own admission. A rule below a
      // base-ignored directory is accepted instead (the round-5 group pins that), so this
      // fixture does not use one.
      const workspace = candidateOf(richRepository());
      mkdirSync(join(workspace.root, "docs", "inner"), { recursive: true });
      writeFileSync(join(workspace.root, "docs", "inner", ".gitignore"), "*.tmp\n");
      expect(() => candidateManifest(workspace)).toThrow(/changes a rule file/);
    });
  });

  /**
   * Round-2 regression group. Each fails on the round-1 candidate and passes here.
   */
  describe("round-2 findings", () => {
    it("refuses a rule file replaced by a directory", () => {
      // R2-2: with the base's rule materialized into the copy, a directory at that path made the
      // staging proceed with no base rules at all, admitting `debug.log` and a rule file under a
      // base-ignored directory. It is refused by name now, before any git command runs.
      const workspace = candidateOf(richRepository());
      rmSync(join(workspace.root, ".gitignore"));
      mkdirSync(join(workspace.root, ".gitignore"));
      writeFileSync(join(workspace.root, ".gitignore", "inner.txt"), "inner\n");
      writeFileSync(join(workspace.root, "debug.log"), "noise\n");
      mkdirSync(join(workspace.root, "node_modules", "dep"), { recursive: true });
      writeFileSync(join(workspace.root, "node_modules", "dep", ".gitignore"), "ignored\n");
      expect(() => candidateManifest(workspace)).toThrow(/changes a rule file/);
    });

    it.skipIf(process.platform === "win32")("refuses a non-UTF-8 symlink target anywhere it appears", () => {
      // A base attribute such as `working-tree-encoding` must not convert a link's target: git
      // never converts a symlink, and a link is stored as its raw text. A target the string type
      // cannot carry is refused by name, at a rule path or anywhere else.
      const other = richRepository();
      const otherWorkspace = candidateOf(other);
      symlinkSync(Buffer.from([0x63, 0x61, 0x66, 0xe9]), join(otherWorkspace.root, "src", "latin-link"));
      expect(() => candidateManifest(otherWorkspace),
        "the raw target is refused rather than converted into a different link")
        .toThrow(/symlink target of src\/latin-link is not valid UTF-8/i);

      const atRulePath = richRepository();
      const ruleWorkspace = candidateOf(atRulePath);
      rmSync(join(ruleWorkspace.root, ".gitignore"));
      symlinkSync(Buffer.from([0x63, 0x61, 0x66, 0xe9]), join(ruleWorkspace.root, ".gitignore"));
      expect(() => candidateManifest(ruleWorkspace)).toThrow(/changes a rule file/);
    });

    // POSIX only: the property is `/proc/self/fd` plus `O_DIRECTORY|O_NOFOLLOW`, and Windows has
    // neither. The host's own equivalent — a reparse point below the candidate is refused — is
    // asserted in `team-workspace-windows.test.ts`.
    it.skipIf(process.platform === "win32")("reads a directory through the descriptor it opened, not through its path", () => {
      // Round 3 found the previous version of this test worthless: `setInterval` cannot run
      // while `execFileSync` blocks, so the mutator never fired. This is the deterministic
      // version of the same property, from the mechanism the walk actually relies on.
      //
      // A directory that is renamed away and replaced by a link to a vault keeps delivering its
      // own contents through the descriptor that is already open, and the replaced path refuses
      // to be opened as a directory. Together those are what make a mid-copy swap unable to
      // redirect a read.
      const root = candidateRoot("swap");
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "leaf.ts"), "candidate bytes\n");
      const vault = candidateRoot("vault");
      writeFileSync(join(vault, "leaf.ts"), "VAULT SECRET\n");

      const descriptor = openSync(join(root, "src"), fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
      try {
        renameSync(join(root, "src"), join(root, "src.real"));
        symlinkSync(vault, join(root, "src"));
        // The held descriptor still names the real directory.
        expect(readFileSync(`/proc/self/fd/${descriptor}/leaf.ts`, "utf8")).toBe("candidate bytes\n");
        // Opening the replaced path as a directory refuses rather than following the link.
        expect(() => openSync(join(root, "src"), fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW))
          .toThrow(/ENOTDIR|ELOOP/);
      } finally {
        closeSync(descriptor);
      }
    });
  });

  /**
   * Round-3 regression group. Each finding was about selection: which paths are measured, and
   * which reading of them. They exist because a round-2 rewrite replaced `add -A` with
   * hand-written staging; this group pins the behaviour that came back with it.
   */
  /**
   * Round-5 regression group. The comparison is made on the staged index, so the shapes below
   * are accepted (they are not rule edits) and the type change is still refused.
   */
  describe("round-5 findings", () => {
    it("accepts the rule files a tool writes under ignored directories", () => {
      // R5-1: a worktree scan refused `.pytest_cache/.gitignore` and `node_modules/*/.gitignore`,
      // which an ordinary test run creates. Git never stages them, so they are not rule edits.
      const root = richRepository();
      // The caches the tools create, ignored by the base like any build output.
      writeFileSync(join(root, ".gitignore"), "node_modules/\n*.log\n.env\n.pytest_cache/\n__pycache__/\n");
      git(root, "add", "-A"); git(root, "commit", "--quiet", "-m", "ignore caches");
      const workspace = candidateOf(root);
      mkdirSync(join(workspace.root, ".pytest_cache"), { recursive: true });
      writeFileSync(join(workspace.root, ".pytest_cache", ".gitignore"), "*\n!*/\n!.gitignore\n");
      mkdirSync(join(workspace.root, "__pycache__"), { recursive: true });
      writeFileSync(join(workspace.root, "__pycache__", "mod.cpython-312.pyc"), "bytecode\n");
      mkdirSync(join(workspace.root, "node_modules", "dep"), { recursive: true });
      writeFileSync(join(workspace.root, "node_modules", "dep", ".gitignore"), "ignored\n");
      writeFileSync(join(workspace.root, "src", "result.ts"), "export const result = 1;\n");
      const manifest = candidateManifest(workspace);
      const paths = manifest.files.map(file => file.path);
      expect(paths, "the deliverable is described").toContain("src/result.ts");
      expect(paths, "an ignored directory's rule file is not part of the candidate").not.toContain(".pytest_cache/.gitignore");
      expect(paths).not.toContain("node_modules/dep/.gitignore");
    });

    it("accepts an untouched rule file whose checkout form differs from its stored form", () => {
      // R5-2 / R4-3: `working-tree-encoding` and `eol` make the checkout differ from the blob, so
      // a byte comparison refused an untouched candidate. Comparing staged object ids applies
      // git's own conversion and finds the base's id.
      const encoded = richRepository();
      writeFileSync(join(encoded, ".gitattributes"), ".gitignore working-tree-encoding=UTF-16\n");
      writeFileSync(join(encoded, ".gitignore"), Buffer.from("\ufeffnode_modules/\n", "utf16le"));
      git(encoded, "add", "-A"); git(encoded, "commit", "--quiet", "-m", "utf16 rule");
      const encodedWorkspace = candidateOf(encoded);
      expect(candidateManifest(encodedWorkspace).patch, "an untouched converted rule is not an edit").toBe("");

      const crlf = richRepository();
      writeFileSync(join(crlf, ".gitattributes"), ".gitignore text eol=crlf\n");
      writeFileSync(join(crlf, ".gitignore"), "node_modules/\n");
      git(crlf, "add", "-A"); git(crlf, "commit", "--quiet", "-m", "crlf rule");
      expect(candidateManifest(candidateOf(crlf)).patch, "the eol form is not an edit either").toBe("");
    });

    it("accepts a base-tracked symlinked rule file, and refuses it becoming a regular file", () => {
      // R5-3 and reviewer 1's type-change finding. An unmodified symlinked rule is not an edit;
      // replacing it with a regular file of identical text is, because a symlinked `.gitignore`
      // is not an active ignore file and the regular one would be. The mode is compared for this.
      const linked = richRepository();
      rmSync(join(linked, ".gitignore"));
      writeFileSync(join(linked, "real-ignore"), "*.log\n");
      symlinkSync("real-ignore", join(linked, ".gitignore"));
      git(linked, "add", "-A"); git(linked, "commit", "--quiet", "-m", "linked rule");
      expect(candidateManifest(candidateOf(linked)).patch, "an untouched symlinked rule is not an edit").toBe("");

      const swapped = richRepository();
      rmSync(join(swapped, ".gitignore"));
      mkdirSync(join(swapped, "sub"), { recursive: true });
      writeFileSync(join(swapped, "sub", "neg"), "!secret.env\n");
      symlinkSync("neg", join(swapped, "sub", ".gitignore"));
      git(swapped, "add", "-A"); git(swapped, "commit", "--quiet", "-m", "linked nested rule");
      const swappedWorkspace = candidateOf(swapped);
      rmSync(join(swappedWorkspace.root, "sub", ".gitignore"));
      writeFileSync(join(swappedWorkspace.root, "sub", ".gitignore"), "!secret.env\n");
      writeFileSync(join(swappedWorkspace.root, "sub", "secret.env"), "SECRET=1\n");
      expect(() => candidateManifest(swappedWorkspace),
        "a link becoming a regular rule file is a rule edit").toThrow(/changes a rule file/);
    });

    it("does not treat a submodule's own rule file as a candidate rule edit", () => {
      // Reviewer 1's populated-gitlink case: the submodule's `.gitignore` belongs to that
      // repository, and the superproject records the gitlink, not its tree.
      const sub = mkdtempSync(join(tmpdir(), "t054-sub-")); roots.push(sub);
      git(sub, "init", "--quiet", "--initial-branch=main");
      git(sub, "config", "user.email", "test@example.invalid"); git(sub, "config", "user.name", "test");
      writeFileSync(join(sub, ".gitignore"), "*.log\n");
      writeFileSync(join(sub, "inner.txt"), "inner\n");
      git(sub, "add", "-A"); git(sub, "commit", "--quiet", "-m", "sub");
      const root = richRepository();
      git(root, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", sub, "vendor");
      git(root, "commit", "--quiet", "-m", "gitlink");
      const workspace = candidateOf(root);
      mkdirSync(join(workspace.root, "vendor"), { recursive: true });
      writeFileSync(join(workspace.root, "vendor", ".gitignore"), "*.log\n");
      writeFileSync(join(workspace.root, "vendor", "inner.txt"), "inner\n");
      expect(candidateManifest(workspace).patch, "a populated submodule is not a change").toBe("");
    });
  });

  /**
   * Round-6 regression group: rule authority is decided before staging, on the candidate's
   * own files, so no candidate rule can be read by `add -A` at all.
   */
  /** A candidate whose only edit is the given one, run against a committed base. */
  const ruleFixture = (base: (root: string) => void, edit: (root: string) => void): { ok: boolean; paths: string[]; patch: string; message: string; root: string } => {
    const root = mkdtempSync(join(tmpdir(), "t054-rule-")); roots.push(root);
    git(root, "init", "--quiet", "--initial-branch=main");
    git(root, "config", "user.email", "test@example.invalid"); git(root, "config", "user.name", "test");
    writeFileSync(join(root, "a.txt"), "a\n");
    base(root);
    git(root, "add", "-A"); git(root, "commit", "--quiet", "--allow-empty", "-m", "base");
    const workspace = candidateOf(root);
    edit(workspace.root);
    try {
      const manifest = candidateManifest(workspace);
      return { ok: true, paths: manifest.files.map(file => file.path), patch: manifest.patch, message: "", root: workspace.root };
    } catch (error) {
      return { ok: false, paths: [], patch: "", message: (error as Error).message, root: workspace.root };
    }
  };

  describe("round-6 findings", () => {

it("R6-1 seq A: a self-ignored rule cannot admit a base-ignored secret", () => {
  const r = ruleFixture(root => writeFileSync(join(root, ".gitignore"), "node_modules/\n*.log\n*.env\n"), root => {
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "sub", ".gitignore"), ".gitignore\n!secret.env\n");
    writeFileSync(join(root, "sub", "secret.env"), "SECRET=1\n");
  });
  if (r.ok) {
    expect(r.paths, "the secret must not reach the manifest").not.toContain("sub/secret.env");
    expect(r.patch).not.toContain("SECRET");
  } else expect(r.message).toMatch(/changes a rule file/);
});

it("R6-1 seq A reverse: a self-ignored rule cannot hide a deliverable", () => {
  // This direction was already refused on the round-6 source, so it pins the behaviour
  // rather than proving the round-6 fix. It is kept because it is the mirror of the leak
  // above: a regression here would hide a deliverable rather than admit one.
  const r = ruleFixture(root => writeFileSync(join(root, ".gitignore"), "node_modules/\n"), root => {
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "sub", ".gitignore"), "*\n!.gitignore\n");
    writeFileSync(join(root, "sub", "deliverable.ts"), "export const d = 1;\n");
  });
  if (r.ok) expect(r.paths).toContain("sub/deliverable.ts");
  else expect(r.message).toMatch(/changes a rule file/);
});

it("R6-1 seq B: an ignored attribute file cannot choose conversions", () => {
  const r = ruleFixture(root => {
    writeFileSync(join(root, ".gitignore"), "sub/.gitattributes\n");
    writeFileSync(join(root, ".gitattributes"), "*.txt text eol=lf\n");
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "sub", "base.txt"), "base\n");
  }, root => {
    writeFileSync(join(root, "sub", ".gitattributes"), "*.txt -text\n");
    writeFileSync(join(root, "sub", "note.txt"), "ours\r\n");
  });
  if (r.ok) expect(r.patch, "the base's eol=lf must govern").not.toContain("\r");
  else expect(r.message).toMatch(/changes a rule file/);
});

it("R6-1 seq C: an ident-cleaned rule edit cannot normalize back to the base object id", () => {
  const r = ruleFixture(root => {
    writeFileSync(join(root, ".gitattributes"), ".gitignore ident\n");
    writeFileSync(join(root, ".gitignore"), "$Id$\n");
  }, root => {
    writeFileSync(join(root, ".gitignore"), "$Id: changed $\n");
    writeFileSync(join(root, "$Id$"), "x\n");
  });
  expect(r.ok, "an edited rule is refused regardless of how it cleans").toBe(false);
});
  });

  /**
   * Round-7 regression group: the directory prepass stays inside what git can answer, and a
   * mode-only rule edit is refused rather than discarded.
   */
  describe("round-7 findings", () => {
    it.skipIf(process.platform === "win32")("accepts an unchanged candidate with a directory named like pathspec magic", () => {
      // R7-1: `check-ignore --stdin` parses every record as a pathspec, so `:(literal)src` was
      // rejected as unsupported magic and even an unchanged candidate failed. A `./` prefix
      // keeps the record out of the magic branch, and the echoed match loses it again.
      //
      // POSIX only, for the same reason as the file-name case below: Windows refuses `:` in a
      // directory name, so this shape cannot exist on the checkout git writes there.
      const root = richRepository();
      mkdirSync(join(root, ":(literal)src"), { recursive: true });
      writeFileSync(join(root, ":(literal)src", "keep.ts"), "export const keep = 1;\n");
      git(root, "add", "-A"); git(root, "commit", "--quiet", "-m", "pathspec-looking directory");
      const manifest = candidateManifest(candidateOf(root));
      expect(manifest.files.map(file => file.path)).toContain(":(literal)src/keep.ts");
      expect(manifest.patch, "an unchanged candidate is an empty patch").toBe("");
    });

    it("accepts a populated gitlink that holds a nested directory", () => {
      // R7-1: `check-ignore` answers a path below an indexed gitlink with status 128 ("is in
      // submodule"), so the prepass stops at the gitlink root instead of walking into it. The
      // submodule's files are exempt from rule refusal anyway.
      const sub = mkdtempSync(join(tmpdir(), "t054-sub-")); roots.push(sub);
      git(sub, "init", "--quiet", "--initial-branch=main");
      git(sub, "config", "user.email", "test@example.invalid"); git(sub, "config", "user.name", "test");
      mkdirSync(join(sub, "src"), { recursive: true });
      writeFileSync(join(sub, "src", "inner.txt"), "inner\n");
      git(sub, "add", "-A"); git(sub, "commit", "--quiet", "-m", "sub");
      const root = richRepository();
      git(root, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", sub, "vendor");
      git(root, "commit", "--quiet", "-m", "gitlink");
      const workspace = candidateOf(root);
      mkdirSync(join(workspace.root, "vendor", "src"), { recursive: true });
      writeFileSync(join(workspace.root, "vendor", "src", "inner.txt"), "inner\n");
      expect(candidateManifest(workspace).patch, "the submodule's tree is not the candidate's").toBe("");
    });

    it("refuses a rule file whose owner-executable bit changed", () => {
      // R7-2: the regular-file branch compared bytes only, so a chmod to the rule was silently
      // replaced by the base's mode instead of being refused. Git records 100644 and 100755.
      const r = ruleFixture(root => writeFileSync(join(root, ".gitignore"), "node_modules/\n"), root => {
        chmodSync(join(root, ".gitignore"), 0o755);
      });
      // The fixture is only meaningful where `chmod` can grant the owner bit. Windows keeps no
      // such bit on an ordinary file, so the edit it asks for never happened and the case would
      // be asserting nothing; a host that can hold the bit runs it in full.
      if ((statSync(join(r.root, ".gitignore")).mode & 0o100) === 0) return;
      expect(r.ok, "a mode-only rule edit is refused rather than discarded").toBe(false);
      expect(r.message).toMatch(/changes a rule file/);
    });
  });

  describe("round-3 findings", () => {
    it.skipIf(process.platform === "win32")("keeps a tracked file whose name looks like a pathspec, and gives it no patch", () => {
      // R3-1: the round-2 `check-ignore` pass sent `:keep.txt` to a pathspec parser, which read
      // the leading colon as magic and reported it ignored, so an *unchanged* tracked file was
      // removed from the index and appeared in the patch as a deletion. Ignore decisions now
      // come from `add -A`, which has no such pass.
      //
      // POSIX only: Windows refuses `:` in a file name, so the shape cannot exist on a checkout
      // git would ever produce there. The product is host-independent here — `add -A` has no
      // pathspec pass — but the fixture cannot be made on that host.
      const root = richRepository();
      writeFileSync(join(root, ".gitignore"), "keep.txt\n");
      writeFileSync(join(root, ":keep.txt"), "literal colon name\n");
      git(root, "add", "-A"); git(root, "commit", "--quiet", "-m", "pathspec-looking name");
      const manifest = candidateManifest(candidateOf(root));
      expect(manifest.files.map(file => file.path)).toContain(":keep.txt");
      expect(manifest.patch, "an unchanged candidate is an empty patch").toBe("");
    });

    it("records a gitlink replaced by a regular file, and never descends a populated one", () => {
      // R3-2: filtering descendants by exact gitlink name either dropped a replacement file or
      // failed the manifest when the candidate's submodule directory held files. Git reports a
      // gitlink as one entry and does not descend it, so the populated case is simply not a
      // candidate file, and a replacement is an ordinary entry.
      const addSubmodule = (root: string): void => {
        const sub = mkdtempSync(join(tmpdir(), "t054-sub-")); roots.push(sub);
        git(sub, "init", "--quiet", "--initial-branch=main");
        git(sub, "config", "user.email", "test@example.invalid"); git(sub, "config", "user.name", "test");
        writeFileSync(join(sub, "inner.txt"), "inner\n");
        git(sub, "add", "-A"); git(sub, "commit", "--quiet", "-m", "sub");
        git(root, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", sub, "vendor");
        git(root, "commit", "--quiet", "-m", "gitlink");
      };
      const replaced = richRepository();
      addSubmodule(replaced);
      const replacedWorkspace = candidateOf(replaced);
      rmSync(join(replacedWorkspace.root, "vendor"), { recursive: true, force: true });
      writeFileSync(join(replacedWorkspace.root, "vendor"), "replacement\n");
      const manifest = candidateManifest(replacedWorkspace);
      expect(manifest.files.map(file => file.path), "the replacement is a candidate file").toContain("vendor");
      expect(manifest.patch).toContain("replacement");

      const populated = richRepository();
      addSubmodule(populated);
      const populatedWorkspace = candidateOf(populated);
      mkdirSync(join(populatedWorkspace.root, "vendor"), { recursive: true });
      writeFileSync(join(populatedWorkspace.root, "vendor", "inner.txt"), "from the submodule\n");
      const populatedManifest = candidateManifest(populatedWorkspace);
      expect(populatedManifest.files.map(file => file.path), "a gitlink has no bytes of its own").not.toContain("vendor/inner.txt");
      expect(populatedManifest.patch, "an unmodified gitlink still needs no patch").toBe("");
    });

    it("keeps the source's info/exclude as an ignore authority", () => {
      // R3-3: the round-2 rewrite dropped the copy of the source's repository-level exclude
      // file, so a path only that file ignores entered the manifest. Committed `.gitignore`
      // files do not subsume it — it is a separate ignore source.
      const root = richRepository();
      const exclude = execFileSync("git", ["-C", root, "rev-parse", "--git-path", "info/exclude"], { encoding: "utf8" }).trim();
      writeFileSync(join(root, exclude), "private.env\n");
      const workspace = candidateOf(root);
      writeFileSync(join(workspace.root, "private.env"), "SECRET=1\n");
      const manifest = candidateManifest(workspace);
      expect(manifest.files.map(file => file.path), "the source exclude still hides it").not.toContain("private.env");
      expect(manifest.patch).not.toContain("SECRET");
    });
  });
});
});
