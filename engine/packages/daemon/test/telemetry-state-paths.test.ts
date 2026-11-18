import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  contextUsageDirectory,
  legacyContextUsageDirectory,
  legacyProviderUsageDirectory,
  providerUsageDirectory,
  telemetrySidecarFilename,
} from "../src/domain/telemetry-state-paths.js";

describe("Multi-Agent-owned telemetry paths", () => {
  const home = "/multi-agent-home";
  it("owns both telemetry roots beneath state", () => {
    expect(contextUsageDirectory(home)).toBe(path.join(home, "state", "context-usage"));
    expect(providerUsageDirectory(home)).toBe(path.join(home, "state", "provider-usage"));
  });

  it("names the 0.5.8 compatibility roots without changing canonical ownership", () => {
    expect(legacyContextUsageDirectory(home)).toBe(path.join(home, "context"));
    expect(legacyProviderUsageDirectory(home)).toBe(path.join(home, "provider-usage"));
  });

  it("owns the sidecar filename rule used by readers", () => {
    expect(telemetrySidecarFilename("dev/impl @ test")).toBe("dev_impl_@_test.json");
  });

  it("keeps the projected CJS collector filename rule in parity", () => {
    const collector = fs.readFileSync(
      path.join(import.meta.dirname, "../assets/claude-statusline-context.cjs"),
      "utf8",
    );
    const sessionName = "dev/impl @ test";
    const collectorRule = sessionName.replace(/[^a-zA-Z0-9@._-]/g, "_") + ".json";
    expect(telemetrySidecarFilename(sessionName)).toBe(collectorRule);
    expect(collector).toContain("/[^a-zA-Z0-9@._-]/g");
  });
});
