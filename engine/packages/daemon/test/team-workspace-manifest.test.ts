import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidateManifest, verifySourceUnchanged } from "../src/domain/team-workspace.js";
import { symlinkRefusal } from "./helpers/symlink.js";
import {
  canary, candidateOf, candidateRoot, git, gitWithByteExactConfig, plantedOutside, plant, richRepository,
  roots, outsideRoots, takeOverRepositoryMetadata, patchSection, GOLDEN_DIGEST, GOLDEN_FILES,
} from "./helpers/t044-fixture.js";

afterEach(() => {
  for (const root of [...roots.splice(0), ...outsideRoots.splice(0)]) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(symlinkRefusal !== null)("T044 commit-lane manifest without a git in the candidate", () => {

it("runs no program the worker planted through core.fsmonitor (round 1 vector)", () => {
  const root = richRepository();
  const workspace = candidateOf(root);
  const mark = canary();
  takeOverRepositoryMetadata(workspace, configure => {
    configure("config", "core.fsmonitor", plant(workspace.root, "planted.sh", "exit 0", mark.path));
  });
  writeFileSync(join(workspace.root, "src", "deliverable.ts"), "export const deliverable = true;\n");
  const manifest = candidateManifest(workspace);
  expect(manifest.files.map(file => file.path)).toContain("src/deliverable.ts");
  expect(mark.seen(), "a worker-planted core.fsmonitor program ran as the control").toBe(false);
});

it("runs no program the worker planted through diff.external (round 2 vector)", () => {
  const root = richRepository();
  const workspace = candidateOf(root);
  const mark = canary();
  takeOverRepositoryMetadata(workspace, configure => {
    configure("config", "diff.external", plant(workspace.root, "planted.sh", "cat", mark.path));
  });
  writeFileSync(join(workspace.root, "src", "deliverable.ts"), "export const deliverable = true;\n");
  candidateManifest(workspace);
  expect(mark.seen(), "a worker-planted diff.external program ran as the control").toBe(false);
});

it("runs no worker-planted program through filter.<drv>.clean, and refuses the attributes it needs", () => {
  // A filter driver only runs if attributes select it, and attributes are a rule file, which
  // this lane gives to the base commit alone. The candidate cannot ask for a driver at all.
  const root = richRepository();
  const workspace = candidateOf(root);
  const mark = canary();
  takeOverRepositoryMetadata(workspace, configure => {
    configure("config", "filter.evil.clean", plantedOutside(workspace.root, "printf 'SAFE CONTENT\\n'", mark.path));
  });
  writeFileSync(join(workspace.root, ".gitattributes"), "* filter=evil\n");
  writeFileSync(join(workspace.root, "src", "deliverable.ts"), "export const MALICIOUS = true;\n");
  expect(() => candidateManifest(workspace)).toThrow(/changes a rule file/);
  expect(mark.seen(), "a worker-planted filter.<drv>.clean program ran as the control").toBe(false);
});

it("T051: the base commit's attributes are the only ones in force, and no source driver runs", () => {
  // The candidate cannot supply attributes, so the only attributes in force are the base's. A
  // filter driver the base itself names still must not run: the store configures no driver.
  const root = richRepository();
  const mark = canary();
  writeFileSync(join(root, ".gitattributes"), "*.txt text eol=lf\nsrc/deliverable.ts filter=evil\n");
  git(root, "add", "-A"); git(root, "commit", "--quiet", "-m", "attributes");
  const driver = plantedOutside(root, "printf 'REWRITTEN\\n'", mark.path);
  git(root, "config", "filter.evil.clean", driver);
  git(root, "config", "filter.evil.required", "true");
  const workspace = candidateOf(root);
  writeFileSync(join(workspace.root, "src", "deliverable.ts"), "export const OURS = true;\n");
  writeFileSync(join(workspace.root, "note.txt"), "ours\r\n");
  const manifest = candidateManifest(workspace);

  expect(mark.seen(), "a filter driver the source configured ran as the control").toBe(false);
  const note = manifest.files.find(file => file.path === "note.txt");
  expect(note?.hash, "the manifest hashes the cleaned reading").toBe(
    `sha256:${createHash("sha256").update("ours\n").digest("hex")}`);
  const section = patchSection(manifest.patch, "src/deliverable.ts");
  expect(section).toContain("export const OURS = true;");
  expect(manifest.patch).not.toContain("REWRITTEN");
  expect(manifest.patch).not.toContain(workspace.root);
});

it("refuses a candidate that rewrites or deletes .gitignore, so base ignore authority cannot move", () => {
  // A rewritten rule could hide a deliverable or admit what the base ignores, and a deleted one
  // admits everything the base excluded. Both are refused, so neither direction is expressible.
  const rewriting = richRepository();
  const rewritingWorkspace = candidateOf(rewriting);
  writeFileSync(join(rewritingWorkspace.root, ".env"), "DATABASE_URL=postgres://user:pw@host/db\n");
  writeFileSync(join(rewritingWorkspace.root, ".gitignore"), "*\n");
  expect(() => candidateManifest(rewritingWorkspace)).toThrow(/changes a rule file/);

  const deleting = richRepository();
  const deletingWorkspace = candidateOf(deleting);
  rmSync(join(deletingWorkspace.root, ".gitignore"));
  expect(() => candidateManifest(deletingWorkspace)).toThrow(/changes a rule file/);
});

it("records a symlink out of the candidate as its own text rather than smuggling ignored bytes", () => {
  const root = richRepository();
  const workspace = candidateOf(root);
  // A link whose target the base commit ignores. Following it would put the target's bytes
  // into the manifest, the digest, the patch and the reviewer packet, where an innocuously
  // named `innocent.md` would read as a candidate deliverable. The link's own text does none
  // of that.
  writeFileSync(join(workspace.root, ".env"), "DATABASE_URL=postgres://user:pw@host/db\n");
  symlinkSync("../.env", join(workspace.root, "src", "innocent.md"));
  const manifest = candidateManifest(workspace);
  expect(manifest.files.find(file => file.path === "src/innocent.md")?.hash).toBe(
    `sha256:${createHash("sha256").update("../.env").digest("hex")}`);
  // The ignored target is still not a candidate file, and its bytes appear nowhere.
  expect(manifest.files.map(file => file.path)).not.toContain(".env");
  expect(manifest.patch).not.toContain("DATABASE_URL");
});

it("does not follow a tracked directory the worker replaced with a link to a vault", () => {
  const root = richRepository();
  const workspace = candidateOf(root);
  // A worker turns a tracked directory into a link to a directory of secrets. Its children
  // still have tracked paths, so a reader that followed the link would put the vault's bytes
  // in the manifest. The link is a leaf: the children are gone, and the patch says so.
  writeFileSync(join(workspace.root, ".env"), "DATABASE_URL=postgres://user:pw@host/db\n");
  mkdirSync(join(workspace.root, "vault"), { recursive: true });
  writeFileSync(join(workspace.root, "vault", "leaf.ts"), "export const secret = 1;\n");
  rmSync(join(workspace.root, "src", "nested"), { recursive: true, force: true });
  symlinkSync("../vault", join(workspace.root, "src", "nested"));
  const manifest = candidateManifest(workspace);
  expect(manifest.files.find(file => file.path === "src/nested")?.hash).toBe(
    `sha256:${createHash("sha256").update("../vault").digest("hex")}`);
  expect(manifest.files.map(file => file.path)).not.toContain("src/nested/deep/leaf.ts");
});

it("ignores ambient GIT_ redirection that would point git at the candidate", () => {
  const root = richRepository();
  const workspace = candidateOf(root);
  const mark = canary();
  takeOverRepositoryMetadata(workspace, configure => {
    configure("config", "core.fsmonitor", plant(workspace.root, "planted.sh", "exit 0", mark.path));
  });
  writeFileSync(join(workspace.root, "src", "deliverable.ts"), "export const deliverable = true;\n");
  // A worker cannot set the daemon's environment, but a misconfigured host can. The
  // lane must drop these rather than inherit whatever points them at the candidate.
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries({
    GIT_DIR: join(workspace.root, ".git"),
    GIT_WORK_TREE: workspace.root,
    GIT_CONFIG_GLOBAL: join(workspace.root, ".git", "config"),
    GIT_CEILING_DIRECTORIES: workspace.root,
  })) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    const manifest = candidateManifest(workspace);
    expect(manifest.files.map(file => file.path)).toContain("src/deliverable.ts");
    expect(mark.seen(), "ambient GIT_ redirection made git run the candidate's program").toBe(false);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

it("records a tracked symlink as its link text, which is what the patch writes", () => {
  // T054: git records a link as a link, so the manifest hashes the link's own text — the
  // bytes the patch carries — and not the target's contents. That reading is what makes
  // the manifest and the patch one description of the candidate.
  const root = richRepository();
  const workspace = candidateOf(root);
  const manifest = candidateManifest(workspace);
  const link = manifest.files.find(file => file.path === "src/link.md");
  expect(link, "a tracked symlink is part of the candidate").toBeDefined();
  expect(link?.tracked).toBe(true);
  expect(link?.hash).toBe(`sha256:${createHash("sha256").update("../docs/target.md").digest("hex")}`);
  expect(readFileSync(join(workspace.root, "src", "link.md"), "utf8")).toBe("the symlink target\n");
});

it("records a chain of tracked symlinks as their own link texts, and leaves the patch empty", () => {
  // A link is stored as its own text, so `l2 -> l1` is described by the text `l1` and not
  // by whatever `l1` eventually names. An untouched candidate still needs no patch.
  const root = richRepository();
  symlinkSync("link.md", join(root, "src", "link2.md"));
  git(root, "add", "-A"); git(root, "commit", "--quiet", "-m", "chain");
  const workspace = candidateOf(root);
  const manifest = candidateManifest(workspace);
  for (const path of ["src/link.md", "src/link2.md"]) {
    const link = manifest.files.find(file => file.path === path);
    expect(link, `${path} is part of the candidate`).toBeDefined();
    expect(link?.tracked).toBe(true);
  }
  expect(manifest.files.find(file => file.path === "src/link2.md")?.hash).toBe(
    `sha256:${createHash("sha256").update("link.md").digest("hex")}`);
  expect(manifest.patch, "an unmodified candidate needs no patch").toBe("");
});

// The shapes a POSIX candidate can hold and Windows cannot: a symlink to a POSIX-only path, a
// FIFO, and a file name holding a newline or a colon. Each case states the shape itself, so it
// runs where the shape can exist. The product behaviour it pins is host-independent — a link is
// recorded as its own text and never followed, an unreadable entry refuses the manifest, and a
// hostile name is quoted — and the Windows-specific boundaries are covered by
// `team-workspace-windows.test.ts`.
const posixShapesOnly = process.platform === "win32";

it.skipIf(posixShapesOnly)("records an escaping, dangling or directory symlink as its own text and reads nothing through it", () => {
  // T054 replaced refusal with a positive guarantee: the copy carries a link's text and
  // never follows one. A link out of the tree therefore leaks nothing — the vault's bytes
  // are not read, hashed, patched or copied — which is strictly stronger than refusing the
  // whole manifest over a link that is, after all, part of the candidate.
  const escaping = richRepository();
  const workspaceA = candidateOf(escaping);
  symlinkSync("/etc/hostname", join(workspaceA.root, "src", "esc.md"));
  const a = candidateManifest(workspaceA);
  expect(a.files.find(file => file.path === "src/esc.md")?.hash).toBe(
    `sha256:${createHash("sha256").update("/etc/hostname").digest("hex")}`);
  expect(a.patch).not.toContain(readFileSync("/etc/hostname").subarray(0, 20).toString("utf8").trim() || "root:");

  const dangling = richRepository();
  const workspaceB = candidateOf(dangling);
  symlinkSync("nowhere-at-all.md", join(workspaceB.root, "src", "gone.md"));
  const b = candidateManifest(workspaceB);
  expect(b.files.find(file => file.path === "src/gone.md")?.hash).toBe(
    `sha256:${createHash("sha256").update("nowhere-at-all.md").digest("hex")}`);

  const toDirectory = richRepository();
  const workspaceC = candidateOf(toDirectory);
  symlinkSync("nested", join(workspaceC.root, "src", "dirlink"));
  const c = candidateManifest(workspaceC);
  // The link is an entry; the directory it names contributes no entry of its own.
  expect(c.files.find(file => file.path === "src/dirlink")?.hash).toBe(
    `sha256:${createHash("sha256").update("nested").digest("hex")}`);
  expect(c.files.map(file => file.path)).toContain("src/nested/deep/leaf.ts");
});

it.skipIf(posixShapesOnly)("records a tracked file the worker replaced with an escaping link as that link, not as a deletion", () => {
  // The patch presents the link itself, which is what the candidate now holds: the worker
  // chose to replace the file, and the manifest says so instead of hiding the change.
  const root = richRepository();
  const workspace = candidateOf(root);
  rmSync(join(workspace.root, "src", "base.ts"));
  symlinkSync("/etc/hostname", join(workspace.root, "src", "base.ts"));
  const manifest = candidateManifest(workspace);
  expect(manifest.files.find(file => file.path === "src/base.ts")?.hash).toBe(
    `sha256:${createHash("sha256").update("/etc/hostname").digest("hex")}`);
  // Git presents a file becoming a link as the deletion of the file plus the addition of
  // the link. What matters is that the link's text is what the addition carries.
  expect(manifest.patch).toContain("/etc/hostname");
  expect(manifest.patch).not.toContain(readFileSync("/etc/hostname", "utf8").trim());
});

it.skipIf(posixShapesOnly)("refuses a tracked path the worker replaced with a FIFO instead of blocking the control", () => {
  const root = richRepository();
  const workspace = candidateOf(root);
  const fifo = join(workspace.root, "src", "base.ts");
  rmSync(fifo);
  execFileSync("mkfifo", [fifo]);
  // A read would never return, so the manifest must refuse rather than open it.
  expect(() => candidateManifest(workspace)).toThrow(/not a regular file/);
});

it("records a group-only executable bit as unchanged, because git tracks only the owner bit", () => {
  const root = richRepository();
  const workspace = candidateOf(root);
  // 0644 -> 0654 moves only the group execute bit, which git does not record.
  chmodSync(join(workspace.root, "src", "base.ts"), 0o654);
  const manifest = candidateManifest(workspace);
  expect(manifest.patch).not.toContain("mode 100755");
  expect(manifest.patch).toBe("");
});

it("renders a non-UTF-8 file as a binary hunk so the patch does not corrupt its bytes", () => {
  const root = richRepository();
  const workspace = candidateOf(root);
  // Latin-1 `café`: invalid UTF-8 but no NUL, so git would otherwise emit a text diff
  // and the consumer would decode the byte 0xe9 to U+FFFD.
  writeFileSync(join(workspace.root, "src", "latin.ts"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  const manifest = candidateManifest(workspace);
  const section = patchSection(manifest.patch, "src/latin.ts");
  expect(section).toContain("GIT binary patch");
  expect(section).not.toContain("+caf�");
});

it.skipIf(posixShapesOnly)("quotes a file name that would otherwise be read as a fast-import command", () => {
  const root = richRepository();
  const workspace = candidateOf(root);
  // Unquoted, this name adds a `forged.txt` entry to the patch that the manifest never
  // hashed — evidence the worker can forge outright.
  const hostile = "x\ndata 0\n\nM 100644 inline forged.txt";
  writeFileSync(join(workspace.root, hostile), "FORGED\n");
  const manifest = candidateManifest(workspace);
  expect(manifest.files.map(file => file.path)).toContain(hostile);
  expect(manifest.files.map(file => file.path)).not.toContain("forged.txt");
  // The injected name would have produced a `forged.txt` hunk; quoting keeps it one
  // literal path, so the patch carries no such section and no second entry.
  expect(patchSection(manifest.patch, "forged.txt")).toBe("");
  expect(manifest.patch.match(/^diff --git /gm)?.length, "one file is one hunk").toBe(1);
});

it("does not let the control's own XDG excludes file hide a deliverable", () => {
  const root = richRepository();
  const workspace = candidateOf(root);
  writeFileSync(join(workspace.root, "src", "xsecret.ts"), "export const xsecret = 1;\n");
  const home = mkdtempSync(join(tmpdir(), "t044-xdg-")); outsideRoots.push(home);
  mkdirSync(join(home, ".config", "git"), { recursive: true });
  writeFileSync(join(home, ".config", "git", "ignore"), "xsecret.ts\n");
  const savedXdg = process.env.XDG_CONFIG_HOME, savedHome = process.env.HOME;
  process.env.XDG_CONFIG_HOME = join(home, ".config"); process.env.HOME = home;
  try {
    const manifest = candidateManifest(workspace);
    expect(manifest.files.map(file => file.path), "a host-level ignore rule must not hide a deliverable")
      .toContain("src/xsecret.ts");
  } finally {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedXdg;
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  }
});

it("writes a symlink into the patch as a link, so applying it yields a link and not a file", () => {
  // The manifest hashes a link through its target, but the patch must carry the link's
  // own text: a patch that wrote the target's bytes would turn every link into a file.
  const root = richRepository();
  symlinkSync("link.md", join(root, "src", "link2.md"));
  git(root, "add", "-A"); git(root, "commit", "--quiet", "-m", "chain");
  const workspace = candidateOf(root);
  writeFileSync(join(workspace.root, "docs", "target.md"), "the symlink target, edited\n");
  rmSync(join(workspace.root, "src", "link2.md"));
  symlinkSync("../docs/target.md", join(workspace.root, "src", "link2.md"));
  const manifest = candidateManifest(workspace);
  expect(patchSection(manifest.patch, "src/link2.md")).toContain("120000");

  const checkout = candidateRoot(root);
  git(tmpdir(), "clone", "--quiet", root, checkout);
  // `git clone` does not copy `core.autocrlf`; the clone reads the global config, so the checkout
  // that applies the patch pins the value the bytes were written with.
  git(checkout, "-c", "core.autocrlf=false", "checkout", "--quiet", (workspace.base as { commit: string }).commit);
  const patchFile = join(checkout, "..", `${Date.now()}-link.patch`);
  writeFileSync(patchFile, manifest.patch);
  execFileSync("git", ["-C", checkout, ...gitWithByteExactConfig, "apply", "--binary", patchFile], { stdio: ["ignore", "pipe", "pipe"] });
  expect(lstatSync(join(checkout, "src", "link2.md")).isSymbolicLink(), "an applied link is still a link").toBe(true);
  // The host answers `readlink` in its own separator; the patch wrote git's, which is the form
  // this asserts.
  expect(readlinkSync(join(checkout, "src", "link2.md")).replaceAll("\\", "/")).toBe("../docs/target.md");
});

it("does not let the source index contaminate an unmodified candidate's patch (round 1 finding)", () => {
  const root = richRepository();
  const workspace = candidateOf(root);
  const before = candidateManifest(workspace).patch;
  // An owner `git rm --cached` moves the SOURCE index without touching any bytes.
  git(root, "rm", "--cached", "--quiet", "src/base.ts");
  const after = candidateManifest(workspace);
  expect(after.patch, "the source index must not add a deletion to an unmodified candidate").toBe(before);
  expect(after.patch).not.toContain("deleted file mode");
  expect(after.files.map(file => file.path)).toContain("src/base.ts");
});

it("keeps the manifest and the patch for an unmodified candidate byte-identical to the base commit", () => {
  const root = richRepository();
  const workspace = candidateOf(root);
  const manifest = candidateManifest(workspace);
  // Captured from the base commit 23284b8 before this task changed the source. The
  // digest covers every tracked byte; a changed manifest invalidates every recorded
  // identity, which is this card's own stop-if condition.
  expect(manifest.files.map(file => [file.path, file.hash, file.tracked])).toEqual(GOLDEN_FILES);
  expect(manifest.manifestDigest).toBe(GOLDEN_DIGEST);
  expect(manifest.patch).toBe("");
});

it("describes the same bytes and renders the same patch for an edited, added and deleted candidate", () => {
  const root = richRepository();
  const workspace = candidateOf(root);
  writeFileSync(join(workspace.root, "src", "base.ts"), "export const base = 2;\n");
  writeFileSync(join(workspace.root, "src", "fresh.ts"), "export const fresh = true;\n");
  rmSync(join(workspace.root, "src", "nested", "deep", "leaf.ts"));
  const manifest = candidateManifest(workspace);
  expect(manifest.files.map(file => file.path)).not.toContain("src/nested/deep/leaf.ts");
  expect(manifest.files.map(file => [file.path, file.tracked])).toContainEqual(["src/base.ts", true]);
  expect(manifest.files.map(file => [file.path, file.tracked])).toContainEqual(["src/fresh.ts", false]);
  expect(manifest.patch).toContain("+export const base = 2;");
  expect(manifest.patch).toContain("+export const fresh = true;");
  expect(manifest.patch).toContain("deleted file mode");
  // Standard binary patch with repository-relative paths: it must apply at a repo root.
  expect(manifest.patch).toContain("a/src/base.ts");
  expect(manifest.patch).not.toContain(workspace.root);
});

it("records a mode change in the patch without treating it as a content change", () => {
  const root = richRepository();
  const workspace = candidateOf(root);
  chmodSync(join(workspace.root, "src", "base.ts"), 0o755);
  const manifest = candidateManifest(workspace);
  expect(manifest.files.map(file => file.path)).toContain("src/base.ts");
  // Windows keeps no owner-executable bit on an ordinary file, so the edit this case asks for
  // never happened there and there is no mode change to record. The host that can hold the bit
  // runs the whole assertion.
  if ((statSync(join(workspace.root, "src", "base.ts")).mode & 0o100) === 0) return;
  expect(manifest.patch).toContain("old mode 100644");
  expect(manifest.patch).toContain("new mode 100755");
});
});
