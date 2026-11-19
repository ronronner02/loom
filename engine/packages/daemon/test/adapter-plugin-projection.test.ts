// Test suite for plugin-primitive Phase 3a slice 3.1 — resource-tree projection.
// Proves the walker both runtime adapters used copies a real plugin tree (nested
// .claude-plugin/ + skills/ + hooks/ subdirs) to its plugin target, not just targetDir
// math, and keeps byte-identical re-projection a no-op.
//
// Plugin tree shape (per DESIGN.md §5.5 + IMPL-PRD §2.2):
//   <plugin-root>/
//     .claude-plugin/plugin.json     (Claude manifest)
//     .codex-plugin/plugin.json      (Codex manifest; absent for Claude-only plugin)
//     skills/<id>/SKILL.md           (one or more skill subdirs)
//     hooks/{claude,codex}.json      (hook event configs)
//     hooks/scripts/<file>.cjs       (hook command scripts)

import { describe, it, expect } from "vitest";
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

function mockFs(files?: Record<string, string>): TreeFsOps & { _store: Record<string, string> } {
  const store: Record<string, string> = { ...files };
  return {
    readFile: (p: string) => { if (p in store) return store[p]!; throw new Error(`Not found: ${p}`); },
    writeFile: (p: string, c: string) => { store[p] = c; },
    exists: (p: string) => p in store,
    mkdirp: () => {},
    listFiles: (dir: string) => Object.keys(store).filter((k) => k.startsWith(dir + "/")).map((k) => k.slice(dir.length + 1)),
    _store: store,
  } as TreeFsOps & { _store: Record<string, string> };
}

const LOOM_CORE_TREE = {
  "/p/loom-core/.claude-plugin/plugin.json": '{"name":"loom-core","version":"0.1.0"}',
  "/p/loom-core/.codex-plugin/plugin.json": '{"name":"loom-core","version":"0.1.0","description":"loom"}',
  "/p/loom-core/skills/agent-operated-software/SKILL.md": "# agent-operated-software\nUse for ...",
  "/p/loom-core/skills/orchestration-team/SKILL.md": "# orchestration-team",
  "/p/loom-core/hooks/claude.json": '{"hooks":{"SessionStart":[]}}',
  "/p/loom-core/hooks/codex.json": '{"hooks":{"SessionStart":[]}}',
  "/p/loom-core/hooks/scripts/activity-relay.cjs": "// relay script body",
  "/p/loom-core/README.md": "# loom-core plugin",
};

describe("plugin directory projection", () => {
  it("copies entire plugin tree to <cwd>/.claude/plugins/<id>/ preserving nested structure", () => {
    const fs = mockFs(LOOM_CORE_TREE);

    projectFiles(fs, "/p/loom-core", "/cwd/.claude/plugins/loom-core");

    expect(fs._store["/cwd/.claude/plugins/loom-core/.claude-plugin/plugin.json"]).toBe('{"name":"loom-core","version":"0.1.0"}');
    expect(fs._store["/cwd/.claude/plugins/loom-core/.codex-plugin/plugin.json"]).toBe('{"name":"loom-core","version":"0.1.0","description":"loom"}');
    expect(fs._store["/cwd/.claude/plugins/loom-core/skills/agent-operated-software/SKILL.md"]).toBe("# agent-operated-software\nUse for ...");
    expect(fs._store["/cwd/.claude/plugins/loom-core/skills/orchestration-team/SKILL.md"]).toBe("# orchestration-team");
    expect(fs._store["/cwd/.claude/plugins/loom-core/hooks/claude.json"]).toBe('{"hooks":{"SessionStart":[]}}');
    expect(fs._store["/cwd/.claude/plugins/loom-core/hooks/codex.json"]).toBe('{"hooks":{"SessionStart":[]}}');
    expect(fs._store["/cwd/.claude/plugins/loom-core/hooks/scripts/activity-relay.cjs"]).toBe("// relay script body");
    expect(fs._store["/cwd/.claude/plugins/loom-core/README.md"]).toBe("# loom-core plugin");
  });

  it("copies entire plugin tree to <cwd>/.codex/plugins/<id>/ preserving nested structure", () => {
    const fs = mockFs(LOOM_CORE_TREE);

    projectFiles(fs, "/p/loom-core", "/cwd/.codex/plugins/loom-core");

    expect(fs._store["/cwd/.codex/plugins/loom-core/.claude-plugin/plugin.json"]).toBe('{"name":"loom-core","version":"0.1.0"}');
    expect(fs._store["/cwd/.codex/plugins/loom-core/.codex-plugin/plugin.json"]).toBe('{"name":"loom-core","version":"0.1.0","description":"loom"}');
    expect(fs._store["/cwd/.codex/plugins/loom-core/skills/agent-operated-software/SKILL.md"]).toBe("# agent-operated-software\nUse for ...");
    expect(fs._store["/cwd/.codex/plugins/loom-core/hooks/codex.json"]).toBe('{"hooks":{"SessionStart":[]}}');
    expect(fs._store["/cwd/.codex/plugins/loom-core/hooks/scripts/activity-relay.cjs"]).toBe("// relay script body");
  });

  it("plugin re-projection is a no-op when the content matches (idempotent)", () => {
    const fs = mockFs({
      "/p/loom-core/.claude-plugin/plugin.json": "{}",
      "/cwd/.claude/plugins/loom-core/.claude-plugin/plugin.json": "{}", // already projected with same content
    });

    let writeCount = 0;
    const origWrite = fs.writeFile;
    fs.writeFile = (p, c) => { writeCount++; origWrite(p, c); };

    projectFiles(fs, "/p/loom-core", "/cwd/.claude/plugins/loom-core");

    // A content match skips the write — no spurious overwrites of unchanged plugin files.
    expect(writeCount).toBe(0);
  });
});
