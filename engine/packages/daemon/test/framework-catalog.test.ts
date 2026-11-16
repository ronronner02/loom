import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FRAMEWORK_CATALOG, FRAMEWORK_PIN, frameworkEntry } from "../src/integrations/framework/catalog.js";

describe("pinned framework catalog", () => {
  it("accounts for exactly the upstream entrypoints at the approved revision", () => {
    const names = FRAMEWORK_CATALOG.map(entry => entry.name).sort();
    expect(FRAMEWORK_PIN.repository).toBe("ronronner02/spec-first");
    expect(FRAMEWORK_PIN.revision).toBe("8e480ce7921f7a05c6d480e2204d57176554168c");
    expect(names).toHaveLength(39);
    expect(new Set(names).size).toBe(39);
    expect(createHash("sha256").update(names.join("\n")).digest("hex"))
      .toBe("9ab39c32023f5dcbe981273341b1d74f9ee90e1bce2cb52d238f3e657b569ef2");
    expect(frameworkEntry("spec-diagnose")).toMatchObject({ status: "gated", invocation: "user" });
  });
  it("classifies every entry and exposes a prerequisite for gated or deferred capabilities", () => {
    for (const entry of FRAMEWORK_CATALOG) {
      expect(["supported", "gated", "deferred"]).toContain(entry.status);
      expect(entry.sourcePath).toBe(`skills/${entry.name}/SKILL.md`);
      if (entry.status !== "supported") expect(entry.prerequisite.trim()).not.toBe("");
    }
    expect(frameworkEntry("spec-test-xcode")).toMatchObject({ status: "gated" });
    expect(frameworkEntry("spec-test-xcode")?.prerequisite).toContain("macOS");
    expect(frameworkEntry("review")).toBeUndefined();
  });
  it("retains explicit user invocation and caller-owned delivery boundaries", () => {
    for (const name of ["spec-lfg", "spec-handoff", "spec-prototype"]) {
      expect(frameworkEntry(name)).toMatchObject({ status: "gated", invocation: "user" });
    }
    for (const name of ["spec-commit", "spec-commit-push-pr", "spec-worktree"]) {
      expect(frameworkEntry(name)).toMatchObject({ status: "gated", invocation: "caller" });
    }
  });
});
