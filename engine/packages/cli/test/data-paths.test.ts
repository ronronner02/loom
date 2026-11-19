import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getConfigPath, getLoomHome, getStatePath, resolveDataRoots } from "@loom/daemon/data-paths";
import { createProgram } from "../src/index.js";

afterEach(() => vi.unstubAllEnvs());

describe("renamed CLI package", () => {
  it("publishes only the Loom executable", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(manifest.name).toBe("@loom/cli");
    expect(manifest.bin).toEqual({ "loom": "dist/bin-wrapper.js" });
    expect(createProgram().helpInformation()).toContain("Usage: loom");
  });

  it("uses the daemon's exported resolver for the override and derived paths", () => {
    vi.stubEnv("LOOM_HOME", "/fixture/selected-home");
    expect(getLoomHome()).toBe("/fixture/selected-home");
    expect(getStatePath("loom.sqlite")).toBe(join("/fixture/selected-home", "loom.sqlite"));
    expect(getConfigPath("config.json")).toBe(join("/fixture/selected-home", "config.json"));
  });

  it("exposes separate native Windows roots through the package export", () => {
    expect(resolveDataRoots({ platform: "win32", env: { LOCALAPPDATA: "D:\\Local", APPDATA: "D:\\Roaming" } }))
      .toEqual({ state: "D:\\Local\\Loom", config: "D:\\Roaming\\Loom" });
  });
});
