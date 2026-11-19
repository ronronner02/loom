import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDataRoots } from "../src/data-paths.js";

describe("Loom data roots", () => {
  it("uses separate native Windows state and configuration roots", () => {
    expect(resolveDataRoots({ platform: "win32", home: "D:\\Users\\Owner", env: {
      LOCALAPPDATA: "D:\\Profiles\\Local", APPDATA: "D:\\Profiles\\Roaming",
    } })).toEqual({ state: "D:\\Profiles\\Local\\Loom", config: "D:\\Profiles\\Roaming\\Loom" });
  });

  it("uses the Windows profile folders when app data variables are absent", () => {
    expect(resolveDataRoots({ platform: "win32", home: "D:\\Users\\Owner", env: {} })).toEqual({
      state: "D:\\Users\\Owner\\AppData\\Local\\Loom",
      config: "D:\\Users\\Owner\\AppData\\Roaming\\Loom",
    });
  });

  it.each(["linux", "darwin"] as const)("uses one hidden home on %s", platform => {
    expect(resolveDataRoots({ platform, home: "/fixture/owner", env: {} })).toEqual({
      state: join("/fixture/owner", ".loom"), config: join("/fixture/owner", ".loom"),
    });
  });

  it.each(["win32", "linux"] as const)("applies the explicit home override to both roots on %s", platform => {
    expect(resolveDataRoots({ platform, home: "/unused", env: { LOOM_HOME: "/fixture/override" } }))
      .toEqual({ state: "/fixture/override", config: "/fixture/override" });
  });

  it("ignores both former environment selectors", () => {
    const env = Object.fromEntries(["OPEN" + "RIG", "RIG" + "GED"].map(prefix => [`${prefix}_HOME`, "/do-not-read"]));
    expect(resolveDataRoots({ platform: "linux", home: "/fixture/owner", env })).toEqual({
      state: join("/fixture/owner", ".loom"), config: join("/fixture/owner", ".loom"),
    });
  });

  it("keeps database and transcript defaults in state when configuration has a separate root", async () => {
    const root = mkdtempSync(join(tmpdir(), "data-roots-"));
    const state = join(root, "local");
    const config = join(root, "roaming");
    vi.doMock("../src/data-paths.js", () => ({
      getLoomHome: () => state,
      getConfigPath: (file: string) => join(config, file),
    }));
    vi.resetModules();
    try {
      const { SettingsStore } = await import("../src/domain/user-settings/settings-store.js");
      const store = new SettingsStore();
      expect(store.configPath).toBe(join(config, "config.json"));
      expect(store.resolveOne("db.path").value).toBe(join(state, "loom.sqlite"));
      expect(store.resolveOne("transcripts.path").value).toBe(join(state, "transcripts"));
    } finally {
      vi.doUnmock("../src/data-paths.js");
      vi.resetModules();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
