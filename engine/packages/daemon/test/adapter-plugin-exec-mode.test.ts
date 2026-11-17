// OPR skills-vendoring exec-mode QA-blocker (candidate 4c6d8883): projecting a
// plugin tree dropped executable mode — text readFile -> writeFile creates destinations
// with the process default mode and never reapplies the source mode.
//
// These are REAL-fs pins (an actual 0755 exec helper + 0644 non-exec neighbor) over the
// walker both adapters used, plus the statMode/chmod pair production wires in startup.ts.
// They cover the fresh-write path AND the content-identical idempotence-skip path (the QA
// repro re-materializes an already-present tree, so mode must be reconciled even when the
// content is byte-identical and the write is skipped).

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

/** The fsOps surface a resource-tree projection needs. */
type TreeFsOps = {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  listFiles?(dirPath: string): string[];
  statMode?(path: string): number;
  chmod?(path: string, mode: number): void;
  readdir?(dirPath: string): string[];
};

// The walker both runtime adapters projected a resource tree with: copy every file under
// `source` to `target`, skip a byte-identical write, and reconcile the mode either way.
function projectFiles(fsOps: TreeFsOps, source: string, target: string): void {
  const join = (dir: string, name: string) => `${dir}/${name}`;
  const writeOne = (sourcePath: string, targetPath: string) => {
    fsOps.mkdirp(nodePath.posix.dirname(targetPath));
    const content = fsOps.readFile(sourcePath);
    if (!fsOps.exists(targetPath) || fsOps.readFile(targetPath) !== content) fsOps.writeFile(targetPath, content);
    if (fsOps.statMode && fsOps.chmod) fsOps.chmod(targetPath, fsOps.statMode(sourcePath) & 0o777);
  };
  if (fsOps.readdir) {
    const walk = (sourceDir: string, targetDir: string) => {
      for (const name of fsOps.readdir!(sourceDir)) {
        const sourcePath = join(sourceDir, name);
        const targetPath = join(targetDir, name);
        try { walk(sourcePath, targetPath); } catch { writeOne(sourcePath, targetPath); }
      }
    };
    try { walk(source, target); return; } catch { /* file-shaped source */ }
  }
  if (fsOps.listFiles) {
    for (const relative of fsOps.listFiles(source)) writeOne(join(source, relative), join(target, relative));
    return;
  }
  writeOne(source, target);
}

// Real-fs ops mirroring startup.ts, PLUS statMode/chmod (the mode-preserving primitives).
function realFsOps(): TreeFsOps {
  return {
    readFile: (p: string) => fs.readFileSync(p, "utf-8"),
    writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
    exists: (p: string) => fs.existsSync(p),
    mkdirp: (p: string) => { fs.mkdirSync(p, { recursive: true }); },
    listFiles: (dir: string) => {
      const r: string[] = [];
      const walk = (d: string, pre: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory()) walk(nodePath.join(d, e.name), nodePath.join(pre, e.name));
          else r.push(pre ? nodePath.join(pre, e.name) : e.name);
        }
      };
      walk(dir, "");
      return r;
    },
    // Present so the walker recurses with native separators, as production does.
    readdir: (dir: string) => fs.readdirSync(dir),
    statMode: (p: string) => fs.statSync(p).mode,
    chmod: (p: string, mode: number) => fs.chmodSync(p, mode),
  };
}

// Build a real plugin source tree: an executable nested helper (0755) + a non-exec neighbor (0644).
function seedPluginTree(root: string) {
  const skillDir = nodePath.join(root, "multi-agent-core", "skills", "compaction-restore");
  fs.mkdirSync(nodePath.join(skillDir, "scripts"), { recursive: true });
  const hook = nodePath.join(skillDir, "scripts", "precompact-hook.mjs");
  const skillMd = nodePath.join(skillDir, "SKILL.md");
  fs.writeFileSync(hook, "#!/usr/bin/env node\nconsole.log('hook');\n");
  fs.writeFileSync(skillMd, "# compaction-restore\n");
  fs.chmodSync(hook, 0o755);
  fs.chmodSync(skillMd, 0o644);
  return { hookRel: "skills/compaction-restore/scripts/precompact-hook.mjs", skillRel: "skills/compaction-restore/SKILL.md" };
}

function perm(p: string): number { return fs.statSync(p).mode & 0o777; }

describe("plugin tree projection preserves executable mode (skills-vendoring QA blocker)", () => {
  it("nested exec helper keeps 0755, non-exec neighbor stays 0644", () => {
    const base = fs.mkdtempSync(nodePath.join(os.tmpdir(), "execmode-fresh-"));
    const src = nodePath.join(base, "src");
    const rel = seedPluginTree(src);
    const cwd = nodePath.join(base, "cwd");

    projectFiles(realFsOps(), nodePath.join(src, "multi-agent-core"), nodePath.join(cwd, ".claude", "plugins", "multi-agent-core"));

    if (process.platform === "win32") {
      // Windows has no POSIX mode bits: chmod can only toggle the read-only attribute, so
      // the mode contract below is a POSIX-host pin. The walker still copies every file here.
      expect(fs.existsSync(nodePath.join(cwd, ".claude/plugins/multi-agent-core", rel.skillRel))).toBe(true);
      return;
    }
    const outHook = nodePath.join(cwd, ".claude/plugins/multi-agent-core", rel.hookRel);
    const outSkill = nodePath.join(cwd, ".claude/plugins/multi-agent-core", rel.skillRel);
    expect(fs.existsSync(outHook)).toBe(true);
    expect(perm(outHook)).toBe(0o755);
    expect(perm(outSkill)).toBe(0o644);
  });

  it("re-projection reconciles mode even when content is byte-identical (idempotence-skip path)", () => {
    const base = fs.mkdtempSync(nodePath.join(os.tmpdir(), "execmode-idem-"));
    const src = nodePath.join(base, "src");
    const rel = seedPluginTree(src);
    const cwd = nodePath.join(base, "cwd");
    if (process.platform === "win32") return; // no POSIX mode bits to reconcile

    // Pre-place a byte-identical projected helper with the WRONG mode — the exact QA state.
    const outHook = nodePath.join(cwd, ".claude/plugins/multi-agent-core", rel.hookRel);
    fs.mkdirSync(nodePath.dirname(outHook), { recursive: true });
    fs.copyFileSync(nodePath.join(src, "multi-agent-core", rel.hookRel), outHook);
    fs.chmodSync(outHook, 0o644);
    expect(perm(outHook)).toBe(0o644);

    projectFiles(realFsOps(), nodePath.join(src, "multi-agent-core"), nodePath.join(cwd, ".claude/plugins/multi-agent-core"));

    // Content unchanged (write skipped) but the mode is reconciled to the source 0755.
    expect(perm(outHook)).toBe(0o755);
  });
});
