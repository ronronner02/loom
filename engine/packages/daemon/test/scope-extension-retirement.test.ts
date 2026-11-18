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

describe("task-local scope extensions and their retirement", () => {
  it("retires stale pending requests and reissues an exact candidate against the current head", () => {
    const root = candidate().root, original = readFileSync(join(root, "src/neighbor.ts"));
    writeFileSync(join(root, "src/neighbor.ts"), "candidate A");
    expect(() => packet()).toThrow(/extension-pending/);
    const previous = extensions()[0]!;
    writeFileSync(join(root, "src/neighbor.ts"), original);
    writeFileSync(join(root, "src/types.ts"), "candidate B");
    const next = packet();
    expect(next.scope!.extensions.find(extension => extension.id === previous.id)!.state).toBe("invalidated");
    expect(() => decide(previous.id, "approved", previous.expectedChainHead)).toThrow(/conflict/);
    rmSync(join(root, "src/types.ts"));
    writeFileSync(join(root, "src/neighbor.ts"), "candidate A");
    expect(() => packet()).toThrow(/extension-pending/);
    const pending = extensions().filter(extension => extension.state === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).not.toBe(previous.id);
    expect(decide(pending[0]!.id).status).toBe("accepted");
    expect(packet().scope!.extensions.some(extension => extension.state === "pending")).toBe(false);
  });

  it("retires a pending request without a replacement and notifies scope readers", async () => {
    const root = candidate().root, original = readFileSync(join(root, "src/neighbor.ts"));
    writeFileSync(join(root, "src/neighbor.ts"), "pending neighbor");
    expect(() => packet()).toThrow(/extension-pending/);
    const previous = extensions()[0]!, version = governance.getApproval(previous.id)!.entityVersion;
    writeFileSync(join(root, "src/neighbor.ts"), original);
    const current = packet().scope!;
    expect(current.chainHead).toBe(previous.expectedChainHead);
    expect(current.extensions).toMatchObject([{ id: previous.id, state: "invalidated" }]);
    expect(governance.getApproval(previous.id)!.entityVersion).toBe(version + 1);
    expect(JSON.stringify(db.prepare("SELECT * FROM events ORDER BY rowid DESC LIMIT 1").get())).toContain("scope-extension.invalidated");
    expect(governance.scopeForTask("run", "task").extensions).toMatchObject([{ id: previous.id, state: "invalidated" }]);
    const stale = command(previous.id, { approvalVersion: version + 1, decision: "approved", expectedChainHead: previous.expectedChainHead });
    expect(() => governance.decideApproval(stale, owner, binding)).toThrow(/state conflict/);
    ({ db, governance, runtime, candidate, packet, extensions, decide } = fixture.open());
    expect(extensions()).toMatchObject([{ id: previous.id, state: "invalidated" }]);
    writeFileSync(join(candidate().root, "src/neighbor.ts"), "pending neighbor");
    expect(() => packet()).toThrow(/extension-pending/);
    const pending = extensions().filter(extension => extension.state === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).not.toBe(previous.id);
  });

  it("preserves the bounded structured reason in review and delivery metadata", () => {
    const reason = "Worker explanation ".repeat(300);
    db.prepare("UPDATE team_queue_authority SET evidence_json = ? WHERE run_id = 'run' AND task_id = 'task'")
      .run(JSON.stringify({ scopeExtensionReason: reason }));
    writeFileSync(join(candidate().root, "src/types.ts"), "new sibling");
    const reviewed = packet();
    expect(reviewed.scope!.extensions[0]!.reason).toBe(reason.slice(0, 4096));
    expect(runtime.reviewProgress("run", "task").delivery).toMatchObject({ scope: reviewed.scope });
  });

  it("holds an existing neighboring-file edit for an owner extension decision", () => {
    writeFileSync(join(candidate().root, "src/neighbor.ts"), "export const changed = true;\n");
    expect(() => packet()).toThrow(/extension-pending/);
  });
});
