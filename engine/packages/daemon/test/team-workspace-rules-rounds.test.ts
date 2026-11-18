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
