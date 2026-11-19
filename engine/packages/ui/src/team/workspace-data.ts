import { useMemo } from "react";
import type { MessageKey } from "@loom/i18n";
import type { TeamOwnerRead, TeamSeatView, TeamSystemHealth } from "@loom/daemon/team-control";
import { OwnerReadError, useOwnerSession } from "../hooks/useOwnerSession.js";
import { useAttemptStatus } from "../hooks/useAttemptStatus.js";
import { useTeamRun } from "../hooks/useTeamRun.js";
import { useTeamEvents } from "../hooks/useTeamEvents.js";
import { resolvePomoAvatarState, type PomoAvatarState } from "./pomo-avatar.js";
import { isFinished } from "./display.js";
import { isRunActive } from "./clients.js";
import { pendingOwnerDecisions, pendingWorkerQuestions } from "./chat-panel.js";
import { useIntegration, useRuns, useTeamChat, useTeams } from "./hooks.js";

/** A finished run offers its project one more round of work; a live one with open tasks does not. */
export function showsNewWork(read?: TeamOwnerRead): boolean {
  if (!read) return false;
  if (!isRunActive(read.run)) return true;
  return read.tasks.length > 0 && read.tasks.every(task => isFinished(task));
}

/**
 * Everything the shell reads for the selected run and project.
 *
 * The queries and the derivations over them live here so the shell can render without knowing
 * which endpoint feeds which word; a screen that needs a query the shell never shows (the Flow
 * model) owns that query itself.
 */
export function useTeamWorkspace(runId: string, teamParam: string | undefined) {
  const { paired } = useOwnerSession();
  const data = useTeamRun(runId);
  const teams = useTeams();
  const runs = useRuns();
  const chat = useTeamChat(runId, paired);
  const integration = useIntegration(runId, paired);

  const read = data.read.data;
  // The connection word is derived from the stream, so the shell owns the query even though no
  // screen reads the records from it; Flow reads them through this accessor.
  const eventsQuery = useTeamEvents(runId, read);
  const events = eventsQuery.data;
  const error = data.read.error ?? eventsQuery.error ?? data.health.error;
  const connection: MessageKey = !paired ? "web.pairRequired"
    : error instanceof OwnerReadError ? (error.status === 404 ? "web.notFound" : "web.error")
      : error instanceof TypeError || events?.connection === "reconnecting" || events?.connection === "denied" ? "web.disconnected"
        : error ? "web.error"
          : (runId ? data.read.isPending : data.health.isPending) ? "web.loading" : "shell.connected";

  const selectedTeamId = read?.run.rigId ?? runs.data?.find(entry => entry.id === runId)?.rigId ?? teamParam;
  const team = teams.data?.find(entry => entry.id === selectedTeamId);
  const teamName = team?.name ?? runs.data?.find(entry => entry.id === runId)?.rigName ?? "";
  const runName = read?.run.displayName ?? runs.data?.find(entry => entry.id === runId)?.displayName ?? "";
  const currentRuns = useMemo(() => runs.data?.filter(run => run.rigId === selectedTeamId) ?? [],
    [runs.data, selectedTeamId]);

  const lead = read?.attempts.filter(attempt => attempt.role === "lead").at(-1);
  const leadStatus = useAttemptStatus(runId, lead, !!chat.data?.liveTurn?.progress?.sequence);
  const coordinator: MessageKey = !read ? "web.unknown" : !leadStatus ? "shell.idle" : `status.attempt.${leadStatus}`;

  const pendingDecisions = paired ? pendingOwnerDecisions(read, chat.data) : [];
  const pendingQuestions = paired ? pendingWorkerQuestions(read) : [];
  const attention = pendingDecisions.length + pendingQuestions.length;
  const avatarState: PomoAvatarState = resolvePomoAvatarState(coordinator, {
    hasPendingOwner: attention > 0,
    isMessaging: !!chat.data?.liveTurn?.progress?.sequence,
    isMilestone: !!read && read.tasks.length > 0 && read.tasks.every(task => task.stage === "done"),
  });

  return {
    paired,
    read, chat: chat.data, integration: integration.data, events,
    health: data.health.data as TeamSystemHealth | undefined,
    healthError: data.health.isError,
    runPending: data.read.isPending,
    runError: data.read.error,
    chatError: chat.isError,
    integrationError: integration.isError,
    error, connection,
    teams, runs, selectedTeamId, team, teamName, runName, currentRuns,
    activeSeats: (read?.seats ?? []).filter((seat: TeamSeatView) => !seat.retired),
    canStartWork: showsNewWork(read) && runId !== "",
    pendingDecisions, pendingQuestions, attention, coordinator, avatarState,
    /** Re-read the run and its conversation after an owner control accepted. */
    refresh: () => { void chat.refetch(); void data.read.refetch(); },
    refetchTeams: () => { void teams.refetch(); void runs.refetch(); },
    refetchRuns: () => { void runs.refetch(); },
  };
}

export type TeamWorkspace = ReturnType<typeof useTeamWorkspace>;