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

const MULTI_AGENT_CORE_TREE = {
  "/p/multi-agent-core/.claude-plugin/plugin.json": '{"name":"multi-agent-core","version":"0.1.0"}',
  "/p/multi-agent-core/.codex-plugin/plugin.json": '{"name":"multi-agent-core","version":"0.1.0","description":"multi-agent"}',
  "/p/multi-agent-core/skills/agent-operated-software/SKILL.md": "# agent-operated-software\nUse for ...",
  "/p/multi-agent-core/skills/orchestration-team/SKILL.md": "# orchestration-team",
  "/p/multi-agent-core/hooks/claude.json": '{"hooks":{"SessionStart":[]}}',
  "/p/multi-agent-core/hooks/codex.json": '{"hooks":{"SessionStart":[]}}',
  "/p/multi-agent-core/hooks/scripts/activity-relay.cjs": "// relay script body",
  "/p/multi-agent-core/README.md": "# multi-agent-core plugin",
};

describe("plugin directory projection", () => {
  it("copies entire plugin tree to <cwd>/.claude/plugins/<id>/ preserving nested structure", () => {
    const fs = mockFs(MULTI_AGENT_CORE_TREE);

    projectFiles(fs, "/p/multi-agent-core", "/cwd/.claude/plugins/multi-agent-core");

    expect(fs._store["/cwd/.claude/plugins/multi-agent-core/.claude-plugin/plugin.json"]).toBe('{"name":"multi-agent-core","version":"0.1.0"}');
    expect(fs._store["/cwd/.claude/plugins/multi-agent-core/.codex-plugin/plugin.json"]).toBe('{"name":"multi-agent-core","version":"0.1.0","description":"multi-agent"}');
    expect(fs._store["/cwd/.claude/plugins/multi-agent-core/skills/agent-operated-software/SKILL.md"]).toBe("# agent-operated-software\nUse for ...");
    expect(fs._store["/cwd/.claude/plugins/multi-agent-core/skills/orchestration-team/SKILL.md"]).toBe("# orchestration-team");
    expect(fs._store["/cwd/.claude/plugins/multi-agent-core/hooks/claude.json"]).toBe('{"hooks":{"SessionStart":[]}}');
    expect(fs._store["/cwd/.claude/plugins/multi-agent-core/hooks/codex.json"]).toBe('{"hooks":{"SessionStart":[]}}');
    expect(fs._store["/cwd/.claude/plugins/multi-agent-core/hooks/scripts/activity-relay.cjs"]).toBe("// relay script body");
    expect(fs._store["/cwd/.claude/plugins/multi-agent-core/README.md"]).toBe("# multi-agent-core plugin");
  });

  it("copies entire plugin tree to <cwd>/.codex/plugins/<id>/ preserving nested structure", () => {
    const fs = mockFs(MULTI_AGENT_CORE_TREE);

    projectFiles(fs, "/p/multi-agent-core", "/cwd/.codex/plugins/multi-agent-core");

    expect(fs._store["/cwd/.codex/plugins/multi-agent-core/.claude-plugin/plugin.json"]).toBe('{"name":"multi-agent-core","version":"0.1.0"}');
    expect(fs._store["/cwd/.codex/plugins/multi-agent-core/.codex-plugin/plugin.json"]).toBe('{"name":"multi-agent-core","version":"0.1.0","description":"multi-agent"}');
    expect(fs._store["/cwd/.codex/plugins/multi-agent-core/skills/agent-operated-software/SKILL.md"]).toBe("# agent-operated-software\nUse for ...");
    expect(fs._store["/cwd/.codex/plugins/multi-agent-core/hooks/codex.json"]).toBe('{"hooks":{"SessionStart":[]}}');
    expect(fs._store["/cwd/.codex/plugins/multi-agent-core/hooks/scripts/activity-relay.cjs"]).toBe("// relay script body");
  });

  it("plugin re-projection is a no-op when the content matches (idempotent)", () => {
    const fs = mockFs({
      "/p/multi-agent-core/.claude-plugin/plugin.json": "{}",
      "/cwd/.claude/plugins/multi-agent-core/.claude-plugin/plugin.json": "{}", // already projected with same content
    });

    let writeCount = 0;
    const origWrite = fs.writeFile;
    fs.writeFile = (p, c) => { writeCount++; origWrite(p, c); };

    projectFiles(fs, "/p/multi-agent-core", "/cwd/.claude/plugins/multi-agent-core");

    // A content match skips the write — no spurious overwrites of unchanged plugin files.
    expect(writeCount).toBe(0);
  });
});
