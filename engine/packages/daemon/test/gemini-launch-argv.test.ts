import { describe, expect, it } from "vitest";
import { workerArgv } from "../src/adapters/worker-launch-argv.js";
import { agentTurnOutputPaths } from "../src/domain/agent-turn.js";

const sessionId = "820b7f64-8b84-4c31-a4b9-3ed9cd38456a";
const input = { client: "gemini" as const, tree: "/workspace", output: agentTurnOutputPaths("/state", "turn"),
  sessionId, continuing: false, readOnly: false, role: "implementer", model: "gemini-2.5-pro" };

describe("Gemini native launch arguments", () => {
  it("opens a headless JSONL turn with the selected model and explicit session identity", () => {
    expect(workerArgv(input)).toEqual(["--output-format", "stream-json", "--skip-trust", "--approval-mode", "yolo",
      "--model", "gemini-2.5-pro", "--include-directories", input.output.directory, "--session-id", sessionId]);
  });
  it.each([{ role: "reviewer", readOnly: false }, { role: "implementer", readOnly: true }])(
    "uses plan mode for a read-only turn: %j", posture => {
      const args = workerArgv({ ...input, ...posture });
      expect(args).toContain("plan");
      expect(args).not.toContain("yolo");
      expect(args).not.toContain(input.output.directory);
    });
  it("adds only the selected review evidence directory while retaining plan mode", () => {
    const args = workerArgv({ ...input, role: "reviewer", evidenceDirectory: "/state/reviewed/evidence" });
    expect(args).toContain("plan");
    expect(args[args.indexOf("--include-directories") + 1]).toBe("/state/reviewed/evidence");
    expect(args).not.toContain(input.output.directory);
    expect(workerArgv({ ...input, role: "lead" })).not.toContain("--include-directories");
  });
  it("continues only the exact recorded session without allocating another identity", () => {
    const args = workerArgv({ ...input, continuing: true });
    expect(args.slice(-2)).toEqual(["--resume", sessionId]);
    expect(args).not.toContain("--session-id");
  });
});
