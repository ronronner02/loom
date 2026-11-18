import {
  WORKER_EVENT_PROTOCOL_VERSION,
  WORKER_EVENT_SCHEMA,
  WORKER_EVENT_SUMMARY_LIMIT,
  type WorkerEvent,
  type WorkerUsage,
} from "../contracts/worker-events.js";
import type { ProviderEventContext } from "./claude-worker-events.js";
import { TURN_MESSAGE_LIMIT } from "../domain/agent-turn.js";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
const text = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
const id = (value: unknown): string | null => text(value)?.slice(0, 256) ?? null;
const bounded = (value: string): string => value.slice(0, WORKER_EVENT_SUMMARY_LIMIT);
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

function usage(value: unknown): WorkerUsage | null {
  const stats = record(value);
  return stats ? { inputTokens: count(stats.input), cacheReadInputTokens: count(stats.cached),
    cacheWriteInputTokens: null, outputTokens: count(stats.output_tokens), reasoningOutputTokens: null } : null;
}

/**
 * Normalize one Gemini `--output-format stream-json` record.
 *
 * The installed client writes `init`, `message`, `tool_use`, `tool_result`, `error` and `result`,
 * and its `message` records are text the owner said or the agent is saying. Only the agent's
 * text becomes an event: the prompt the daemon sent is already the turn's input, and repeating it
 * would put owner text into the event log. Sequencing and acknowledgment belong to the shared
 * normalizer, as they do for the other clients.
 */
export function normalizeGeminiRecord(source: unknown, context: ProviderEventContext): WorkerEvent[] {
  const value = record(source), type = text(value?.type);
  const base = { schema: WORKER_EVENT_SCHEMA, protocolVersion: WORKER_EVENT_PROTOCOL_VERSION,
    provider: "gemini" as const, attemptId: context.attemptId, sequence: context.sequence(),
    timestamp: context.timestamp(value ?? {}), rawSummary: context.rawSummary(source) };
  const unknown = (diagnostic: string): WorkerEvent[] =>
    [{ ...base, type: "unknown", providerEventType: type, diagnostic }];
  if (!value) return unknown("Gemini record was not an object");
  if (type === "thinking" || type === "reasoning") return [];
  if (type === "init") {
    const sessionId = id(value.session_id);
    return sessionId
      ? [{ ...base, type: "session.started", sessionId, resumeToken: sessionId }, { ...base, type: "turn.started", turnId: null }]
      : unknown("Gemini init lacked session_id");
  }
  if (type === "message") {
    if (value.role === "user") return [];
    if (value.role !== "assistant" || typeof value.content !== "string") return unknown("Gemini message lacked assistant content");
    // The full answer is read from the same record by the final-message reader; the event keeps
    // only the bounded snapshot a live reader shows.
    return [{ ...base, type: "message.agent", messageId: null, text: bounded(context.finalMessage() ?? ""), final: false }];
  }
  if (type === "tool_use" || type === "tool_result") {
    const started = type === "tool_use", failed = value.status === "error", error = record(value.error);
    return [{ ...base, type: started ? "tool.started" : "tool.completed",
      toolCallId: id(value.tool_id) ?? context.nextId("gemini-tool"), tool: text(value.tool_name) ?? "tool",
      title: text(value.tool_name), status: started ? "running" : failed ? "failed" : "completed",
      ...(started && value.parameters !== undefined ? { input: value.parameters } : {}),
      output: text(value.output) === null ? null : bounded(value.output as string),
      error: failed ? bounded(text(error?.message) ?? "Tool failed") : null }];
  }
  if (type === "error") {
    return [{ ...base, type: "provider.error", code: text(value.code),
      message: bounded(text(value.message) ?? "Gemini provider error"), retryable: false, terminal: value.severity === "error" }];
  }
  if (type === "result") {
    if (value.status !== "success" && value.status !== "error") return unknown("Gemini result lacked a known status");
    const error = record(value.error), finalMessage = context.finalMessage();
    const events: WorkerEvent[] = value.status === "error" ? [{ ...base, type: "provider.error",
      code: text(error?.type), message: bounded(text(error?.message) ?? "Gemini turn failed"), retryable: false, terminal: true }] : [];
    events.push({ ...base, type: "turn.completed", status: value.status === "success" ? "completed" : "failed",
      finalMessage: finalMessage ? bounded(finalMessage) : null, resumeToken: context.resumeToken(), usage: usage(value.stats) });
    return events;
  }
  return unknown(`Unknown Gemini event ${type ?? "without type"}`);
}

export function extractGeminiResumeToken(source: unknown): string | null {
  const value = record(source);
  return value?.type === "init" ? id(value.session_id) : null;
}

export function extractGeminiFinalMessage(source: unknown, previous: string | null): string | null {
  const value = record(source);
  // A tool call ends the preceding commentary. Only the subsequent answer is final output.
  if (value?.type === "tool_use") return "";
  // Keep the full answer, not the event summary. One extra character makes oversized output fail
  // the existing final-message reader's byte limit instead of becoming a truncated reply.
  return value?.type === "message" && value.role === "assistant" && typeof value.content === "string"
    ? ((value.delta === true ? previous ?? "" : "") + value.content).slice(0, TURN_MESSAGE_LIMIT + 1) : null;
}