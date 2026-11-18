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
});
