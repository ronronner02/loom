import type { TFunction } from "i18next";
import { clientLabelKey, roleLabelKey, statusLabelKey, type MessageKey, type StatusDomain } from "@loom/i18n";
import type { TeamReviewView, TeamSeatView, TeamTaskNameParts, TeamTaskStage } from "@loom/daemon/team-control";

/**
 * How the team surface names things.
 *
 * Every name the owner reads comes from here. A reviewer task is rebuilt from its parts so the
 * word "Review" is the reader's language, not the stored English one; ids stay in URLs and
 * React keys and never reach the DOM.
 */

export function taskName(task: Pick<TeamReviewView, "displayName" | "displayNameParts">, t: TFunction): string {
  return nameFromParts(task.displayNameParts, task.displayName, t);
}

export function nameFromParts(parts: TeamTaskNameParts, fallback: string, t: TFunction): string {
  if (parts.kind !== "review") return fallback;
  return parts.round > 1
    ? t("team.reviewNameRound", { round: parts.round, of: parts.of })
    : t("team.reviewName", { of: parts.of });
}

/** A task is finished when the queue says so; the merge gate and the line both read this. */
export function isFinished(task: Pick<TeamReviewView, "queueState">): boolean {
  return task.queueState === "done" || task.queueState === "handed-off";
}

export function clientLabel(client: string, t: TFunction): string {
  const key = clientLabelKey(client);
  return key ? t(key) : client;
}

/** "刚刚 / 3 分钟前 / 昨天 22:06" — relative inside a day, then a date. */
export function relativeTime(iso: string, now: number, t: TFunction): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return t("team.time.now");
  if (minutes < 60) return t("team.time.minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  const date = new Date(at);
  const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const sameDay = new Date(now).toDateString() === date.toDateString();
  if (sameDay) return t("team.time.hours", { count: hours });
  const yesterday = new Date(now - 86_400_000).toDateString() === date.toDateString();
  return yesterday ? t("team.time.yesterday", { time: clock }) : clock;
}

export function clockTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * The daemon's branch name carries a short suffix of the run id so two runs with the same goal
 * cannot collide. That suffix is an internal id, so the screen shows the readable part; the
 * name itself is unchanged wherever git needs the real one.
 */
export function readableBranch(branch: string): string {
  return branch.replace(/-[0-9a-f]{8}(-[0-9a-f]{4})*$/i, "").replace(/-+$/, "");
}

export const TASK_STAGE_LABELS = {
  "owner/decision": "tasks.stage.owner", "owner/question": "tasks.stage.owner", "owner/blocked": "tasks.stage.owner",
  "lead/report": "tasks.stage.lead", queued: "tasks.column.pending", running: "tasks.column.in-progress",
  review: "progress.review", done: "team.state.done",
} as const satisfies Record<TeamTaskStage, string>;

export function namedSeat(seat: TeamSeatView, t: TFunction): string {
  return roleLabel(seat.role, t) + " · " + clientLabel(seat.client, t)
    + (seat.index === null ? "" : " " + seat.index);
}

export function assignedSeat(task: TeamReviewView, seats: readonly TeamSeatView[], t: TFunction): string {
  const seat = seats.find(item => item.seat === task.seat);
  return seat ? namedSeat(seat, t) : roleLabel(task.role, t);
}

export function roleLabel(role: TeamReviewView["role"], t: TFunction): string {
  return t(roleLabelKey(role) ?? "role.implementer");
}

/** A status word from the daemon's own codes; an unknown code renders as the code itself. A
 * caller that needs a `MessageKey` (an aria-label composed with `t`) uses `statusKey`. */
export function statusLabel(domain: StatusDomain, code: string, t: TFunction): string {
  const key: MessageKey | undefined = statusLabelKey(domain, code);
  return key ? t(key, { defaultValue: code }) : code;
}

export function statusKey(domain: StatusDomain, code: string, fallback: MessageKey): MessageKey {
  return statusLabelKey(domain, code) ?? fallback;
}

/** The review gate word and its state; both are closed sets the screen renders. */
const GATE_KEYS = { evidence: "reviews.gate.evidence", review: "reviews.gate.review",
  integration: "reviews.gate.integration", delivery: "reviews.gate.delivery", merge: "reviews.gate.merge" } as const;
const GATE_STATE_KEYS = { passed: "reviews.gateState.passed", waiting: "reviews.gateState.waiting", unknown: "reviews.gateState.unknown" } as const;

export function gateLabel(gate: keyof typeof GATE_KEYS, t: TFunction): string {
  return t(Object.hasOwn(GATE_KEYS, gate) ? GATE_KEYS[gate] : "reviews.gate.evidence");
}

export function gateStateLabel(state: keyof typeof GATE_STATE_KEYS, t: TFunction): string {
  return t(Object.hasOwn(GATE_STATE_KEYS, state) ? GATE_STATE_KEYS[state] : "reviews.gateState.unknown");
}

/** The workspace detail tabs and the call-status glyph labels. */
const WORKSPACE_TAB_KEYS = { execution: "workspace.execution", changes: "workspace.changes", output: "workspace.output",
  grid: "workspace.grid", split: "workspace.split", focus: "workspace.focus" } as const;
const CALL_STATUS_KEYS = { running: "workspace.call.running", succeeded: "workspace.call.succeeded",
  failed: "workspace.call.failed", aborted: "workspace.call.aborted" } as const;

export function workspaceTabLabel(tab: keyof typeof WORKSPACE_TAB_KEYS, t: TFunction): string {
  return t(Object.hasOwn(WORKSPACE_TAB_KEYS, tab) ? WORKSPACE_TAB_KEYS[tab] : "workspace.execution");
}

export function callStatusLabel(status: keyof typeof CALL_STATUS_KEYS, t: TFunction): string {
  return t(Object.hasOwn(CALL_STATUS_KEYS, status) ? CALL_STATUS_KEYS[status] : "workspace.call.running");
}

/** The worker-report status and resolution words, and the review verdict. */
const REPORT_STATUS_KEYS = { blocked: "tasks.report.blocked", "needs-decision": "tasks.report.needs-decision", dropped: "tasks.report.dropped" } as const;
const RESOLUTION_KEYS = { rework: "tasks.resolution.rework", reassign: "tasks.resolution.reassign", drop: "tasks.resolution.drop" } as const;
const VERDICT_KEYS = { approved: "team.task.verdict.approved", "changes-required": "team.task.verdict.changes-required" } as const;
const EVENT_SOURCE_KEYS = { stream: "tasks.event.stream", "task-outcome": "tasks.event.task-outcome", "attempt-lifecycle": "tasks.event.attempt-lifecycle" } as const;

export function reportStatusLabel(status: keyof typeof REPORT_STATUS_KEYS, t: TFunction): string {
  return t(Object.hasOwn(REPORT_STATUS_KEYS, status) ? REPORT_STATUS_KEYS[status] : "tasks.report.blocked");
}

export function resolutionLabel(resolution: keyof typeof RESOLUTION_KEYS, t: TFunction): string {
  return t(Object.hasOwn(RESOLUTION_KEYS, resolution) ? RESOLUTION_KEYS[resolution] : "tasks.resolution.rework");
}

export function verdictLabel(verdict: keyof typeof VERDICT_KEYS, t: TFunction): string {
  return t(Object.hasOwn(VERDICT_KEYS, verdict) ? VERDICT_KEYS[verdict] : "team.task.verdict.changes-required");
}

export function eventSourceLabel(source: keyof typeof EVENT_SOURCE_KEYS, t: TFunction): string {
  return t(Object.hasOwn(EVENT_SOURCE_KEYS, source) ? EVENT_SOURCE_KEYS[source] : "tasks.event.stream");
}

/** The daemon's merge-refusal codes; an unlisted code falls through to the generic refusal. */
const MERGE_REFUSAL_KEYS = {
  merge_tasks_open: "team.merge.refused.merge_tasks_open",
  merge_checkout_dirty: "team.merge.refused.merge_checkout_dirty",
  merge_detached_head: "team.merge.refused.merge_detached_head",
  merge_already_on_branch: "team.merge.refused.merge_already_on_branch",
  merge_no_branch: "team.merge.refused.merge_no_branch",
  merge_unavailable: "team.merge.refused.merge_unavailable",
  github_pr_failed: "team.merge.refused.github_pr_failed",
  github_network_failure: "team.merge.refused.github_network_failure",
  github_not_signed_in: "team.merge.refused.github_not_signed_in",
} as const;
const STAGE_STATE_KEYS = {
  complete: "web.stageState.complete", active: "web.stageState.active", pending: "web.stageState.pending",
  "awaiting-decision": "web.stageState.awaiting-decision", "not-started": "web.stageState.not-started",
  unavailable: "web.stageState.unavailable",
} as const;

export function mergeRefusalLabel(code: string | null | undefined, t: TFunction): string | undefined {
  return code && Object.hasOwn(MERGE_REFUSAL_KEYS, code) ? t(MERGE_REFUSAL_KEYS[code as keyof typeof MERGE_REFUSAL_KEYS]) : undefined;
}

export function stageStateLabel(state: keyof typeof STAGE_STATE_KEYS, t: TFunction): string {
  return t(Object.hasOwn(STAGE_STATE_KEYS, state) ? STAGE_STATE_KEYS[state] : "web.stageState.pending");
}
