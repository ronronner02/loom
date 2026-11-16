import type { TeamAttemptView, TeamReplayEvent, TeamSeatView } from "@multi-agent/daemon/team-control";
import type { FlowEvent, FlowNodeState, FlowRole, FlowSeat } from "./flow-events.js";

function bodyPayload(body: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Event bodies are bounded and redacted at the daemon boundary; malformed text is inert.
  }
  return {};
}

function entityId(event: TeamReplayEvent): string {
  return event.attemptId ?? event.taskId ?? event.runId ?? `event-${event.seq}`;
}

/** Convert the nullable, redacted replay contract into the renderer's stable event shape. */
export function adaptTeamReplayEvent(event: TeamReplayEvent, fallbackRunId = ""): FlowEvent {
  return {
    type: event.type,
    eventId: `replay:${event.seq}`,
    runId: event.runId ?? fallbackRunId,
    taskId: event.taskId,
    attemptId: event.attemptId,
    entityId: entityId(event),
    action: event.action ?? "event.unknown",
    payload: bodyPayload(event.body),
    createdAt: event.createdAt.includes("T") ? event.createdAt : event.createdAt.replace(" ", "T") + "Z",
    seq: event.seq,
  };
}

export function adaptTeamEvents(events: readonly TeamReplayEvent[], fallbackRunId = ""): FlowEvent[] {
  return events.map(event => adaptTeamReplayEvent(event, fallbackRunId));
}

export function mapTeamSeat(seat: TeamSeatView): FlowSeat {
  return { id: seat.seat, label: seat.displayName, role: seat.role as FlowRole };
}

export function mapTeamAttemptStates(attempts: readonly TeamAttemptView[], seats: readonly TeamSeatView[] = []): Map<string, FlowNodeState> {
  const states = new Map<string, FlowNodeState>();
  // The read model orders attempts oldest first, so the latest task/seat occupant wins.
  for (const attempt of attempts) {
    const state = attempt.state === "running" ? "working" : attempt.state === "unknown" ? "ambiguous" : "idle";
    states.set(attempt.attemptId, state);
    if (attempt.taskId) states.set(attempt.taskId, state);
    if (attempt.session) states.set(attempt.session, state);
    if (attempt.role === "lead") {
      states.set("lead", state);
      for (const seat of seats) if (seat.role === "lead") states.set(seat.seat, state);
    }
  }
  return states;
}
