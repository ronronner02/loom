import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hashBinding, hashBytes } from "../src/domain/plan-governance.js";
import { teamControlRoutes } from "../src/routes/team-control.js";
import { ScopeExtensions } from "../src/domain/scope-extension.js";
import type { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import type { ReviewPacket } from "../src/domain/team-workspace.js";
import { symlinkRefusal } from "./helpers/symlink.js";
import { createScopeFixture, type ScopeFixture } from "./helpers/scope-fixture.js";


const policyInput = vi.hoisted(() => ({ paths: 5, extensions: 5, registries: ["registry.npmjs.org:443"] as string[] | null }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
    const bytes = fs.readFileSync(...args);
    if (!(args[0] instanceof URL)) return bytes;
    if (args[0].pathname.endsWith("/config/governance/npm-registries.json")) {
      if (policyInput.registries === null) throw new Error("Registry policy unavailable");
      return JSON.stringify({ registries: policyInput.registries });
    }
    if (args[0].pathname.endsWith("/config/governance/low-risk-dev-dependencies.json")) {
      return JSON.stringify({ ...JSON.parse(String(bytes)), maxPathsPerRequest: policyInput.paths, maxApprovedExtensionsPerTask: policyInput.extensions });
    }
    return bytes;
  } };
});
const manifestBase = { name: "fixture", version: "1.0.0", devDependencies: {} as Record<string, string> };
type DependencyFixture = {
  manifest: typeof manifestBase & { dependencies?: Record<string, string>; scripts?: Record<string, string>; overrides?: Record<string, string> };
  lock: { name: string; version: string; lockfileVersion: number; packages: Record<string, Record<string, unknown>> };
};
const dependencyFixture = (): DependencyFixture => ({
  manifest: { ...manifestBase, devDependencies: { "@types/node": "22.0.0" } },
  lock: { name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: {
    "": { ...manifestBase, devDependencies: { "@types/node": "22.0.0" } },
    "node_modules/@types/node": { version: "22.0.0", dev: true, resolved: "https://registry.npmjs.org/@types/node/-/node-22.0.0.tgz",
      integrity: "sha512-" + Buffer.alloc(64, 1).toString("base64") },
  } },
});

const owner = { kind: "owner", sessionId: "owner" } as const;
const worker = { kind: "worker", sessionId: "worker" } as const;
const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

let fixture: ScopeFixture;
let directory: ScopeFixture["directory"], repo: ScopeFixture["repo"], db: ScopeFixture["db"];
let governance: ScopeFixture["governance"], runtime: ScopeFixture["runtime"], binding: ScopeFixture["binding"];
let packets: ScopeFixture["packets"], command: ScopeFixture["command"], candidate: ScopeFixture["candidate"];
let packet: ScopeFixture["packet"], extensions: ScopeFixture["extensions"], decide: ScopeFixture["decide"];
beforeEach(() => {
  fixture = createScopeFixture(policyInput);
  // Bound per test: the fixture owns a fresh database, run and candidate tree each time.
  ({ directory, repo, db, governance, runtime, binding, packets, command, candidate, packet, extensions, decide } = fixture);
});
afterEach(() => { fixture.dispose(); });

describe("task-local scope extensions for dependency policy", () => {
  const writeDependencies = (value = dependencyFixture()) => {
    const root = candidate().root;
    writeFileSync(join(root, "package.json"), JSON.stringify(value.manifest));
    writeFileSync(join(root, "package-lock.json"), JSON.stringify(value.lock));
    return root;
  };

  it("requires an owner decision for an exact listed devDependency and binds it to its checked bytes", () => {
    writeDependencies();
    expect(() => packet()).toThrow(/extension-pending/);
    const extension = extensions()[0]!;
    expect(extension.packages).toEqual([{ name: "@types/node", version: "22.0.0", matched: "@types/*" }]);
    expect(decide(extension.id).status).toBe("accepted");
    expect(packet().scope!.extensions).toHaveLength(1);
    const changed = dependencyFixture();
    changed.manifest.dependencies = { "runtime-package": "1.0.0" };
    writeDependencies(changed);
    expect(() => packet()).toThrow(/plan-change-required/);
    expect(extensions()).toHaveLength(1);
  });

  const renameDependency = (value: DependencyFixture, name: string, version: string) => {
    value.manifest.devDependencies = { [name]: version };
    value.lock.packages[""]!.devDependencies = { [name]: version };
    const entry = value.lock.packages["node_modules/@types/node"]!;
    delete value.lock.packages["node_modules/@types/node"];
    value.lock.packages["node_modules/" + name] = { ...entry, version };
  };
  const invalidDependencies: Array<[string, string, (value: DependencyFixture) => void]> = [
    ["production dependencies", "dev-dependencies-only", value => { value.manifest.dependencies = { "@types/node": "22.0.0" }; }],
    ["unlisted name", "dependency-not-listed", value => renameDependency(value, "unlisted-package", "1.0.0")],
    ["range", "dependency-version-not-exact", value => renameDependency(value, "@types/node", "^22.0.0")],
    ["tag", "dependency-version-not-exact", value => renameDependency(value, "@types/node", "latest")],
    ["install script", "dependency-install-script", value => { value.lock.packages["node_modules/@types/node"]!.hasInstallScript = true; }],
    ["missing integrity", "dependency-integrity", value => { delete value.lock.packages["node_modules/@types/node"]!.integrity; }],
    ["unlisted registry", "dependency-registry", value => { value.lock.packages["node_modules/@types/node"]!.resolved = "https://unlisted.example/package.tgz"; }],
    ["non-dev entry", "non-dev-lock-change", value => { delete value.lock.packages["node_modules/@types/node"]!.dev; }],
    ["scripts", "dev-dependencies-only", value => { value.manifest.scripts = { postinstall: "run-command" }; }],
    ["overrides", "dev-dependencies-only", value => { value.manifest.overrides = { "@types/node": "22.0.0" }; }],
    ["old lockfile", "lockfile-v3-only", value => { value.lock.lockfileVersion = 2; }],
    ["unrelated lock entry", "unrelated-lock-change", value => { value.lock.packages["node_modules/unrelated"] = { ...value.lock.packages["node_modules/@types/node"] }; }],
    ["lock version mismatch", "lock-version-mismatch", value => { value.lock.packages["node_modules/@types/node"]!.version = "23.0.0"; }],
  ];
  it.each(invalidDependencies)("requires a plan change for %s", (_name, rule, change) => {
    const value = dependencyFixture(); change(value); writeDependencies(value);
    expect(() => packet()).toThrow(new RegExp("plan-change-required: " + rule));
    expect(extensions()).toHaveLength(0);
  });

  it("accepts only the checked transitive dev entries and asks again for a new exact version", () => {
    const value = dependencyFixture();
    value.lock.packages["node_modules/@types/node"]!.dependencies = { "undici-types": "~6.1.0" };
    value.lock.packages["node_modules/undici-types"] = { ...value.lock.packages["node_modules/@types/node"], version: "6.1.0" };
    delete value.lock.packages["node_modules/undici-types"]!.dependencies;
    writeDependencies(value); expect(() => packet()).toThrow(/extension-pending/);
    expect(decide(extensions()[0]!.id).status).toBe("accepted"); packet();
    renameDependency(value, "@types/node", "23.0.0"); writeDependencies(value);
    expect(() => packet()).toThrow(/extension-pending/);
    expect(extensions()).toHaveLength(2);
  });

});
