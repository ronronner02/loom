import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedPaths, leadCompletionEvidence, taskCompletionEvidence } from "../src/domain/task-completion.js";

const quotedHeader = (path: string) => 'diff --git "a/' + path + '" "b/' + path + '"\n';
const manifest = (patch: string) => ({ base: "commit" as const, baseIdentifier: "a".repeat(40),
  files: [], manifestDigest: "sha256:" + "b".repeat(64), patch });

const quotedNames = [
  ["octal UTF-8", "src/\\344\\270\\255\\346\\226\\207.ts", "src/\u4e2d\u6587.ts"],
  ["four-byte UTF-8", "src/\\360\\237\\230\\200.ts", "src/\u{1f600}.ts"],
  ["tab", "src/tab\\tfile.ts", "src/tab\tfile.ts"],
  ["quote", 'src/quote\\"file.ts', 'src/quote"file.ts'],
  ["backslash", "src/back\\\\slash.ts", "src/back\\slash.ts"],
  ["newline", "src/line\\nfile.ts", "src/line\nfile.ts"],
  ["carriage return", "src/line\\rfile.ts", "src/line\rfile.ts"],
  ["bell", "src/bell\\afile.ts", "src/bell\x07file.ts"],
  ["backspace", "src/back\\bfile.ts", "src/back\bfile.ts"],
  ["form feed", "src/form\\ffile.ts", "src/form\ffile.ts"],
  ["vertical tab", "src/vertical\\vfile.ts", "src/vertical\vfile.ts"],
  ["literal UTF-8 with escaped tab", "src/\u4e2d\u6587\\tfile.ts", "src/\u4e2d\u6587\tfile.ts"],
] as const;

describe("candidate patch path decoding", () => {
  it.each(quotedNames)("decodes %s without changing the filename", (_name, encoded, expected) => {
    expect(changedPaths(quotedHeader(encoded))).toEqual([expected]);
  });

  it("preserves unquoted ASCII, literal UTF-8, and spaces containing the apparent separator", () => {
    const names = ["src/plain.ts", "src/\u4e2d\u6587.ts", "src/space b/nested/file.ts"];
    const patch = names.map(path => "diff --git a/" + path + " b/" + path + "\n").join("");
    expect(changedPaths(patch)).toEqual(names);
    expect(changedPaths("")).toEqual([]);
  });

  it("preserves destination semantics for mixed quoted and unquoted rename headers", () => {
    const patch = [
      'diff --git a/old.ts "b/src/\\344\\270\\255.ts"',
      'rename from old.ts', 'rename to "src/\\344\\270\\255.ts"',
      'diff --git "a/src/\\344\\270\\255.ts" b/new.ts',
      'rename from "src/\\344\\270\\255.ts"', 'rename to new.ts',
      'diff --git a/old space.ts b/src/new b/nested.ts',
      'rename from old space.ts', 'rename to src/new b/nested.ts',
    ].join("\n");
    expect(changedPaths(patch)).toEqual(["src/\u4e2d.ts", "new.ts", "src/new b/nested.ts"]);
  });

  it("retains binary and deleted paths without requiring a +++ header", () => {
    const patch = quotedHeader("src/\\344\\270\\255.bin") + "GIT binary patch\nliteral 1\nA00000\n\n" +
      quotedHeader("src/\\346\\226\\207.ts") + "deleted file mode 100644\n--- a/src/old.ts\n+++ /dev/null\n";
    expect(changedPaths(patch)).toEqual(["src/\u4e2d.bin", "src/\u6587.ts"]);
  });

  it("validates an in-scope non-ASCII candidate and rejects a mixed out-of-scope change", () => {
    const inside = quotedHeader("src/\\344\\270\\255\\346\\226\\207.ts");
    expect(taskCompletionEvidence({ role: "implementer", assignmentPaths: ["src"], manifest: manifest(inside) }))
      .toMatchObject({ validated: true, changedPaths: ["src/\u4e2d\u6587.ts"], reasons: [] });
    const mixed = "diff --git a/src/plain.ts b/src/plain.ts\n" + quotedHeader("private/\\344\\270\\255.ts");
    expect(taskCompletionEvidence({ role: "implementer", assignmentPaths: ["src"], manifest: manifest(mixed) }))
      .toMatchObject({ validated: false, outsideAssignment: ["private/\u4e2d.ts"] });
  });

  it("does not hide non-ASCII changes beside the lead's proposal", () => {
    const patch = "diff --git a/lead-proposal.json b/lead-proposal.json\n" + quotedHeader("src/\\344\\270\\255.ts");
    expect(leadCompletionEvidence({ manifest: manifest(patch), proposal: { taskCount: 1 } }))
      .toMatchObject({ validated: false, outsideAssignment: ["src/\u4e2d.ts"] });
  });
});

describe("actual Git-quoted tree paths", () => {
  let root: string | undefined;
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

  it.each([true, false])("reads Git's UTF-8 and control-character paths with core.quotePath=%s", quotePath => {
    root = mkdtempSync(join(tmpdir(), "completion-paths-"));
    const repo = join(root, "objects.git");
    execFileSync("git", ["init", "--quiet", "--bare", repo], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const git = (args: string[], input?: string) => execFileSync("git", ["--git-dir=" + repo,
      "-c", "core.quotePath=" + quotePath, ...args], { encoding: "utf8", input, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const base = git(["mktree", "-z"], "").trim();
    const blob = git(["hash-object", "-w", "--stdin"], "fixture\n").trim();
    const names = [...quotedNames.map(([, , path]) => path), "src/space b file.ts"];
    // Tree objects preserve POSIX names without asking Windows to create or index those filenames.
    const source = git(["mktree", "-z"], names.map(path => "100644 blob " + blob + "\t" + path.slice(4) + "\0").join("")).trim();
    const tree = git(["mktree", "-z"], "040000 tree " + source + "\tsrc\0").trim();
    const patch = git(["diff", "--binary", "--no-renames", "--no-ext-diff", "--no-textconv",
      "--src-prefix=a/", "--dst-prefix=b/", base, tree]);
    expect(changedPaths(patch).sort()).toEqual([...names].sort());
  });
});
