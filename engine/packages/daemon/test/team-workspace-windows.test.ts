import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  candidateManifest, createCandidateWorkspace, resolveWorkspaceBase,
} from "../src/domain/team-workspace.js";
import { readWorkspacePath } from "../src/domain/workspace-read.js";
import { symlinkRefusal } from "./helpers/symlink.js";

/**
 * U1 — the worker-written-file boundary on Windows.
 *
 * `O_NOFOLLOW` and `O_DIRECTORY` are POSIX-only open flags, and `/proc/self/fd` is how the POSIX
 * walk names a pinned directory. Neither exists on Windows, so the same guarantee is made by
 * checking each entry for a reparse point: a junction or symbolic link below the candidate root is
 * refused (or recorded as a link and never followed) instead of silently redirecting a read. These
 * cases need the real Windows filesystem, because only it can create a junction.
 */

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const temporary = (prefix: string): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const repository = (): string => {
  const root = temporary("u1-workspace-");
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.invalid"); git(root, "config", "user.name", "test");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "base.ts"), "export const base = 1;\n");
  git(root, "add", "."); git(root, "commit", "--quiet", "-m", "base");
  return root;
};

describe.skipIf(process.platform !== "win32")("U1 Windows worker-written-file boundary", () => {
  it("finishes a manifest when Windows briefly holds its temporary Git directory open", async () => {
    const root = repository(), signals = temporary("manifest-lock-");
    const workspace = createCandidateWorkspace({ root, base: resolveWorkspaceBase(root),
      workspaceRoot: temporary("manifest-candidate-"), label: "cleanup-lock" });
    writeFileSync(join(workspace.root, "plan.md"), "# Revised plan\n");
    let holder: ChildProcess | undefined, exited = Promise.resolve(), scratch = "";
    workspace.checkScope = ({ root: snapshot }) => {
      scratch = dirname(snapshot);
      const ready = join(signals, "ready");
      // A Windows process holds its current directory against deletion until it exits.
      holder = spawn(process.execPath, ["-e",
        "require('node:fs').writeFileSync(process.argv[1], 'ready'); setTimeout(() => {}, 200)", ready],
        { cwd: join(scratch, "patch.git"), stdio: "ignore", windowsHide: true });
      exited = new Promise<void>((resolve, reject) => { holder!.once("exit", () => resolve()); holder!.once("error", reject); });
      const deadline = Date.now() + 5_000;
      while (!existsSync(ready)) {
        if (Date.now() > deadline) throw new Error("The temporary-directory lock holder did not start");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      return { chainHead: "fixture", scopeDigest: "fixture", extensions: [] };
    };
    try {
      const manifest = candidateManifest(workspace);
      expect(manifest.patch).toContain("# Revised plan");
      expect(manifest.files.map(file => file.path)).toEqual(["plan.md", "src/base.ts"]);
      expect(existsSync(scratch)).toBe(false);
      expect(existsSync(join(workspace.root, "plan.md"))).toBe(true);
    } finally {
      holder?.kill(); await exited;
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("reads a workspace path by name on Windows", () => {
    const root = repository();
    expect(readWorkspacePath(root, "src/base.ts", () => false)).toMatchObject({ kind: "file", content: "export const base = 1;\n" });
    expect(readWorkspacePath(root, "src", () => false)).toMatchObject({ kind: "directory" });
    expect(readWorkspacePath(root, "src/missing.ts", () => false)).toEqual({ kind: "missing" });
  });

  it("refuses a junction planted between the root and a file", () => {
    const root = repository();
    const vault = temporary("u1-vault-");
    writeFileSync(join(vault, "secret.txt"), "VAULT SECRET\n");
    // A junction is the Windows shape of a directory symlink; it needs no elevation, unlike a file
    // symlink, and following it would read bytes outside the candidate.
    symlinkSync(vault, join(root, "src", "linked"), "junction");
    expect(() => readWorkspacePath(root, "src/linked/secret.txt", () => false))
      .toThrow("Candidate path became a symlink while it was read: src/linked/secret.txt");
  });

  it("records a junction in the candidate as its own link text instead of staging what it points at", () => {
    const root = repository();
    const vault = temporary("u1-vault-");
    writeFileSync(join(vault, "secret.txt"), "VAULT SECRET\n");
    const workspace = createCandidateWorkspace({ root, base: resolveWorkspaceBase(root),
      workspaceRoot: temporary("u1-candidate-"), label: "windows-links" });
    // The worker writes into its own candidate; a junction there is what the copy must not follow.
    symlinkSync(vault, join(workspace.root, "src", "linked"), "junction");
    // The entry is the junction's own text, as a POSIX host records a symlink: the target is
    // never read, so the vault's bytes reach neither the manifest nor the patch.
    const manifest = candidateManifest(workspace);
    expect(manifest.files.map(file => file.path), "the junction is a manifest entry").toContain("src/linked");
    expect(manifest.files.map(file => file.path)).not.toContain("src/linked/secret.txt");
    expect(JSON.stringify(manifest)).not.toContain("VAULT SECRET");
    expect(manifest.patch).toContain("120000");
  });

  it.skipIf(symlinkRefusal !== null)("records an untouched link in the form git stores, so it reads as unchanged", () => {
    // Git stores a link's target as it was authored, and Windows reports a relative target with
    // its own separators. A host that recorded the Windows form made every untouched link read as
    // an edit: the manifest hash disagreed with the base's blob and the patch wrote a link that
    // named the same target in a different spelling. The host skips when it denies `symlink()`;
    // the runner's volume, which is where this case has a defect to catch, creates one.
    const root = repository();
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "target.md"), "target\n");
    symlinkSync("../docs/target.md", join(root, "src", "link.md"));
    git(root, "add", "-A"); git(root, "commit", "--quiet", "-m", "link");
    const workspace = createCandidateWorkspace({ root, base: resolveWorkspaceBase(root),
      workspaceRoot: temporary("u1-candidate-"), label: "windows-link-text" });
    const manifest = candidateManifest(workspace);
    // The manifest hashes git's own bytes for the target, and the patch is empty: nothing changed.
    expect(manifest.files.find(file => file.path === "src/link.md")?.hash)
      .toBe(`sha256:${createHash("sha256").update("../docs/target.md").digest("hex")}`);
    expect(manifest.patch, "an untouched link needs no patch").toBe("");
  });
});
