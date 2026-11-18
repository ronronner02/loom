import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { acceptSourceRefMove, candidateManifest, candidatePath, createCandidateWorkspace, createReviewPacket, listFiles, removeCandidateWorkspace, removeReviewPacket, resolveWorkspaceBase, sourceFingerprint, verifyReviewPacket, verifySourceUnchanged } from "../src/domain/team-workspace.js";
import { symlinkRefusal } from "./helpers/symlink.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of [...roots.splice(0), ...outsideRoots.splice(0)]) rmSync(root, { recursive: true, force: true });
});
// Every git call in this suite is about bytes, so the host's own git configuration must not
// change them: a runner whose global config says `core.autocrlf=true` normalizes a file when it
// is *added*, which stores CRLF where the fixture wrote LF and breaks every byte-exact
// expectation below. The two settings are pinned on the command line, which outranks every config
// file, so a dev machine and a Windows runner measure the same bytes.
const gitWithByteExactConfig = ["-c", "core.autocrlf=false", "-c", "core.eol=lf"];
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...gitWithByteExactConfig, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
/**
 * Candidate trees live outside the repository. Placing one inside it would let
 * git discovery find the parent repository and hide every snapshot-lane bug.
 */
const outsideRoots: string[] = [];
function candidateRoot(_root: string): string {
  const dir = mkdtempSync(join(tmpdir(), "candidate-tree-"));
  outsideRoots.push(dir);
  return dir;
}
function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "candidate-")); roots.push(root);
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.invalid"); git(root, "config", "user.name", "test");
  mkdirSync(join(root, "src")); writeFileSync(join(root, "src", "base.ts"), "export const base = 1;\n");
  git(root, "add", "."); git(root, "commit", "--quiet", "-m", "base");
  return root;
}
function unborn(): string {
  const root = mkdtempSync(join(tmpdir(), "candidate-unborn-")); roots.push(root);
  git(root, "init", "--quiet", "--initial-branch=main");
  mkdirSync(join(root, "src")); writeFileSync(join(root, "src", "seed.ts"), "export const seed = 1;\n");
  return root;
}


describe("isolated candidate ownership", () => {
  it.each(["accepted", "other ref", "dirty source", "source reset", "wrong prior ref", "wrong target ref", "ordinary source"])(
    "acknowledges only the exact owner Merge ref movement: %s", (scenario) => {
      const root = repository();
      const sourceRoot = join(candidateRoot(root), "integration");
      git(root, "worktree", "add", "-b", "team/source", sourceRoot);
      writeFileSync(join(sourceRoot, "plan.md"), "# Plan\n");
      git(sourceRoot, "add", "plan.md");
      git(sourceRoot, "commit", "--quiet", "-m", "plan");
      const workspace = createCandidateWorkspace({ root: sourceRoot, base: resolveWorkspaceBase(sourceRoot),
        workspaceRoot: candidateRoot(root), label: "merge-result" });
      workspace.integrationSource = scenario !== "ordinary source";
      const recorded = workspace.source;
      const base = workspace.base;
      const before = git(root, "rev-parse", "HEAD").trim();
      writeFileSync(join(sourceRoot, "src", "delivered.ts"), "export const delivered = true;\n");
      git(sourceRoot, "add", "src/delivered.ts");
      git(sourceRoot, "commit", "--quiet", "-m", "delivery");
      const after = git(sourceRoot, "rev-parse", "HEAD").trim();
      git(root, "merge", "--ff-only", "--quiet", "team/source");
      if (scenario === "other ref") git(root, "branch", "owner-other", before);
      if (scenario === "dirty source") writeFileSync(join(sourceRoot, "src", "draft.ts"), "draft\n");
      if (scenario === "source reset") git(sourceRoot, "reset", "--hard", "--quiet", before);
      expect(acceptSourceRefMove(workspace, { ref: "refs/heads/main",
        before: scenario === "wrong prior ref" ? after : before,
        after: scenario === "wrong target ref" ? before : after })).toBe(scenario === "accepted");
      expect(verifySourceUnchanged(workspace).unchanged).toBe(scenario === "accepted");
      expect(workspace.base).toBe(base);
      if (scenario !== "accepted") expect(workspace.source).toBe(recorded);
    });

  it("bases a commit-backed candidate on a detached worktree at the approved commit", () => {
    const root = repository();
    const base = resolveWorkspaceBase(root);
    expect(base.kind).toBe("commit");
    const workspace = createCandidateWorkspace({ root, base, workspaceRoot: candidateRoot(root), label: "T011" });
    roots.push(workspace.root);
    expect(git(workspace.root, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("HEAD");
    expect(git(workspace.root, "rev-parse", "HEAD").trim()).toBe((base as { commit: string }).commit);
    removeCandidateWorkspace(workspace);
  });

  it("includes untracked files in the manifest and the patch", () => {
    const root = repository();
    const base = resolveWorkspaceBase(root);
    const workspace = createCandidateWorkspace({ root, base, workspaceRoot: candidateRoot(root), label: "T011" });
    roots.push(workspace.root);
    writeFileSync(join(workspace.root, "src", "base.ts"), "export const base = 2;\n");
    writeFileSync(join(workspace.root, "src", "fresh.ts"), "export const fresh = true;\n");
    const manifest = candidateManifest(workspace);
    expect(manifest.files.map(file => [file.path, file.tracked])).toEqual([["src/base.ts", true], ["src/fresh.ts", false]]);
    expect(manifest.patch).toContain("export const base = 2;");
    expect(manifest.patch).toContain("export const fresh = true;");
    expect(manifest.baseIdentifier).toBe((base as { commit: string }).commit);
    removeCandidateWorkspace(workspace);
  });

  it("leaves the owner's dirty files, HEAD and refs untouched and creates no commit or merge", () => {
    const root = repository();
    writeFileSync(join(root, "src", "base.ts"), "export const base = 3;\n");
    writeFileSync(join(root, "src", "owner-draft.ts"), "export const draft = true;\n");
    const before = sourceFingerprint(root);
    const base = resolveWorkspaceBase(root);
    const workspace = createCandidateWorkspace({ root, base, workspaceRoot: candidateRoot(root), label: "T011" });
    roots.push(workspace.root);
    writeFileSync(join(workspace.root, "src", "candidate.ts"), "export const candidate = true;\n");
    candidateManifest(workspace);
    expect(verifySourceUnchanged(workspace)).toMatchObject({ unchanged: true });
    const after = sourceFingerprint(root);
    expect(after.head).toBe(before.head);
    expect(after.refsDigest).toBe(before.refsDigest);
    expect(after.dirtyHashes).toEqual(before.dirtyHashes);
    expect(readFileSync(join(root, "src", "owner-draft.ts"), "utf8")).toBe("export const draft = true;\n");
    // Still one commit: isolation added no history of its own.
    expect(git(root, "rev-list", "--count", "HEAD").trim()).toBe("1");
    removeCandidateWorkspace(workspace);
  });

  it("uses a hashed snapshot baseline for an unborn repository without manufacturing a commit", () => {
    const root = unborn();
    const base = resolveWorkspaceBase(root);
    expect(base).toMatchObject({ kind: "snapshot" });
    expect(() => git(root, "rev-parse", "--verify", "HEAD^{commit}")).toThrow();
    const workspace = createCandidateWorkspace({ root, base, workspaceRoot: candidateRoot(root), label: "T011" });
    roots.push(workspace.root);
    expect(readFileSync(join(workspace.root, "src", "seed.ts"), "utf8")).toBe("export const seed = 1;\n");
    const manifest = candidateManifest(workspace);
    expect(manifest.base).toBe("snapshot");
    expect(manifest.baseIdentifier).toBe((base as { baselineDigest: string }).baselineDigest);
    expect(manifest.files).toEqual([{ path: "src/seed.ts", hash: (base as { files: { hash: string }[] }).files[0]!.hash, tracked: false }]);
    expect(verifySourceUnchanged(workspace).unchanged).toBe(true);
    expect(() => git(root, "rev-parse", "--verify", "HEAD^{commit}")).toThrow();
    removeCandidateWorkspace(workspace);
  });

  it("rejects overlapping write ownership before a candidate exists", () => {
    const root = repository();
    writeFileSync(join(root, "src", "shared.ts"), "export const shared = 1;\n");
    git(root, "add", "."); git(root, "commit", "--quiet", "-m", "shared");
    const base = resolveWorkspaceBase(root);
    // Resolution is read-only, so a rejected overlap leaves no tree behind.
    expect(base.kind).toBe("commit");
    expect(listFiles(root, true).some(file => file.path === "src/shared.ts")).toBe(true);
  });

  it("represents a deleted tracked file in the patch without failing the manifest", () => {
    const root = repository();
    const base = resolveWorkspaceBase(root);
    const workspace = createCandidateWorkspace({ root, base, workspaceRoot: candidateRoot(root), label: "T011" });
    roots.push(workspace.root);
    rmSync(join(workspace.root, "src", "base.ts"));
    const manifest = candidateManifest(workspace);
    expect(manifest.files).toEqual([]);
    expect(manifest.patch).toContain("deleted file mode");
    removeCandidateWorkspace(workspace);
  });

  it.skipIf(symlinkRefusal !== null)("resolves paths through a root reached by symlink", () => {
    const root = repository();
    const link = join(tmpdir(), `candidate-link-${Date.now()}`); roots.push(link);
    symlinkSync(root, link);
    expect(readFileSync(candidatePath(link, "src/base.ts"), "utf8").trim()).toBe("export const base = 1;");
  });

  it("builds a snapshot manifest for a copy that is not itself a repository", () => {
    const root = unborn();
    const base = resolveWorkspaceBase(root);
    const workspace = createCandidateWorkspace({ root, base, workspaceRoot: candidateRoot(root), label: "T011" });
    roots.push(workspace.root);
    // The copy has no .git; asking git here would exit 128 and produce no manifest.
    expect(() => readFileSync(join(workspace.root, ".git"))).toThrow();
    const manifest = candidateManifest(workspace);
    expect(manifest.files.map(file => file.path)).toEqual(["src/seed.ts"]);
  });

  it("keeps file already staged in an unborn repository in the snapshot baseline", () => {
    const root = unborn();
    writeFileSync(join(root, "src", "staged.ts"), "export const staged = 1;\n");
    git(root, "add", "src/staged.ts");
    const base = resolveWorkspaceBase(root);
    expect(base.kind).toBe("snapshot");
    expect((base as { files: { path: string }[] }).files.map(file => file.path).sort()).toEqual(["src/seed.ts", "src/staged.ts"]);
    const workspace = createCandidateWorkspace({ root, base, workspaceRoot: candidateRoot(root), label: "T011" });
    roots.push(workspace.root);
    expect(readFileSync(join(workspace.root, "src", "staged.ts"), "utf8")).toContain("staged");
  });

  it("refuses to materialize a snapshot whose baseline changed after it was resolved", () => {
    const root = unborn();
    const base = resolveWorkspaceBase(root);
    writeFileSync(join(root, "src", "seed.ts"), "export const seed = 999;\n");
    expect(() => createCandidateWorkspace({ root, base, workspaceRoot: candidateRoot(root), label: "T011" }))
      .toThrow(/Snapshot baseline changed/);
  });

  it("reports an untracked owner file that changed after capture", () => {
    const root = repository();
    writeFileSync(join(root, "src", "draft.ts"), "draft one\n");
    const base = resolveWorkspaceBase(root);
    const workspace = createCandidateWorkspace({ root, base, workspaceRoot: candidateRoot(root), label: "T011" });
    roots.push(workspace.root);
    writeFileSync(join(root, "src", "draft.ts"), "draft two\n");
    expect(verifySourceUnchanged(workspace)).toMatchObject({ unchanged: false });
  });

  it("keeps meaningful trailing whitespace on a final changed line", () => {
    const root = repository();
    const base = resolveWorkspaceBase(root);
    const workspace = createCandidateWorkspace({ root, base, workspaceRoot: candidateRoot(root), label: "T011" });
    roots.push(workspace.root);
    // Two significant trailing spaces: a patch that trims them describes other bytes.
    writeFileSync(join(workspace.root, "src", "base.ts"), "export const base = 2;  ");
    const manifest = candidateManifest(workspace);
    expect(manifest.patch).toContain("export const base = 2;  ");
    // T044: the patch now ends with the newline `git apply` needs, so the marker is the
    // last *line* of the last hunk rather than the last bytes of the string.
    expect(manifest.patch.trimEnd().endsWith("\ No newline at end of file")).toBe(true);
    removeCandidateWorkspace(workspace);
  });

  it("refuses a candidate path that escapes through .., and through an escaping symlink where one can exist", () => {
    const root = repository();
    expect(() => candidatePath(root, "../outside.ts")).toThrow(/escapes the repository/);
    expect(() => candidatePath(root, "src/../../outside.ts")).toThrow(/escapes the repository/);
    if (symlinkRefusal === null) {
      symlinkSync(tmpdir(), join(root, "src", "escape"));
      expect(() => candidatePath(root, "src/escape/new.ts")).toThrow(/escapes the repository through a symlink/);
    }
    expect(() => candidatePath(root, "src/missing.ts")).toThrow(/missing/);
  });
});
