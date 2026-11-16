import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectWorkerLauncher } from "../src/adapters/direct-worker-launch.js";
import { readSupervisorExit } from "../src/adapters/child-process-supervisor.js";
import { agentTurnOutputPaths, managedTurnPrompt, turnInstructions, writeAgentTurnPrompt } from "../src/domain/agent-turn.js";
import { observeIdentity } from "../src/domain/process-termination.js";
import type { ContextManifest } from "../src/integrations/framework/context-manifest.js";
import type { ManagedAttempt } from "../src/domain/runtime-adapter.js";

const installedEntry = process.env.MULTI_AGENT_E2E_GEMINI_ENTRY;

// Opt in with an installed executable, npm shim or JavaScript entry. The API and client home are fixtures.
describe.skipIf(!installedEntry)("installed Gemini CLI against a local API", () => {
  it("reads managed instructions, writes reports, resumes read-only, rejects reviewer writes and cancels", async () => {
    const root = mkdtempSync(join(tmpdir(), "gemini-installed-")), home = join(root, "home"), workspace = join(root, "project");
    const firstPaths = agentTurnOutputPaths(root, "first"), evidence = join(firstPaths.directory, "evidence");
    mkdirSync(join(home, ".gemini"), { recursive: true }); mkdirSync(workspace); mkdirSync(evidence, { recursive: true });
    writeFileSync(join(home, ".gemini", "settings.json"), JSON.stringify({ security: { auth: { selectedType: "gemini-api-key" } },
      telemetry: { enabled: false }, privacy: { usageStatisticsEnabled: false }, general: { disableAutoUpdate: true } }));
    writeFileSync(join(workspace, "input.txt"), "Original fixture input.");
    writeFileSync(join(evidence, "result.txt"), "Fixture evidence.");
    const framework = join(root, "framework", "fixture-skill");
    mkdirSync(join(framework, "references"), { recursive: true });
    writeFileSync(join(framework, "SKILL.md"), "Fixture skill instructions. See references/check.md.");
    writeFileSync(join(framework, "references", "check.md"), "Fixture skill reference.");
    let phase = "first", streams = 0, instructionPaths: string[] = [];
    const requests: Array<{ phase: string; body: string }> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        requests.push({ phase, body });
        const stream = request.url?.includes("streamGenerateContent");
        if (phase === "cancel" && stream) return;
        if (stream) streams++;
        const parts = stream && streams === 1 ? [
          ...instructionPaths.map(file_path => ({ functionCall: { name: "read_file", args: { file_path } } })),
          ...(phase === "first"
            ? [{ functionCall: { name: "write_file", args: { file_path: firstPaths.taskReport, content: '{"status":"blocked","reason":"fixture"}' } } }]
            : phase === "review" ? [{ functionCall: { name: "read_file", args: { file_path: join(evidence, "result.txt") } } },
              { functionCall: { name: "write_file", args: { file_path: join(workspace, "input.txt"), content: "Unexpected reviewer write." } } }]
              : [])]
          : [{ text: "Fixture complete." }];
        const reply = { candidates: [{ content: { role: "model", parts }, finishReason: "STOP", index: 0 }],
          usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 20, candidatesTokenCount: 10, totalTokenCount: 110 },
          modelVersion: "gemini-2.5-flash" };
        response.writeHead(200, { "Content-Type": stream ? "text/event-stream" : "application/json" });
        response.end(stream ? "data: " + JSON.stringify(reply) + "\n\n" : JSON.stringify(reply));
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    for (const key of ["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION",
      "GOOGLE_VERTEX_BASE_URL", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"]) vi.stubEnv(key, undefined);
    for (const [key, value] of Object.entries({ HOME: home, USERPROFILE: home, GEMINI_CLI_HOME: home,
      APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"), XDG_CACHE_HOME: join(home, ".cache"),
      GEMINI_API_KEY: "local-fixture-key", GOOGLE_API_KEY: "local-fixture-key", GEMINI_TELEMETRY_ENABLED: "false",
      GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${address.port}` })) vi.stubEnv(key, value);
    const launcher = new DirectWorkerLauncher({ resolveAssignedTree: () => workspace, executablePath: () => installedEntry });
    const attempt = (id: string, role: string, prompt: string): ManagedAttempt => {
      const contextRoot = join(root, "context", id), core = join(contextRoot, "core.md");
      const charter = join(contextRoot, role === "lead" ? "protocol.md" : "charter.md");
      mkdirSync(contextRoot, { recursive: true });
      writeFileSync(core, `Fixture ${id} core instructions.`);
      writeFileSync(charter, `Fixture ${id} ${role} instructions.`);
      const context = { runId: "run", assignment: { taskId: "task", role, paths: [], dependencies: [] }, client: "gemini",
        root: contextRoot, sameIdentity: true,
        files: [{ kind: "core", path: core }, { kind: role === "lead" ? "protocol" : "charter", path: charter },
          { kind: "framework", path: join(contextRoot, "framework.md"), source: join(framework, "SKILL.md") }],
        mutableStateRoot: root, projection: { attemptId: id }, binding: { policyFingerprint: "sha256:" + "b".repeat(64) },
        generatedHash: "sha256:" + "a".repeat(64) } as ContextManifest;
      const instructions = turnInstructions(context);
      instructionPaths = [...instructions.map(file => file.path), join(framework, "references", "check.md")];
      writeAgentTurnPrompt(context, managedTurnPrompt({ identity: "", bundle: "", runId: context.runId,
        assignment: context.assignment, taskBody: prompt, outputs: [], permissions: [], instructions, continuation: null }));
      return { attemptId: id, context, deadline: Date.now() + 60_000, ...(role === "reviewer" ? { evidenceDirectory: evidence } : {}) };
    };
    const assertInstructionReads = (id: string, role: string) => {
      const results = requests.filter(request => request.phase === id).flatMap(request => {
        const body = JSON.parse(request.body) as { contents?: Array<{ parts?: Array<{ functionResponse?: unknown }> }> };
        return body.contents?.flatMap(content => content.parts?.flatMap(part =>
          part.functionResponse ? [JSON.stringify(part.functionResponse)] : []) ?? []) ?? [];
      }).join("\n");
      for (const expected of [`Fixture ${id} core instructions.`, `Fixture ${id} ${role} instructions.`,
        "Fixture skill instructions.", "Fixture skill reference."]) expect(results).toContain(expected);
    };
    try {
      const first = await launcher.launch({ client: "gemini", model: "gemini-2.5-flash",
        attempt: attempt("first", "implementer", "Write the fixture report and reply Fixture complete.") });
      expect(first).toMatchObject({ ok: true, resumeType: "gemini_id" });
      if (!first.ok) throw new Error(first.error);
      await vi.waitFor(() => expect(readSupervisorExit(root, "first")).toMatchObject({ exitCode: 0, provider: "gemini" }), { timeout: 15_000 });
      expect(JSON.parse(readFileSync(firstPaths.taskReport, "utf8"))).toEqual({ status: "blocked", reason: "fixture" });
      expect(readFileSync(firstPaths.lastMessage, "utf8")).toBe("Fixture complete.");
      expect(JSON.parse(readFileSync(firstPaths.usage, "utf8"))).toMatchObject({ client: "gemini", nativeSessionId: first.resumeToken,
        mode: "turn", counts: { inputTokens: 160, cacheReadInputTokens: 40, outputTokens: 20, reasoningOutputTokens: null } });
      assertInstructionReads("first", "implementer");

      phase = "review"; streams = 0;
      const review = await launcher.launch({ client: "gemini", model: "gemini-2.5-flash", continueSessionId: first.resumeToken,
        attempt: attempt("review", "reviewer", "Review the fixture evidence and reply Fixture complete.") });
      expect(review).toMatchObject({ ok: true, resumeToken: first.resumeToken });
      await vi.waitFor(() => expect(readSupervisorExit(root, "review")?.exitCode).toBe(0), { timeout: 15_000 });
      const reviewPaths = agentTurnOutputPaths(root, "review");
      const activity = readFileSync(reviewPaths.activity, "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(activity).toContainEqual(expect.objectContaining({ tool: "read_file", status: "completed" }));
      expect(activity).toContainEqual(expect.objectContaining({ tool: "write_file", status: "failed" }));
      expect(readFileSync(join(workspace, "input.txt"), "utf8")).toBe("Original fixture input.");
      expect(JSON.parse(readFileSync(reviewPaths.usage, "utf8"))).toMatchObject({ client: "gemini", resumed: true, nativeSessionId: first.resumeToken });
      expect(requests.some(request => request.phase === "review" && request.body.includes("Write the fixture report"))).toBe(true);
      assertInstructionReads("review", "reviewer");

      phase = "lead"; streams = 0;
      expect(await launcher.launch({ client: "gemini", model: "gemini-2.5-flash",
        attempt: attempt("lead", "lead", "Read the lead protocol and reply Fixture complete.") })).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(readSupervisorExit(root, "lead")?.exitCode).toBe(0), { timeout: 15_000 });
      assertInstructionReads("lead", "lead");

      phase = "cancel"; streams = 0;
      expect(await launcher.launch({ client: "gemini", model: "gemini-2.5-flash", attempt: attempt("cancel", "lead", "Wait for the fixture.") }))
        .toMatchObject({ ok: true });
      await vi.waitFor(() => expect(requests.some(request => request.phase === "cancel")).toBe(true));
      const canceled = await launcher.cancel("cancel");
      expect(canceled).toMatchObject({ provider: "gemini", acknowledged: true });
      expect(await observeIdentity(canceled!.identity)).toBe("dead");
    } finally {
      for (const id of ["first", "review", "lead", "cancel"]) await launcher.cancel(id);
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
    }
  }, 45_000);
});
