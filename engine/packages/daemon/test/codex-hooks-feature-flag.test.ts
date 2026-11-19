// Test suite for plugin-primitive Phase 3a slice 3.5 — Codex feature flag
// (codex_hooks = true). Per IMPL-PRD §5 + velocity-guard cadence boundary
// (d) 2026-05-10.
//
// Replaces the activity-hook-injection-coupled upsertCodexHooksFeature()
// being removed in Phase 3a slice 3.1. New shape:
//
// 1. Loom setting `runtime.codex.hooks_enabled` (default true)
// 2. CodexRuntimeAdapter exposes ensureCodexFeatureFlag(setting) that
//    writes codex_hooks = true to ~/.codex/config.toml when setting=true
// 3. Idempotent: running twice produces no duplication
// 4. User override (setting=false) → daemon does NOT mutate Codex config

import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";
import { CodexRuntimeAdapter, type CodexAdapterFsOps } from "../src/adapters/codex-runtime-adapter.js";
import { SETTINGS_VALID_KEYS } from "../src/domain/user-settings/settings-store.js";

// The adapter builds these under the fs fixture's own home, with this host's separators.
const HOME = "/home/test";
const CODEX_CONFIG = join(HOME, ".codex", "config.toml");

function mockTmux() {
  return {
    sessionExists: vi.fn().mockResolvedValue(true),
    sendKeys: vi.fn().mockResolvedValue(undefined),
    capturePaneContent: vi.fn().mockResolvedValue(""),
    getPaneCommand: vi.fn().mockResolvedValue(""),
    listSessions: vi.fn().mockResolvedValue([]),
    runCommandInSession: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
    setEnvVar: vi.fn().mockResolvedValue(undefined),
  } as unknown as ConstructorParameters<typeof CodexRuntimeAdapter>[0]["tmux"];
}

function mockCodexFs(files?: Record<string, string>): CodexAdapterFsOps & { _store: Record<string, string> } {
  const store: Record<string, string> = { ...files };
  return {
    readFile: (p: string) => { if (p in store) return store[p]!; throw new Error(`Not found: ${p}`); },
    writeFile: (p: string, c: string) => { store[p] = c; },
    exists: (p: string) => p in store,
    mkdirp: () => {},
    listFiles: (dir: string) => Object.keys(store).filter((k) => k.startsWith(dir + "/")).map((k) => k.slice(dir.length + 1)),
    homedir: "/home/test",
    _store: store,
  } as CodexAdapterFsOps & { _store: Record<string, string> };
}

describe("Slice 3.5 — Codex feature flag (runtime.codex.hooks_enabled)", () => {
  // ============================================================
  // HG-5.1: setting exists in canonical valid-keys lists
  // ============================================================

  it("HG-5.1 — runtime.codex.hooks_enabled is in SETTINGS_VALID_KEYS", () => {
    expect(SETTINGS_VALID_KEYS as readonly string[]).toContain("runtime.codex.hooks_enabled");
  });

  // ============================================================
  // HG-5.2: ensureCodexFeatureFlag writes codex_hooks = true
  // ============================================================

  it("HG-5.2 — ensureCodexFeatureFlag(true) writes codex_hooks = true to ~/.codex/config.toml when file missing", () => {
    const fs = mockCodexFs();
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });

    adapter.ensureCodexFeatureFlag(true, { codexVersion: "0.120.0" });

    const written = fs._store[CODEX_CONFIG];
    expect(written).toBeDefined();
    expect(written).toContain("[features]");
    expect(written).toContain("codex_hooks = true");
  });

  it("GAP-7 writes the feature flag to the injected Codex home", () => {
    const fs = mockCodexFs();
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs, codexHome: "/custom-codex" });

    adapter.ensureCodexFeatureFlag(true, { codexVersion: "0.120.0" });

    expect(fs._store[join("/custom-codex", "config.toml")]).toContain("codex_hooks = true");
    expect(fs._store[CODEX_CONFIG]).toBeUndefined();
  });

  it("HG-5.2 — ensureCodexFeatureFlag(true) sets codex_hooks = true while preserving existing config content", () => {
    const existing = `[model_provider]\nname = "openai"\n\n[other_section]\nfoo = "bar"\n`;
    const fs = mockCodexFs({ [CODEX_CONFIG]: existing });
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });

    adapter.ensureCodexFeatureFlag(true, { codexVersion: "0.120.0" });

    const written = fs._store[CODEX_CONFIG]!;
    expect(written).toContain('name = "openai"');
    expect(written).toContain('foo = "bar"');
    expect(written).toContain("[features]");
    expect(written).toContain("codex_hooks = true");
  });

  // ============================================================
  // HG-5.3: idempotent
  // ============================================================

  it("HG-5.3 — ensureCodexFeatureFlag(true) is idempotent (running twice doesn't duplicate codex_hooks)", () => {
    const fs = mockCodexFs();
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });

    adapter.ensureCodexFeatureFlag(true, { codexVersion: "0.120.0" });
    adapter.ensureCodexFeatureFlag(true, { codexVersion: "0.120.0" });

    const written = fs._store[CODEX_CONFIG]!;
    const matches = written.match(/codex_hooks = true/g) ?? [];
    expect(matches).toHaveLength(1);
    const featuresMatches = written.match(/\[features\]/g) ?? [];
    expect(featuresMatches).toHaveLength(1);
  });

  it("HG-5.3 — pre-existing [features] block with other flags is preserved when adding codex_hooks", () => {
    const existing = `[features]\nother_flag = false\n`;
    const fs = mockCodexFs({ [CODEX_CONFIG]: existing });
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });

    adapter.ensureCodexFeatureFlag(true, { codexVersion: "0.120.0" });

    const written = fs._store[CODEX_CONFIG]!;
    expect(written).toContain("other_flag = false");
    expect(written).toContain("codex_hooks = true");
  });

  // ============================================================
  // HG-5.4: user override (false) → daemon does not mutate
  // ============================================================

  it("HG-5.4 — ensureCodexFeatureFlag(false) does NOT touch ~/.codex/config.toml when file missing", () => {
    const fs = mockCodexFs();
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });

    adapter.ensureCodexFeatureFlag(false);

    expect(fs._store[CODEX_CONFIG]).toBeUndefined();
  });

  it("HG-5.4 — ensureCodexFeatureFlag(false) does NOT touch existing ~/.codex/config.toml content (user owns it)", () => {
    const existing = `[features]\ncodex_hooks = false\nother = true\n`;
    const fs = mockCodexFs({ [CODEX_CONFIG]: existing });
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });

    adapter.ensureCodexFeatureFlag(false);

    expect(fs._store[CODEX_CONFIG]).toBe(existing);
  });

  // OPR.0.4.0.11 version-aware tests
  it("0.4.0.11 — unknown version (undefined) does NOT write config", () => {
    const fs = mockCodexFs();
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });

    adapter.ensureCodexFeatureFlag(true, { codexVersion: undefined });

    expect(fs._store[CODEX_CONFIG]).toBeUndefined();
  });

  it("0.4.0.11 — 0.139.0 does NOT write config (hooks default-enabled)", () => {
    const fs = mockCodexFs();
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });

    adapter.ensureCodexFeatureFlag(true, { codexVersion: "0.139.0" });

    expect(fs._store[CODEX_CONFIG]).toBeUndefined();
  });

  it("0.4.0.11 — 0.120.0 DOES write config (legacy toggle)", () => {
    const fs = mockCodexFs();
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });

    adapter.ensureCodexFeatureFlag(true, { codexVersion: "0.120.0" });

    const written = fs._store[CODEX_CONFIG];
    expect(written).toBeDefined();
    expect(written).toContain("codex_hooks = true");
  });
});
