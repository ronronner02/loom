import type { TeamAttemptView, TeamModelSettings, TeamReplayEvent, TeamSeatView } from "@loom/daemon/team-control";
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
function adaptTeamReplayEvent(event: TeamReplayEvent, fallbackRunId = ""): FlowEvent {
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

/** Configured seats are capacity, not dispatches. Only the lead stays between attempts. */
export function mapTeamSeats(seats: readonly TeamSeatView[], attempts: readonly TeamAttemptView[], settings?: TeamModelSettings,
  observedModels?: ReadonlyMap<string, string>): FlowSeat[] {
  const latest = new Map<string, TeamAttemptView>();
  for (const attempt of attempts) latest.set(attempt.role === "lead" ? "lead" : attempt.session ?? attempt.attemptId, attempt);
  const launchFor = (attempt: TeamAttemptView | undefined) => attempt && settings?.launches.find(launch =>
    launch.attemptId === attempt.attemptId && launch.runId === attempt.runId);
  const namedLead = seats.find(seat => seat.role === "lead" && !seat.retired);
  const leadAttempt = latest.get("lead"), leadLaunch = launchFor(leadAttempt);
  const matchesLeadConfig = leadLaunch?.client === settings?.lead.client && leadLaunch?.requestedModel === settings?.lead.model;
  const currentLeadLaunch = leadAttempt?.state !== "stopped" || matchesLeadConfig ? leadLaunch : undefined;
  const observedLead = leadAttempt && leadAttempt.state !== "stopped" ? observedModels?.get(leadAttempt.attemptId) : undefined;
  const members: FlowSeat[] = [{
    id: "lead", role: "lead", label: "Lead",
    client: currentLeadLaunch?.client ?? settings?.lead.client ?? namedLead?.client,
    model: observedLead ?? currentLeadLaunch?.observedModel ?? currentLeadLaunch?.requestedModel ?? settings?.lead.model ?? null,
    aliases: [...seats.filter(seat => seat.role === "lead").map(seat => seat.seat),
      ...attempts.filter(attempt => attempt.role === "lead").flatMap(attempt =>
        [attempt.attemptId, ...(attempt.taskId ? [attempt.taskId] : []), ...(attempt.session ? [attempt.session] : [])])],
  }];
  for (const [id, attempt] of latest) {
    if (attempt.role === "lead" || attempt.state === "stopped") continue;
    const seat = seats.find(seat => seat.seat === attempt.session);
    const launch = launchFor(attempt);
    members.push({
      id, role: attempt.role as FlowRole, label: seat?.displayName ?? `${attempt.role[0]!.toUpperCase()}${attempt.role.slice(1)} ${members.length}`,
      client: launch?.client ?? (attempt.provider === "claude" ? "claude-code" : attempt.provider),
      model: observedModels?.get(attempt.attemptId) ?? launch?.observedModel ?? launch?.requestedModel ?? null,
      aliases: [attempt.attemptId, ...(attempt.taskId ? [attempt.taskId] : [])],
    });
  }
  return members;
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
