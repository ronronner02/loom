import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectWorkerLauncher } from "../src/adapters/direct-worker-launch.js";
import { readSupervisorExit } from "../src/adapters/child-process-supervisor.js";
import { agentTurnOutputPaths, readAgentTurnLastMessage, writeAgentTurnPrompt } from "../src/domain/agent-turn.js";
import { commandAssessor } from "../src/domain/intake-assessor.js";
import { observeIdentity } from "../src/domain/process-termination.js";
import type { ContextManifest } from "../src/integrations/framework/context-manifest.js";
import type { ManagedAttempt } from "../src/domain/runtime-adapter.js";
import type { WorkerEvent } from "../src/contracts/worker-events.js";

/**
 * A Gemini turn, end to end through the launcher and the supervisor.
 *
 * The stub is a JavaScript entry, which is the shape the installed client has: it is started as
 * this process's Node, given its prompt on stdin, and answers in the client's own stream-json.
 * What is proved here is the transport and the reading of that stream, not the client's model.
 */
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
  noRelaunch: process.env.GEMINI_CLI_NO_RELAUNCH, nodeMode: process.env.ELECTRON_RUN_AS_NODE,
  proxy: process.env.HTTPS_PROXY ?? null }));
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
    expect(JSON.parse(readFileSync(join(paths.directory, "progress.json"), "utf8"))).toMatchObject({ status: "completed" });
    const observed = JSON.parse(readFileSync(join(root, "observed.json"), "utf8"));
    expect(observed).toMatchObject({ prompt: "PRIVATE OWNER PROMPT", cwd: root, noRelaunch: "1", nodeMode: "1" });
    expect(observed.args).toContain("--skip-trust");
    expect(observed.args[observed.args.indexOf("--include-directories") + 1]).toBe(paths.directory);
    // The owner's prompt reaches the client on stdin, never in its command line.
    expect(observed.args).not.toContain("PRIVATE OWNER PROMPT");
    expect(JSON.stringify(events.filter(event => event.type === "message.agent"))).not.toContain("PRIVATE OWNER PROMPT");
    expect(events).toContainEqual(expect.objectContaining({ provider: "gemini", type: "turn.completed", status: "completed" }));
    const reviewer = attempt("second", "Continue.", "reviewer");
    reviewer.evidenceDirectory = join(root, "prior-evidence"); mkdirSync(reviewer.evidenceDirectory);
    const resumed = await launcher.launch({ client: "gemini", attempt: reviewer, continueSessionId: first.resumeToken });
    active.push({ launcher, attemptId: "second" });
    expect(resumed).toMatchObject({ ok: true, resumeToken: first.resumeToken, resumeType: "gemini_id" });
    await vi.waitFor(() => expect(readSupervisorExit(root, "second")?.exitCode).toBe(0));
    const next = JSON.parse(readFileSync(join(root, "observed.json"), "utf8"));
    expect(next.args.slice(-2)).toEqual(["--resume", first.resumeToken]);
    expect(next.args).toContain("plan"); expect(next.args).not.toContain("yolo");
    expect(next.args[next.args.indexOf("--include-directories") + 1]).toBe(reviewer.evidenceDirectory);
    expect(JSON.parse(readFileSync(agentTurnOutputPaths(root, "second").usage, "utf8"))).toMatchObject({ resumed: true, client: "gemini" });
  });

  it("carries the owner's proxy to the client", async () => {
    const launcher = new DirectWorkerLauncher({ resolveAssignedTree: () => root, executablePath: () => entry,
      settingsStore: { resolveOne: () => ({ value: "http://proxy.test:8080" }) } });
    active.push({ launcher, attemptId: "proxied" });
    expect(await launcher.launch({ client: "gemini", attempt: attempt("proxied", "Proxy it.") })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(readSupervisorExit(root, "proxied")?.exitCode).toBe(0));
    expect(JSON.parse(readFileSync(join(root, "observed.json"), "utf8")).proxy).toBe("http://proxy.test:8080");
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
});