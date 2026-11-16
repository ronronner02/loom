import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectWorkerLauncher } from "../src/adapters/direct-worker-launch.js";
import { readSupervisorExit } from "../src/adapters/child-process-supervisor.js";
import { RestrictedWorkerLauncher, type WorkerLaunchControl } from "../src/adapters/worker-launch.js";
import { agentTurnOutputPaths, readAgentTurnLastMessage, writeAgentTurnPrompt } from "../src/domain/agent-turn.js";
import type { ContextManifest } from "../src/integrations/framework/context-manifest.js";
import type { WorkerEvent } from "../src/contracts/worker-events.js";
import { commandAssessor } from "../src/domain/intake-assessor.js";
import { createDaemon } from "../src/startup.js";
import { MULTI_AGENT_HOME } from "../src/data-paths.js";
import { unisolatedWorkerRoots } from "../src/domain/unisolated-roots.js";
import { observeIdentity } from "../src/domain/process-termination.js";
import type { ManagedAttempt } from "../src/domain/runtime-adapter.js";

const longReply = JSON.stringify({ status: "needs-decision", evidence: "A reviewed detail. ".repeat(80), question: "Which behavior should remain?" });

describe("Gemini native desktop execution", () => {
  let root: string, entry: string;
  const active: Array<{ launcher: DirectWorkerLauncher; attemptId: string }> = [];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gemini-native-"));
    entry = join(root, "gemini.mjs");
    writeFileSync(entry, `import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2), prompt = readFileSync(0, 'utf8');
writeFileSync(${JSON.stringify(join(root, "observed.json"))}, JSON.stringify({ args, prompt, cwd: process.cwd(),
  noRelaunch: process.env.GEMINI_CLI_NO_RELAUNCH, nodeMode: process.env.ELECTRON_RUN_AS_NODE }));
const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
const session = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1];
if (args.includes('text')) {
  console.log('{"matched":["fixture-rule"]}');
} else {
  emit({ type: 'init', session_id: session, model: 'fixture-model' });
  emit({ type: 'message', role: 'user', content: prompt });
  emit({ type: 'message', role: 'assistant', content: 'Checking the file.', delta: true });
  emit({ type: 'tool_use', tool_id: 'read-1', tool_name: 'read_file', parameters: { file_path: 'input.txt' } });
  if (prompt === 'Wait for cancellation.') setInterval(() => {}, 1000);
  else {
    emit({ type: 'tool_result', tool_id: 'read-1', status: 'success', output: 'PRIVATE TOOL BODY' });
    const answer = prompt === 'Return the long review.' ? ${JSON.stringify(longReply)} : 'Fixture complete.';
    emit({ type: 'message', role: 'assistant', content: answer.slice(0, 300), delta: true });
    emit({ type: 'message', role: 'assistant', content: answer.slice(300), delta: true });
    emit({ type: 'result', status: 'success', stats: { input: 80, cached: 20, output_tokens: 10,
      models: { 'fixture-model': {} } } });
  }
}
`);
  });
  afterEach(async () => {
    for (const { launcher, attemptId } of active.splice(0)) await launcher.cancel(attemptId);
    rmSync(root, { recursive: true, force: true });
  });
  function attempt(id: string, prompt: string, role = "implementer"): ManagedAttempt {
    const context = { runId: "run", assignment: { taskId: "task", role, paths: [], dependencies: [] },
      client: "gemini", files: [], mutableStateRoot: root, projection: { attemptId: id },
      binding: { policyFingerprint: "sha256:" + "b".repeat(64) }, generatedHash: "sha256:" + "a".repeat(64),
    } as ContextManifest;
    writeAgentTurnPrompt(context, prompt);
    return { attemptId: id, deadline: Date.now() + 60_000, context };
  }

  it("launches a JavaScript client without a shell, records sidecars and resumes the exact session", async () => {
    const events: WorkerEvent[] = [];
    const launcher = new DirectWorkerLauncher({ resolveAssignedTree: () => root, executablePath: () => entry,
      onEvent: (_facts, event) => events.push(event) });
    const first = await launcher.launch({ client: "gemini", attempt: attempt("first", "PRIVATE OWNER PROMPT") });
    active.push({ launcher, attemptId: "first" });
    expect(first, JSON.stringify(first)).toMatchObject({ ok: true, resumeType: "gemini_id" });
    if (!first.ok) throw new Error(first.error);
    await vi.waitFor(() => expect(readSupervisorExit(root, "first")).toMatchObject({ provider: "gemini", exitCode: 0, acknowledged: true }));
    const paths = agentTurnOutputPaths(root, "first");
    expect(readFileSync(paths.lastMessage, "utf8")).toBe("Fixture complete.");
    expect(JSON.parse(readFileSync(paths.usage, "utf8"))).toMatchObject({ client: "gemini", nativeSessionId: first.resumeToken,
      mode: "turn", counts: { inputTokens: 80, cacheReadInputTokens: 20, outputTokens: 10, reasoningOutputTokens: null } });
    expect(JSON.parse(readFileSync(join(paths.directory, "progress.json"), "utf8"))).toMatchObject({ status: "completed",
      blocks: [{ text: "Checking the file.", complete: true }, { text: "Fixture complete.", complete: true }] });
    const observed = JSON.parse(readFileSync(join(root, "observed.json"), "utf8"));
    expect(observed).toMatchObject({ prompt: "PRIVATE OWNER PROMPT", cwd: root, noRelaunch: "1", nodeMode: "1" });
    expect(observed.args).toContain("--skip-trust");
    expect(observed.args[observed.args.indexOf("--include-directories") + 1]).toBe(paths.directory);
    expect(observed.args).not.toContain("PRIVATE OWNER PROMPT");
    expect(JSON.stringify(events.filter(event => event.type === "message.agent"))).not.toContain("PRIVATE OWNER PROMPT");
    expect(events).toContainEqual(expect.objectContaining({ provider: "gemini", type: "turn.completed", status: "completed" }));
    const reviewer = attempt("second", "Continue.", "reviewer");
    reviewer.evidenceDirectory = join(root, "prior-evidence"); mkdirSync(reviewer.evidenceDirectory);
    const resumed = await launcher.launch({ client: "gemini", attempt: reviewer,
      continueSessionId: first.resumeToken });
    active.push({ launcher, attemptId: "second" });
    expect(resumed).toMatchObject({ ok: true, resumeToken: first.resumeToken, resumeType: "gemini_id" });
    await vi.waitFor(() => expect(readSupervisorExit(root, "second")?.exitCode).toBe(0));
    const next = JSON.parse(readFileSync(join(root, "observed.json"), "utf8"));
    expect(next.args.slice(-2)).toEqual(["--resume", first.resumeToken]);
    expect(next.args).toContain("plan"); expect(next.args).not.toContain("yolo");
    expect(next.args[next.args.indexOf("--include-directories") + 1]).toBe(reviewer.evidenceDirectory);
    expect(JSON.parse(readFileSync(agentTurnOutputPaths(root, "second").usage, "utf8"))).toMatchObject({ resumed: true, client: "gemini" });
  });

  it("retains a reviewer report longer than an event summary for the completion reader", async () => {
    const launcher = new DirectWorkerLauncher({ resolveAssignedTree: () => root, executablePath: () => entry });
    active.push({ launcher, attemptId: "long-review" });
    expect(await launcher.launch({ client: "gemini", attempt: attempt("long-review", "Return the long review.", "reviewer") }))
      .toMatchObject({ ok: true });
    await vi.waitFor(() => expect(readSupervisorExit(root, "long-review")?.exitCode).toBe(0));
    expect(readAgentTurnLastMessage(root, "long-review")).toBe(longReply);
  });

  it("cancels a live Gemini child and settles its in-flight activity", async () => {
    const launcher = new DirectWorkerLauncher({ resolveAssignedTree: () => root, executablePath: () => entry });
    active.push({ launcher, attemptId: "cancel" });
    expect(await launcher.launch({ client: "gemini", attempt: attempt("cancel", "Wait for cancellation.") })).toMatchObject({ ok: true });
    const stopped = await launcher.cancel("cancel");
    expect(stopped).toMatchObject({ provider: "gemini", acknowledged: true });
    expect(await observeIdentity(stopped!.identity)).toBe("dead");
    expect(readSupervisorExit(root, "cancel")).not.toBeNull();
    const records = readFileSync(agentTurnOutputPaths(root, "cancel").activity, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(records.map(record => record.status)).toEqual(["running", "aborted"]);
  });

  it("rejects the deferred hardened launcher before privileged control operations", async () => {
    const control = { preflight: vi.fn(), start: vi.fn(), observe: vi.fn(), quiesce: vi.fn(), record: vi.fn() };
    const launcher = new RestrictedWorkerLauncher(control as WorkerLaunchControl);
    expect(await launcher.launch({ client: "gemini", attempt: attempt("restricted", "Read only.") }))
      .toEqual({ ok: false, error: "Gemini requires the native direct-worker launcher" });
    for (const method of Object.values(control)) expect(method).not.toHaveBeenCalled();
  });

  it("uses the same JavaScript entry for a read-only intake assessment", async () => {
    const assess = commandAssessor({ resolve: () => ({ path: process.execPath, args: [entry] }) });
    const result = await assess({ client: "gemini", model: "fixture-model", cwd: root,
      rules: [{ name: "fixture-rule", instruction: "Choose the fixture item.", enabled: true }],
      candidate: { kind: "issue", title: "Fixture", body: "Item body", author: "fixture", url: "https://example.invalid/item" } });
    expect(result).toEqual(["fixture-rule"]);
    const observed = JSON.parse(readFileSync(join(root, "observed.json"), "utf8"));
    expect(observed).toMatchObject({ noRelaunch: "1", nodeMode: "1" });
    expect(observed.args).toContain("plan"); expect(observed.args).toContain("--skip-trust");
    expect(observed.prompt).toContain("<item>");
  });

  it("dispatches a selected Gemini lead through daemon startup and records its stopped attempt", async () => {
    const repository = join(root, "project"); mkdirSync(repository);
    const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { stdio: "ignore" });
    git("init", "-q", "--initial-branch=main");
    writeFileSync(join(repository, "plan.md"), "Fixture plan.\n");
    git("add", "plan.md"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Fixture");
    const daemon = await createDaemon({ dbPath: ":memory:", managedMode: true, workersIsolation: "none", webUiEnabled: false,
      directLaunchExecutable: client => client === "gemini" ? entry : undefined,
      teamControl: { credentials: { ownerToken: "fixture-owner" }, planWorktreeRoot: () => join(root, "wt") } });
    const request = (path: string, body: unknown) => daemon.app.request("/api/team-control" + path, {
      method: "POST", headers: { Authorization: "Bearer fixture-owner", "Content-Type": "application/json" }, body: JSON.stringify(body),
    }, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
    try {
      const created = await request("/teams", { repository, seats: [{ role: "lead", client: "gemini", model: "fixture-model" },
        { role: "implementer", client: "gemini" }] });
      expect(created.status, await created.clone().text()).toBe(201);
      const { team } = await created.json();
      const started = await request("/runs", { rig: team.id, goal: "Explain the existing plan." });
      expect(started.status, await started.clone().text()).toBe(201);
      const { runId } = await started.json();
      const roots = unisolatedWorkerRoots(MULTI_AGENT_HOME), state = join(roots.workerRoot, roots.worker, "scratch");
      await vi.waitFor(async () => {
        await daemon.deps.attemptCompletion!.sweep();
        const attempts = (daemon.db.prepare("SELECT id FROM team_attempts WHERE run_id = ?").all(runId) as Array<{ id: string }>)
          .map(row => daemon.deps.teamGovernance!.getAttempt(row.id)!);
        expect(attempts).toHaveLength(1);
        expect(attempts[0]).toMatchObject({ provider: "gemini", role: "lead", state: "stopped" });
        expect(readSupervisorExit(state, attempts[0]!.id)).toMatchObject({ provider: "gemini", exitCode: 0 });
        expect(daemon.deps.attemptTelemetry!.read(attempts[0]!).usage).toMatchObject({ status: "available", model: "fixture-model", inputTokens: 80 });
      }, { timeout: 10_000 });
      const observed = JSON.parse(readFileSync(join(root, "observed.json"), "utf8"));
      expect(observed.prompt).toContain("Explain the existing plan.");
      expect(observed.args).toContain("fixture-model");
      expect(daemon.db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      daemon.deps.attemptCompletion?.stop(); daemon.contextMonitor.stop(); daemon.eventLoopMonitor.stop();
      const native = daemon.deps.managedLaunch?.launcher as DirectWorkerLauncher | undefined;
      for (const row of daemon.db.prepare("SELECT id FROM team_attempts").all() as Array<{ id: string }>) await native?.cancel(row.id);
      daemon.db.close();
    }
  });
});
