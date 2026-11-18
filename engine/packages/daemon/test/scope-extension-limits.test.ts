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

describe("task-local scope extensions and their limits", () => {
  const writeDependencies = (value = dependencyFixture()) => {
    const root = candidate().root;
    writeFileSync(join(root, "package.json"), JSON.stringify(value.manifest));
    writeFileSync(join(root, "package-lock.json"), JSON.stringify(value.lock));
    return root;
  };
  it("limits the default task chain to five approved extensions", () => {
    const root = candidate().root;
    for (let index = 0; index < 5; index++) {
      writeFileSync(join(root, "src/new" + index + ".ts"), "new"); packet();
    }
    expect(extensions()).toHaveLength(5);
    writeFileSync(join(root, "src/over-cap.ts"), "new");
    expect(() => packet()).toThrow(/extension-cap/);
  });

  it("uses the configured registry allowlist and fails closed when it is unavailable", () => {
    writeDependencies();
    policyInput.registries = null;
    expect(() => packet()).toThrow(/plan-change-required/);
    policyInput.registries = ["packages.example:443"];
    expect(() => packet()).toThrow(/plan-change-required/);
    const value = dependencyFixture();
    value.lock.packages["node_modules/@types/node"]!.resolved = "https://packages.example/node.tgz";
    writeDependencies(value);
    expect(() => packet()).toThrow(/extension-pending/);
  });

  it("keeps non-npm lockfiles and owner policy files outside the fast path", () => {
    const root = candidate().root;
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9");
    expect(() => packet()).toThrow(/plan-change-required/);
    rmSync(join(root, "pnpm-lock.yaml"));
    mkdirSync(join(root, "engine/config/governance"), { recursive: true });
    writeFileSync(join(root, "engine/config/governance/low-risk-dev-dependencies.json"), '{"packages":["*"]}');
    expect(() => packet()).toThrow(/protected-path/);
  });

  it.each([
    ["src/other.ts", "other-task-scope"], ["outside.txt", "outside-write-paths"],
    ["docs/plans/new.md", "protected-path"], ["src/contracts/new.ts", "protected-path"],
    ["src/migrations/001.ts", "protected-path"], ["src/.env", "protected-path"],
    ["engine/config/governance/npm-registries.json", "protected-path"], ["engine/packages/daemon/src/domain/queue-repository.ts", "protected-path"],
  ])("rejects %s with the failing rule", (path, rule) => {
    const root = candidate().root;
    mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), "changed");
    expect(() => packet()).toThrow(new RegExp("plan-change-required: " + rule));
  });

  it("enforces both caps and uses owner-adjusted limits without changing the binding", () => {
    const root = candidate().root, digest = governance.getRun("run").bindingDigest;
    for (let index = 0; index < 6; index++) writeFileSync(join(root, "src/extra" + index + ".ts"), "new");
    expect(() => packet()).toThrow(/path-cap/);
    policyInput.paths = 6;
    expect(packet().scope!.extensions).toHaveLength(1);
    policyInput.extensions = 1;
    writeFileSync(join(root, "src/last.ts"), "new");
    expect(() => packet()).toThrow(/extension-cap/);
    policyInput.extensions = 2;
    expect(packet().scope!.extensions).toHaveLength(2);
    expect(governance.getRun("run").bindingDigest).toBe(digest);
  });

  it("rechecks foreign extensions when an owner decides competing requests", () => {
    writeFileSync(join(candidate().root, "src/neighbor.ts"), "first task");
    writeFileSync(join(candidate("other").root, "src/neighbor.ts"), "other task");
    expect(() => packet()).toThrow(/extension-pending/);
    expect(() => packet("other")).toThrow(/extension-pending/);
    const foreign = governance.scopeForTask("run", "other").extensions[0]!;
    expect(decide(foreign.id).status).toBe("accepted");
    expect(() => decide(extensions()[0]!.id)).toThrow(/other-task-scope/);
    expect(governance.getApproval(extensions()[0]!.id)!.state).toBe("pending");
  });

  it.skipIf(symlinkRefusal !== null)("canonicalizes approved aliases and rejects traversal or escaping aliases", () => {
    const root = candidate().root;
    symlinkSync("neighbor.ts", join(root, "src/alias.ts"));
    const evidence = (path: string) => ({ root, candidateDigest: hashBytes(path), files: ["src/owned.ts"],
      changes: [{ path, before: null, after: Buffer.from("alias") }] });
    expect(() => governance.stageCandidateScope("run", "task", evidence("src/alias.ts"))).toThrow(/extension-pending/);
    expect(decide(extensions()[0]!.id).status).toBe("accepted");
    expect(governance.stageCandidateScope("run", "task", evidence("src/alias.ts")).extensions).toHaveLength(1);
    expect(() => governance.stageCandidateScope("run", "task", evidence("../outside"))).toThrow(/path-escape/);
    symlinkSync(directory, join(root, "src/escape"));
    expect(() => governance.stageCandidateScope("run", "task", evidence("src/escape/control.db"))).toThrow(/path-escape/);
  });


  const control = () => teamControlRoutes(governance, {
    credentials: { ownerToken: "scope-owner", workers: [{ token: "scope-worker", sessionId: "worker", runId: "run" }] },
    resolveBinding: () => binding,
  }, []);
  const http = (app: ReturnType<typeof control>, path: string, body?: unknown, token = "scope-owner") =>
    app.request("http://localhost/runs/run/" + path, { method: body === undefined ? "GET" : "POST",
      headers: { Host: "localhost", Authorization: "Bearer " + token, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });

  it("surfaces a pending extension and admits it once the owner decides", () => {
    writeFileSync(join(candidate().root, "src/neighbor.ts"), "pending");
    expect(() => packet()).toThrow(/extension-pending/);
    const extension = extensions()[0]!;
    expect(governance.scopeForTask("run", "task")).toMatchObject({
      extensions: [{ classification: "owner-decision", state: "pending" }],
    });
    const decision = () => command(extension.id, { approvalVersion: 1, decision: "approved", expectedChainHead: extension.expectedChainHead });
    const stale = decision(); (stale.payload as Record<string, unknown>).expectedChainHead = "stale";
    expect(() => governance.decideApproval(stale, owner, binding)).toThrow();
    expect(governance.getApproval(extension.id)!.state).toBe("pending");
    expect(governance.decideApproval(decision(), owner, binding).status).toBe("accepted");
    // A second decision on the same extension is a state conflict, not a replay.
    expect(() => governance.decideApproval(decision(), owner, binding)).toThrow(/state conflict/);
    expect(packet().scope!.extensions).toHaveLength(1);
  });

  it("returns the specific plan-change rule without acknowledging a refused decision", () => {
    writeDependencies(); expect(() => packet()).toThrow(/extension-pending/);
    const extension = extensions()[0]!;
    policyInput.paths = 1;
    expect(() => governance.decideApproval(command(extension.id, {
      approvalVersion: 1, decision: "approved", expectedChainHead: extension.expectedChainHead,
    }), owner, binding)).toThrow(/path-cap/);
    expect(governance.getApproval(extension.id)!.state).toBe("pending");
  });

});
