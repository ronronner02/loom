import { describe, expect, it } from "vitest";
import type { TeamReplayEvent, TeamSeatView } from "@multi-agent/daemon/team-control";
import { adaptTeamEvents, adaptTeamReplayEvent, mapTeamAttemptStates, mapTeamSeat } from "../flow/team-flow-adapter.js";
import { attempt, seats } from "./fixtures.js";

function event(overrides: Partial<TeamReplayEvent> = {}): TeamReplayEvent {
  return {
    seq: 7,
    createdAt: "2026-11-14 10:00:00",
    type: "team.control",
    action: "worker.tool.started",
    runId: "run-1",
    taskId: "task-1",
    attemptId: "attempt-1",
    body: '{"workerSeat":"impl@rig","tool":"read"}',
    truncated: false,
    ...overrides,
  };
}

describe("team flow adapter", () => {
  it("preserves replay identity and parses a structured body", () => {
    const adapted = adaptTeamReplayEvent(event(), "fallback");
    expect(adapted).toMatchObject({
      type: "team.control",
      eventId: "replay:7",
      runId: "run-1",
      taskId: "task-1",
      attemptId: "attempt-1",
      entityId: "attempt-1",
      action: "worker.tool.started",
      createdAt: "2026-11-14T10:00:00Z",
      seq: 7,
      payload: { workerSeat: "impl@rig", tool: "read" },
    });
  });

  it("retains explicit event time zones while interpreting SQLite timestamps as UTC", () => {
    expect(adaptTeamReplayEvent(event()).createdAt).toBe("2026-11-14T10:00:00Z");
    const offset = "2026-11-14T18:00:00+08:00";
    expect(adaptTeamReplayEvent(event({ createdAt: offset })).createdAt).toBe(offset);
  });

  it("keeps nullable or malformed replay fields inert", () => {
    const adapted = adaptTeamReplayEvent(event({ runId: null, action: null, body: "not-json", attemptId: null, taskId: null }), "fallback");
    expect(adapted.runId).toBe("fallback");
    expect(adapted.action).toBe("event.unknown");
    expect(adapted.entityId).toBe("event-7");
    expect(adapted.payload).toEqual({});
    expect(adaptTeamEvents([event(), event()], "fallback")).toHaveLength(2);
  });

  it("maps named daemon seats to flow nodes without exposing seat addresses as labels", () => {
    const seat: TeamSeatView = {
      seat: "impl@rig",
      role: "implementer",
      client: "codex",
      index: null,
      displayName: "Implementer \u00b7 Codex",
      retired: false,
    };
    expect(mapTeamSeat(seat)).toEqual({ id: "impl@rig", label: "Implementer \u00b7 Codex", role: "implementer" });
  });

  it.each([
    ["running", "working"], ["stopped", "idle"], ["unknown", "ambiguous"],
  ] as const)("maps a %s attempt to %s for every replay identity", (state, expected) => {
    const current = attempt({ state });
    const states = mapTeamAttemptStates([current]);
    for (const id of [current.attemptId, current.taskId!, current.session!]) expect(states.get(id)).toBe(expected);
  });

  it("uses the latest attempt for a shared task or seat without changing older attempt identities", () => {
    const states = mapTeamAttemptStates([
      attempt({ attemptId: "old", state: "running" }),
      attempt({ attemptId: "new", state: "stopped", createdAt: "2026-11-01T00:00:00.000Z" }),
    ]);
    expect(states.get("old")).toBe("working");
    expect(states.get("new")).toBe("idle");
    expect(states.get("task-1")).toBe("idle");
    expect(states.get("impl@rig")).toBe("idle");
  });

  it("maps lead attempts without queue identities to the canonical and named lead seats", () => {
    const states = mapTeamAttemptStates([attempt({ role: "lead", state: "running", taskId: null, session: null })], seats);
    expect(states.get("lead")).toBe("working");
    expect(states.get("lead@rig")).toBe("working");
    expect(states.has("impl@rig")).toBe(false);
    expect(mapTeamAttemptStates([]).size).toBe(0);
  });
});
