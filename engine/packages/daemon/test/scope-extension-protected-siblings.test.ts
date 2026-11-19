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
describe("task-local scope extensions and the protected sibling files", () => {

  it.each(["Cargo.toml", "Cargo.lock", "pyproject.toml", "poetry.lock", "uv.lock", "requirements.txt",
    "requirements-dev.txt", "go.mod", "go.sum", "Gemfile", "Gemfile.lock", "composer.json", "composer.lock",
    "pom.xml", "build.gradle", "pnpm-workspace.yaml", ".yarnrc.yml", ".travis.yml", "appveyor.yml",
    "bitbucket-pipelines.yml", ".drone.yml", "drone.yml", "cloudbuild.yaml", ".husky/pre-commit"])(
    "requires a plan change for the protected sibling %s", name => {
      const root = candidate().root, path = join(root, "src", name);
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "configuration");
      expect(() => packet()).toThrow(/plan-change-required: protected-path/);
      expect(extensions()).toHaveLength(0);
    });

});
