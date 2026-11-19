import { describe, expect, it } from "vitest";
import type { TeamModelSettings, TeamReplayEvent, TeamSeatView } from "@loom/daemon/team-control";
import { adaptTeamEvents, mapTeamAttemptStates, mapTeamSeats } from "../flow/team-flow-adapter.js";
import { mapTeamEvents } from "../flow/flow-events.js";
import { resolveVendorForNode } from "../flow/vendor-avatars.js";
import { attempt, RUN_ID, seats } from "./fixtures.js";

const settings = (overrides: Partial<TeamModelSettings> = {}): TeamModelSettings => ({
  teamId: "rig", kind: "project", configured: true, lead: { client: "claude-code", model: "ds/claude" },
  allowedSubagents: [{ client: "codex", model: "grok-4" }, { client: "claude-code", model: "qwen3-coder" }],
  launches: [], ...overrides,
});
const launch = (overrides: Partial<TeamModelSettings["launches"][number]> = {}): TeamModelSettings["launches"][number] => ({
  attemptId: attempt().attemptId, runId: RUN_ID, role: "implementer", client: "codex", state: "running",
  requestedModel: "ds", observedModel: null, createdAt: "2026-11-16T00:00:00Z", ...overrides,
});

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

/** One record through the exported adapter, which is the only entry the app has. */
const adaptTeamReplayEvent = (value: ReturnType<typeof event>, fallback = "") => adaptTeamEvents([value], fallback)[0]!;

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
    expect(mapTeamSeats([seat], [attempt({ state: "running", provider: "codex" })])[1]).toMatchObject({
      id: "impl@rig", label: "Implementer \u00b7 Codex", role: "implementer", client: "codex", model: null,
    });
  });

  it("keeps only one configured lead before dispatch, not allowed models or unused seats", () => {
    const members = mapTeamSeats(seats, [], settings());
    expect(members).toEqual([expect.objectContaining({ id: "lead", role: "lead", client: "claude-code", model: "ds/claude" })]);
    expect(resolveVendorForNode(members[0]!)).toBe("deepseek");
    expect(mapTeamSeats([], [])).toEqual([expect.objectContaining({ id: "lead", model: null })]);
  });

  it("uses only the launch of the dispatched attempt and prefers its observed model", () => {
    const current = attempt({ state: "running" });
    const members = mapTeamSeats(seats, [current], settings({ launches: [
      launch({ runId: "another-run", observedModel: "grok-4" }),
      launch({ requestedModel: "custom-routing-alias", observedModel: "deepseek-v3.2", client: "claude-code" }),
    ] }));
    expect(members[1]).toMatchObject({ id: current.session, client: "claude-code", model: "deepseek-v3.2",
      aliases: [current.attemptId, current.taskId] });
    expect(resolveVendorForNode(members[1]!)).toBe("deepseek");
  });

  it("uses the requested model before observation without guessing from the client or allowlist", () => {
    const current = attempt({ state: "running" });
    const members = mapTeamSeats(seats, [current], settings({ launches: [launch({ requestedModel: "grok-4", client: "claude-code" })] }));
    expect(resolveVendorForNode(members[1]!)).toBe("grok");
    const unknown = mapTeamSeats(seats, [current], settings({ launches: [launch({ observedModel: "private-model" })] }));
    expect(resolveVendorForNode(unknown[1]!)).toBeNull();
    expect(mapTeamSeats(seats, [current], settings())[1]?.model).toBeNull();
  });

  it("uses the active attempt's telemetry even when its receipt aged out of the launch audit", () => {
    const current = attempt({ state: "running" });
    const observed = new Map([[current.attemptId, "qwen3-coder"]]);
    expect(mapTeamSeats(seats, [current], settings(), observed)[1]?.model).toBe("qwen3-coder");
    expect(mapTeamSeats(seats, [current], settings({ launches: [launch({ requestedModel: "grok-4" })] }), observed)[1]?.model).toBe("qwen3-coder");
  });

  it("does not turn stopped attempts or unregistered launch receipts into members", () => {
    const members = mapTeamSeats(seats, [attempt()], settings({ launches: [launch({ state: "unregistered" })] }));
    expect(members.map(member => member.id)).toEqual(["lead"]);
  });

  it("uses the latest occupant of a seat while preserving an unknown active attempt", () => {
    expect(mapTeamSeats(seats, [attempt({ state: "running" }), attempt({ attemptId: "newer", state: "stopped" })])
      .map(member => member.id)).toEqual(["lead"]);
    expect(mapTeamSeats(seats, [attempt({ state: "unknown" })]).map(member => member.id)).toEqual(["lead", "impl@rig"]);
  });

  it("names a dispatched attempt without a matching seat without exposing internal IDs", () => {
    const members = mapTeamSeats([], [attempt({ state: "running", session: null })]);
    expect(members[1]).toMatchObject({ id: attempt().attemptId, label: "Implementer 1", model: null });
    expect(resolveVendorForNode(members[1]!)).toBeNull();
  });

  it("keeps lead receipts on one character and respects later model changes", () => {
    const current = attempt({ role: "lead", state: "running", session: null, taskId: null });
    const saved = settings({ launches: [launch({ role: "lead", client: "claude-code", requestedModel: "ds/claude", observedModel: "deepseek-v3.2" })] });
    const members = mapTeamSeats(seats, [current], saved);
    expect(members).toHaveLength(1);
    expect(members[0]?.model).toBe("deepseek-v3.2");
    const mapping = mapTeamEvents(adaptTeamEvents([event({ runId: RUN_ID, attemptId: current.attemptId, body: "{}" })]), {
      seats: members, nodeStates: mapTeamAttemptStates([current], seats),
    });
    expect(mapping.nodes.map(node => node.id)).toEqual(["lead"]);
    expect(mapping.intents[0]?.sourceId).toBe("lead");
    const updated = { ...saved, lead: { client: "claude-code" as const, model: "qwen3-coder" } };
    expect(mapTeamSeats(seats, [{ ...current, state: "stopped" }], updated)[0]?.model).toBe("qwen3-coder");
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
