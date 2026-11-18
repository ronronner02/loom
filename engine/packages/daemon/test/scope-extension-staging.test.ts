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

describe("task-local scope extensions at candidate staging", () => {
  it.each(["src/.env.local", "src/.github/workflows/build.yml", "src/contracts/auth.ts"])(
    "keeps project-wide protected files restricted inside an assigned parent: %s", path => {
      const run = governance.getRun("run"), task = governance.findTask("run", "task")!;
      const project = { ...run, binding: { ...run.binding, readPaths: ["."], writePaths: ["."] } };
      const assigned = { ...task, assignment: { ...task.assignment, paths: ["src"] } };
      expect(() => new ScopeExtensions(db).stage(project, assigned, {
        root: candidate().root, candidateDigest: hashBytes(path), files: [path],
        changes: [{ path, before: null, after: Buffer.from("fixture content") }],
      }, "2026-10-28T08:00:00.000Z")).toThrow(/protected-path/);
    });

  it("approves only this task's extension and includes its scope in review and delivery", () => {
    const before = governance.getRun("run"), otherScope = governance.scopeForTask("run", "other");
    const implementation = governance.getApproval("implementation");
    writeFileSync(join(candidate().root, "src/neighbor.ts"), "changed\n");
    expect(() => packet()).toThrow(/extension-pending/);
    expect(extensions()).toHaveLength(1);
    expect(() => packet()).toThrow(/extension-pending/);
    expect(extensions()).toHaveLength(1);
    writeFileSync(join(candidate("other").root, "src/other.ts"), "unrelated task\n");
    expect(packet("other").scope).toEqual(otherScope);
    expect(decide(extensions()[0]!.id).status).toBe("accepted");
    const approved = packet();
    expect(approved.scope!.extensions[0]).toMatchObject({ state: "approved", automatic: false, reason: "no reason given" });
    expect(approved.scope!.scopeDigest).not.toBe(otherScope.scopeDigest);
    expect(runtime.reviewProgress("run", "task").delivery).toMatchObject({ scope: approved.scope });
    const after = governance.getRun("run");
    expect([after.binding, after.bindingDigest, after.activeMs, after.state]).toEqual([before.binding, before.bindingDigest, before.activeMs, before.state]);
    expect(governance.getApproval("implementation")).toEqual(implementation);
    expect(governance.scopeForTask("run", "other")).toEqual(otherScope);
    expect(db.prepare("SELECT count(*) AS n FROM team_attempts").get()).toEqual({ n: 0 });
  });

  it("auto-records a new sibling, but not a new file in an unowned directory", () => {
    const root = candidate().root;
    writeFileSync(join(root, "src/types.ts"), "export type Value = string;\n");
    const first = packet();
    expect(first.scope!.extensions).toMatchObject([{ automatic: true, state: "approved",
      paths: [{ path: "src/types.ts", operation: "create" }] }]);
    mkdirSync(join(root, "lib"));
    writeFileSync(join(root, "lib/types.ts"), "export type Value = number;\n");
    expect(() => packet()).toThrow(/extension-pending/);
    expect(extensions()).toHaveLength(2);
  });

  it("stages an owned deletion and holds an unowned deletion for a decision", () => {
    const root = candidate().root;
    rmSync(join(root, "src/owned.ts"));
    expect(packet().manifest.some(file => file.path === "src/owned.ts")).toBe(false);
    rmSync(join(root, "src/neighbor.ts"));
    expect(() => packet()).toThrow(/extension-pending/);
    expect(decide(extensions()[0]!.id).status).toBe("accepted");
    expect(packet().manifest.some(file => file.path === "src/neighbor.ts")).toBe(false);
  });

  it("preserves rejection across restart and unrelated candidate changes", () => {
    const root = candidate().root;
    writeFileSync(join(root, "src/neighbor.ts"), "rejected\n");
    expect(() => packet()).toThrow(/extension-pending/);
    expect(decide(extensions()[0]!.id, "rejected").status).toBe("accepted");
    ({ db, governance, runtime, candidate, packet, extensions, decide } = fixture.open());
    expect(() => packet()).toThrow(/extension-rejected/);
    writeFileSync(join(root, "src/owned.ts"), "unrelated new bytes\n");
    expect(() => packet()).toThrow(/extension-rejected/);
    expect(extensions()).toHaveLength(1);
    writeFileSync(join(root, "src/neighbor.ts"), "new evidence\n");
    expect(() => packet()).toThrow(/extension-pending/);
    expect(extensions()).toHaveLength(2);
  });

  it("conflicts on a stale extension head without changing the pending decision", () => {
    const root = candidate().root;
    writeFileSync(join(root, "src/neighbor.ts"), "pending\n");
    expect(() => packet()).toThrow(/extension-pending/);
    const pending = extensions()[0]!;
    expect(() => decide(pending.id, "approved", "sha256:stale")).toThrow(/conflict/);
    expect(governance.getApproval(pending.id)!.state).toBe("pending");
    expect(decide(pending.id).status).toBe("accepted");
  });

  it("invalidates pending extensions on plan-byte drift", () => {
    writeFileSync(join(candidate().root, "src/neighbor.ts"), "pending\n");
    expect(() => packet()).toThrow(/extension-pending/);
    writeFileSync(join(repo, "plan.md"), "new plan bytes");
    expect(() => governance.stageCandidateScope("run", "task", {
      root: repo, candidateDigest: hashBytes("changed"), files: [], changes: [],
    })).toThrow(/plan-digest/);
    expect(extensions()[0]!.state).toBe("invalidated");
    expect(governance.getRun("run").state).toBe("invalidated");
  });


  const writeDependencies = (value = dependencyFixture()) => {
    const root = candidate().root;
    writeFileSync(join(root, "package.json"), JSON.stringify(value.manifest));
    writeFileSync(join(root, "package-lock.json"), JSON.stringify(value.lock));
    return root;
  };

  it("uses the same scope checks in the snapshot lane", () => {
    rmSync(join(repo, ".git"), { recursive: true });
    git(repo, "init", "--quiet", "--initial-branch=main");
    const root = candidate().root;
    writeFileSync(join(root, "src/types.ts"), "new sibling");
    expect(packet().scope!.extensions[0]!.automatic).toBe(true);
    writeFileSync(join(root, "src/neighbor.ts"), "pending neighbor");
    expect(() => packet()).toThrow(/extension-pending/);
  });

  it("does not carry approved extensions into a new binding", () => {
    writeFileSync(join(candidate().root, "src/types.ts"), "new sibling"); packet();
    const next = { ...binding, planDigest: hashBytes("new plan") };
    writeFileSync(join(repo, "plan.md"), "new plan");
    governance.createRun({ id: "next", rigId: "rig", binding: next });
    const request = (actionId: string, payload: unknown) => ({ ...command(actionId, payload), runId: "next",
      expectedEntityVersion: governance.getRun("next").entityVersion });
    governance.requestApproval(request("next-implementation", { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest: hashBinding(next) }, targetDigest: hashBinding(next), expiresAt: "9999-01-01T00:00:00.000Z" }), owner);
    expect(governance.decideApproval(request("next-implementation", { approvalVersion: 1, decision: "approved" }), owner, next).status).toBe("accepted");
    expect(governance.createTask(request("task", { assignment: governance.findTask("run", "task")!.assignment,
      outputs: [], permissions: [], sourceSession: "lead@rig", destinationSession: "next@rig", body: "Same assignment, new binding" }), next).status).toBe("accepted");
    expect(governance.scopeForTask("next", "task").extensions).toEqual([]);
  });

});
