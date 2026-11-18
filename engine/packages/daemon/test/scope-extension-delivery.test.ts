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

describe("task-local scope extensions at launch and delivery", () => {
  it("includes approved extensions in the live write-conflict check before launch", () => {
    writeFileSync(join(candidate().root, "src/neighbor.ts"), "first task");
    expect(() => packet()).toThrow(/extension-pending/);
    expect(decide(extensions()[0]!.id).status).toBe("accepted");
    const assignment = { ...governance.findTask("run", "other")!.assignment, paths: ["src/neighbor.ts"] };
    const context = { runId: "run", binding, role: "implementer" } as Parameters<WorkflowRuntime["admitForLaunch"]>[1]["context"];
    expect(() => runtime.admitForLaunch("run", { attemptId: "attempt", worker: "ma-worker1",
      assignment, context, outputs: [], permissions: [],
    })).toThrow(/Dependency graph refused/);
  });

  it.skipIf(symlinkRefusal !== null)("returns a scope refusal for an escaping symlink at real staging", () => {
    symlinkSync(directory, join(candidate().root, "src/escape"));
    expect(() => packet()).toThrow(/plan-change-required/);
  });


  it.skipIf(symlinkRefusal !== null)("compares canonical foreign assignment paths, not just their alias names", () => {
    symlinkSync("neighbor.ts", join(repo, "src/alias-owned.ts"));
    expect(governance.createTask(command("alias-owner", { assignment: { taskId: "alias-owner", role: "implementer",
      paths: ["src/alias-owned.ts"], dependencies: [] }, outputs: [], permissions: [],
      sourceSession: "lead@rig", destinationSession: "alias@rig", body: "Own this alias" }), binding).status).toBe("accepted");
    expect(() => governance.stageCandidateScope("run", "task", { root: repo, candidateDigest: hashBytes("alias-conflict"),
      files: ["src/owned.ts"], changes: [{ path: "src/neighbor.ts", before: Buffer.from("before"), after: Buffer.from("after") }],
    })).toThrow(/other-task-scope/);
  });

  it("lets a lead's own proposal stay outside its assignment scope", () => {
    // C3 — a lead's candidate holds the proposal it wrote, and its assignment paths are the
    // run's scope rather than the proposal's location. Re-staging that candidate (the lead's
    // revision attempt) must not read the proposal as an out-of-scope write.
    expect(governance.createTask(command("lead", { assignment: { taskId: "lead", role: "lead", paths: ["src"], dependencies: [] },
      outputs: [], permissions: [], sourceSession: "owner", destinationSession: "lead@rig", body: "Propose the work" }), binding).status).toBe("accepted");
    const root = candidate("lead").root;
    writeFileSync(join(root, "lead-proposal.json"), JSON.stringify({ tasks: [{ taskId: "task-9", seat: "task@rig",
      paths: ["src/owned.ts"], dependencies: [], body: "Implement the owned file" }] }));
    expect(packet("lead").manifest.some(file => file.path === "lead-proposal.json")).toBe(true);
    // U6 — the escalation is the lead's second management file, and a candidate that holds the
    // question it is waiting on must stage the same way.
    writeFileSync(join(root, "lead-escalation.json"), JSON.stringify({ question: "Which scope?",
      options: ["Keep src", "Widen to lib"] }));
    expect(packet("lead").manifest.some(file => file.path === "lead-escalation.json")).toBe(true);
    writeFileSync(join(root, "lead-roster.json"), JSON.stringify({ seats: [{ role: "implementer", client: "codex" }] }));
    expect(packet("lead").manifest.some(file => file.path === "lead-roster.json")).toBe(true);
    expect(governance.scopeForTask("run", "lead").extensions).toHaveLength(0);
    // The exemption is those paths for that one role: any other out-of-scope write by the
    // same lead still refuses.
    writeFileSync(join(root, "other.json"), "{}");
    expect(() => packet("lead")).toThrow(/plan-change-required: outside-write-paths/);
  });

  it.each(["lead", "implementer"] as const)("does not exempt a roster outside the exact lead path for %s", role => {
    const taskId = role === "lead" ? "lead" : "task";
    if (role === "lead") {
      expect(governance.createTask(command(taskId, { assignment: { taskId, role, paths: ["src"], dependencies: [] },
        outputs: [], permissions: [], sourceSession: "owner", destinationSession: "lead@rig", body: "Manage the work" }), binding).status).toBe("accepted");
    }
    const root = candidate(taskId).root;
    const path = role === "lead" ? "unapproved/lead-roster.json" : "lead-roster.json";
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), "{}");
    expect(() => packet(taskId)).toThrow(/plan-change-required: outside-write-paths/);
  });

  it("refuses an unregistered writing assignment before materializing its candidate", () => {
    const context = { runId: "run", binding, role: "implementer" } as Parameters<WorkflowRuntime["admitForLaunch"]>[1]["context"];
    expect(() => runtime.admitForLaunch("run", { attemptId: "unregistered", worker: "ma-worker1",
      assignment: { taskId: "unregistered", role: "implementer", paths: ["lib/output.ts"], dependencies: [] },
      context, outputs: [], permissions: [],
    })).toThrow(/Task not found/);
    expect(existsSync(join(directory, "assignments/ma-worker1/run-unregistered"))).toBe(false);
  });


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
