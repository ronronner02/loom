import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectWorkerLauncher } from "../src/adapters/direct-worker-launch.js";
import type { SupervisedTurn, SupervisorLaunch, SupervisorResult } from "../src/adapters/child-process-supervisor.js";
import type { WorkerClient, WorkerLaunchInput } from "../src/adapters/worker-launcher.js";
import type { WorkerEvent } from "../src/contracts/worker-events.js";
import type { ContextManifest } from "../src/integrations/framework/context-manifest.js";
import { writeAgentTurnPrompt } from "../src/domain/agent-turn.js";

const sessionId = "019a527e-91e7-7000-8aac-35cd290bda12";

function controlledTurn(launch: SupervisorLaunch, onEvent: (event: WorkerEvent) => void) {
  const identity = { processId: 4242, processStart: "2026-11-10T00:00:00.000Z" };
  const events: WorkerEvent[] = [];
  let finished: SupervisorResult | null = null;
  let resolve!: (result: SupervisorResult) => void;
  let reject!: (error: Error) => void;
  const completion = new Promise<SupervisorResult>((done, fail) => { resolve = done; reject = fail; });
  const finish = () => {
    finished = { version: 1, attemptId: launch.attemptId, provider: launch.provider, exitCode: 0, signal: null,
      acknowledged: true, noResponse: false, threadId: launch.provider === "codex" ? sessionId : null,
      stderrTail: "", outputTail: "", at: "2026-11-10T00:00:01.000Z", identity, events,
      finalMessage: "Done", resumeToken: sessionId };
    resolve(finished);
    return finished;
  };
  const cancel = vi.fn(async () => {
    finish();
    return { outcome: "stopped" as const, escalated: false, waitedMs: 0 };
  });
  const turn: SupervisedTurn = {
    async start() {
      if (launch.threadIdPath) writeFileSync(launch.threadIdPath, sessionId);
      const event: WorkerEvent = { type: "session.started", provider: launch.provider, attemptId: launch.attemptId,
        sequence: 1, timestamp: "2026-11-10T00:00:00.000Z", rawSummary: "{}", schema: "multi-agent-worker-events/v1",
        protocolVersion: "1.0", sessionId, resumeToken: sessionId };
      events.push(event);
      onEvent(event);
      return identity;
    },
    wait: () => completion,
    cancel,
    settled: () => finished,
    get processIdentity() { return identity; },
    get observedEvents() { return events; },
  };
  return { turn, finish, reject, cancel };
}

function liveTurnCount(launcher: DirectWorkerLauncher): number {
  return (launcher as unknown as { turns: Map<string, unknown> }).turns.size;
}

// Flush the detached wait chain without introducing a production inspection API or a timer.
const flushCompletion = () => new Promise<void>(resolve => setImmediate(resolve));

describe("completed direct turns release their in-memory histories", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "direct-retention-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function fixture(client: WorkerClient, alreadyFinished = false) {
    const context = { runId: "run", assignment: { taskId: "task", role: "implementer", paths: [], dependencies: [] },
      client, mutableStateRoot: root, projection: { attemptId: "attempt-1" },
      binding: { policyFingerprint: "sha256:" + "b".repeat(64) }, generatedHash: "sha256:" + "a".repeat(64),
    } as ContextManifest;
    writeAgentTurnPrompt(context, "Read the assigned plan.\n");
    let controlled!: ReturnType<typeof controlledTurn>;
    const launcher = new DirectWorkerLauncher({
      resolveAssignedTree: () => root,
      command: () => [process.execPath],
      supervise: (launch, deps) => {
        controlled = controlledTurn(launch, deps.onEvent);
        if (alreadyFinished) controlled.finish();
        return controlled.turn;
      },
    });
    const input: WorkerLaunchInput = { client, attempt: { attemptId: "attempt-1", deadline: Date.now() + 60_000, context } };
    return { launcher, input, control: () => controlled };
  }

  it.each(["claude-code", "codex", "gemini"] as const)("releases a fulfilled %s turn and preserves admission", async client => {
    const { launcher, input, control } = fixture(client);
    expect(await launcher.launch(input)).toMatchObject({ ok: true });
    expect(liveTurnCount(launcher)).toBe(1);
    control().finish();
    await flushCompletion();
    expect(liveTurnCount(launcher)).toBe(0);
    expect(await launcher.checkReady(input.attempt)).toEqual({ ready: true });
    expect(await launcher.launch(input)).toMatchObject({ ok: false, error: "Direct launch blocked: managed_attempt_already_started" });
    expect(await launcher.cancel(input.attempt.attemptId)).toBeNull();
    expect(control().cancel).not.toHaveBeenCalled();
  });

  it.each(["claude-code", "codex", "gemini"] as const)("releases a rejected %s wait without losing admission", async client => {
    const { launcher, input, control } = fixture(client);
    expect(await launcher.launch(input)).toMatchObject({ ok: true });
    expect(liveTurnCount(launcher)).toBe(1);
    control().reject(new Error("fixture exit recording failed"));
    await flushCompletion();
    expect(liveTurnCount(launcher)).toBe(0);
    expect(await launcher.checkReady(input.attempt)).toEqual({ ready: true });
    expect(await launcher.launch(input)).toMatchObject({ ok: false, error: "Direct launch blocked: managed_attempt_already_started" });
  });

  it.each(["claude-code", "codex", "gemini"] as const)("keeps a fast %s turn ready after its live entry is released", async client => {
    const { launcher, input } = fixture(client, true);
    expect(await launcher.launch(input)).toMatchObject({ ok: true });
    await flushCompletion();
    expect(liveTurnCount(launcher)).toBe(0);
    expect(await launcher.checkReady(input.attempt)).toEqual({ ready: true });
  });

  it("still awaits cancellation of an active turn", async () => {
    const { launcher, input, control } = fixture("claude-code");
    expect(await launcher.launch(input)).toMatchObject({ ok: true });
    expect(await launcher.cancel(input.attempt.attemptId)).toMatchObject({ attemptId: input.attempt.attemptId, exitCode: 0 });
    expect(control().cancel).toHaveBeenCalledTimes(1);
    await flushCompletion();
    expect(liveTurnCount(launcher)).toBe(0);
  });

  it("does not admit an unknown attempt", async () => {
    const { launcher, input } = fixture("claude-code");
    expect(await launcher.checkReady(input.attempt)).toEqual({ ready: false, code: "managed_identity_unobserved" });
    expect(await launcher.cancel(input.attempt.attemptId)).toBeNull();
  });
});
