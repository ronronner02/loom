/**
 * The T044/T054 fixture, shared by the two files the original suite was split into.
 *
 * `richRepository` is the shape every byte-exact expectation is measured against: a tracked file,
 * a tracked symlink, a binary, a file with no final newline, an executable, and a `.gitignore`
 * that governs them. `roots` and `outsideRoots` are the directories each file's `afterEach`
 * removes.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createCandidateWorkspace, resolveWorkspaceBase, type CandidateWorkspace } from "../../src/domain/team-workspace.js";

/** Directories a test file owns and removes in its `afterEach`. */
export const roots: string[] = [];
/** Candidate trees live outside the repository; these are removed with `roots`. */
export const outsideRoots: string[] = [];

// Every git call in these suites is about bytes, so the host's own git configuration must not
// change them: a runner whose global config says `core.autocrlf=true` normalizes a file when it
// is *added*, which stores CRLF where the fixture wrote LF and breaks every byte-exact
// expectation. The two settings are pinned on the command line, which outranks every config file,
// so a dev machine and a Windows runner measure the same bytes.
export const gitWithByteExactConfig = ["-c", "core.autocrlf=false", "-c", "core.eol=lf"];
export const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...gitWithByteExactConfig, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A candidate tree, outside the repository so git discovery cannot find the parent. */
export function candidateRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "candidate-tree-"));
  outsideRoots.push(dir);
  return dir;
}

export const GOLDEN_DIGEST = "sha256:d154f8eb5464dea71f761724a53620e17e42e5dca051be08a3ae8174c7956d7e";
export const GOLDEN_FILES: readonly (readonly [string, string, boolean])[] = [
  [".gitignore", "sha256:9a4e80f747a5791fbca62d7b04bdad73c6e37fdbf4398943bc85810a00facb64", true],
  ["README.md", "sha256:faa5b4816800b8cbe1595e5533fe36c53f396c0c26a3a876dd3e4085232348a1", true],
  ["docs/target.md", "sha256:7395d98c09c6c11bc827d489c2c974253508fabe2d41bf334b9e929664a887f6", true],
  ["run.sh", "sha256:299001868fb8c02fd431c336c6d058f5558c5dff5b5af5e6fe04b870a6a9cbba", true],
  ["src/base.ts", "sha256:234a49990ed0ca423d7e03f6831099806c117bfe29ed0add57df7415cd732271", true],
  ["src/binary.dat", "sha256:23e5b91bc67af30fad5933903277da95d30a3791f267d540796ed5d381252aa0", true],
  ["src/link.md", "sha256:7b23654b6087192fc8a2be9fcb5e7f2edc7f556159da8139594c3cb742996d4a", true],
  ["src/nested/deep/leaf.ts", "sha256:824ff7cdf2b91463b1179488abfd254683ccb0f638549c7d56ffb86c642b2253", true],
  ["src/trailing.ts", "sha256:3da9df10960a5b5df7633e2714424825a9814316e92c9420467cad11297e1ccb", true],
];

/** A canary outside every tree the test owns; only a worker-planted program writes it. */
export function canary(): { path: string; seen: () => boolean } {
  const path = join(mkdtempSync(join(tmpdir(), "t044-canary-")), "ran");
  outsideRoots.push(join(path, ".."));
  return { path, seen: () => existsSync(path) };
}

/** A repository with one tracked file, one tracked symlink and a controlling .gitignore. */
export function richRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "t044-rich-")); roots.push(root);
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.invalid"); git(root, "config", "user.name", "test");
  // The fixture is about bytes, so its repository must not rewrite them: a runner whose global
  // config says `core.autocrlf=true` otherwise checks these files out with CRLF and every
  // byte-exact expectation reads the runner's setting instead of the product's.
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "core.safecrlf", "false");
  mkdirSync(join(root, "src", "nested", "deep"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# fixture\n");
  writeFileSync(join(root, "src", "base.ts"), "export const base = 1;\n");
  writeFileSync(join(root, "src", "nested", "deep", "leaf.ts"), "export const leaf = true;\n");
  // Significant trailing whitespace and no final newline: a patch that trims either
  // describes bytes other than the ones the manifest hashed.
  writeFileSync(join(root, "src", "trailing.ts"), "no newline at end  ");
  writeFileSync(join(root, "src", "binary.dat"), Buffer.from([0, 1, 2, 255, 0, 3]));
  writeFileSync(join(root, "docs", "target.md"), "the symlink target\n");
  writeFileSync(join(root, "run.sh"), "#!/bin/sh\necho hi\n");
  chmodSync(join(root, "run.sh"), 0o755);
  // A tracked symlink, as this repository has five of. On the base commit it is
  // hashed through its target's bytes because the manifest read the path.
  symlinkSync("../docs/target.md", join(root, "src", "link.md"));
  writeFileSync(join(root, ".gitignore"), "node_modules/\n*.log\n.env\n");
  git(root, "add", "-A"); git(root, "commit", "--quiet", "-m", "base");
  return root;
}

export function candidateOf(root: string): CandidateWorkspace {
  const base = resolveWorkspaceBase(root);
  const workspace = createCandidateWorkspace({ root, base, workspaceRoot: candidateRoot(), label: "T044" });
  roots.push(workspace.root);
  return workspace;
}

/**
 * Take the candidate's repository metadata over the way a worker would: it is
 * worker-writable, so the worker deletes the worktree link, builds a repository of
 * its own and points that repository's configuration at a program it wrote.
 *
 * `git fetch` from the source is available to the worker too — it may read the
 * source tree — and it makes the base commit an object of the worker's repository.
 * That matters: without it the base commit is unknown there and the tracked-diff
 * call fails before reaching a hook, which would let a test pass for the wrong
 * reason. With it, the only thing left between the worker and execution is which
 * directory git is asked about.
 */
export function takeOverRepositoryMetadata(
  workspace: { root: string; sourceRoot: string; base: { kind: string; commit?: string } },
  configure: (gitIn: (...args: string[]) => void) => void,
): void {
  const candidate = workspace.root;
  rmSync(join(candidate, ".git"), { recursive: true, force: true });
  git(candidate, "init", "--quiet");
  git(candidate, "config", "user.email", "worker@example.invalid");
  git(candidate, "config", "user.name", "worker");
  if (workspace.base.commit) git(candidate, "fetch", "--quiet", workspace.sourceRoot, workspace.base.commit);
  configure((...args: string[]) => git(candidate, ...args));
}

export function plant(candidate: string, name: string, body: string, canaryPath: string): string {
  const program = join(candidate, name);
  writeFileSync(program, `#!/bin/sh\n: > ${JSON.stringify(canaryPath)}\n${body}\n`);
  chmodSync(program, 0o755);
  return program;
}

/**
 * A program planted outside the candidate. A candidate is worker-writable, but so is
 * everything the worker itself owns; the defence is that git never reads a path the
 * worker controls, not that the worker could not write a script.
 */
export function plantedOutside(candidate: string, body: string, canaryPath: string): string {
  return plant(dirname(candidate), `worker-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`, body, canaryPath);
}

/** One file's section of a patch, so an assertion cannot be satisfied by unrelated bytes. */
export function patchSection(patch: string, path: string): string {
  const start = patch.indexOf(`diff --git a/${path} b/${path}`);
  if (start < 0) return "";
  const next = patch.indexOf("\ndiff --git ", start + 1);
  return next < 0 ? patch.slice(start) : patch.slice(start, next);
}
