import { describe, expect, it } from "vitest";
import { normalizeWorkerStream, WorkerEventNormalizer } from "../src/adapters/worker-event-normalizer.js";

const session = "820b7f64-8b84-4c31-a4b9-3ed9cd38456a";
const init = { type: "init", session_id: session, model: "gemini-2.5-pro" };

describe("Gemini headless stream", () => {
  it("preserves a full final answer while keeping event diagnostics bounded", () => {
    const answer = JSON.stringify({ status: "needs-decision", evidence: "A reviewed detail. ".repeat(80), question: "Which behavior should remain?" });
    const result = normalizeWorkerStream("gemini", [init,
      { type: "message", role: "assistant", content: answer.slice(0, 300), delta: true },
      { type: "message", role: "assistant", content: answer.slice(300), delta: true },
      { type: "result", status: "success" },
    ], { attemptId: "gemini-long-answer" });
    expect(result.finalMessage).toBe(answer);
    expect(result.events.every(event => event.rawSummary.length <= 512)).toBe(true);
    expect(result.events.filter(event => event.type === "message.agent").every(event => event.text.length <= 512)).toBe(true);
  });

  it("acknowledges a session, joins final chunks and retains the native resume identity", () => {
    const result = normalizeWorkerStream("gemini", [
      init,
      { type: "message", role: "user", content: "Private owner prompt" },
      { type: "message", role: "assistant", content: "I will inspect the file.", delta: true },
      { type: "tool_use", tool_id: "read-1", tool_name: "read_file", parameters: { file_path: "README.md" } },
      { type: "tool_result", tool_id: "read-1", status: "success", output: "File contents" },
      { type: "message", role: "assistant", content: "Done. ", delta: true },
      { type: "message", role: "assistant", content: "One file checked.", delta: true },
      { type: "result", status: "success", stats: { input_tokens: 120, input: 100, cached: 20, output_tokens: 30 } },
    ], { attemptId: "gemini-turn" });

    expect(result.acknowledged).toBe(true);
    expect(result.resumeToken).toBe(session);
    expect(result.finalMessage).toBe("Done. One file checked.");
    expect(result.events.filter(event => event.type === "attempt.acknowledged")).toHaveLength(1);
    expect(result.events.every(event => event.provider === "gemini")).toBe(true);
    expect(JSON.stringify(result.events)).not.toContain("Private owner prompt");
    expect(result.events).toContainEqual(expect.objectContaining({ type: "tool.started", toolCallId: "read-1", tool: "read_file" }));
    expect(result.events).toContainEqual(expect.objectContaining({ type: "tool.completed", toolCallId: "read-1", status: "completed" }));
    expect(result.events.at(-1)).toMatchObject({ type: "turn.completed", status: "completed", resumeToken: session,
      finalMessage: "Done. One file checked.", usage: { inputTokens: 100, cacheReadInputTokens: 20, outputTokens: 30 } });
  });

  it("records errors without treating a failed result as success", () => {
    const result = normalizeWorkerStream("gemini", [init,
      { type: "error", severity: "warning", message: "Retrying a request" },
      { type: "tool_result", tool_id: "read-1", status: "error", error: { message: "Missing file" } },
      { type: "result", status: "error", error: { type: "API_ERROR", message: "Request failed" } },
    ], { attemptId: "gemini-error" });
    expect(result.events).toContainEqual(expect.objectContaining({ type: "provider.error", terminal: false, message: "Retrying a request" }));
    expect(result.events).toContainEqual(expect.objectContaining({ type: "tool.completed", status: "failed", error: "Missing file" }));
    expect(result.events.at(-1)).toMatchObject({ type: "turn.completed", status: "failed" });
  });

  it("keeps malformed output bounded and does not invent acknowledgment", () => {
    const normalizer = new WorkerEventNormalizer({ provider: "gemini", attemptId: "gemini-bad" });
    expect(normalizer.normalizeLine("not-json")[0]).toMatchObject({ type: "provider.error", code: "malformed_json" });
    expect(normalizer.normalize({ type: "init" })[0]).toMatchObject({ type: "unknown" });
    expect(normalizer.noResponse).toBe(true);
    expect(normalizer.normalize({ type: "thinking", text: "Private reasoning" })).toEqual([]);
    expect(normalizer.normalize({ type: "new-event" })[0]).toMatchObject({ type: "unknown", providerEventType: "new-event" });
  });
});