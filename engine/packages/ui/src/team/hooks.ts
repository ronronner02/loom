import { useQueries, useQuery } from "@tanstack/react-query";
import type { AttemptActivity, TeamAttemptView, TeamModelChoice, TeamModelSettings, TeamOwnerRead, TeamRunState, TurnUsage } from "@loom/daemon/team-control";
import { useOwnerSession } from "../hooks/useOwnerSession.js";
import { readIntegration, readChat, type ChatState, type IntegrationState } from "./clients.js";

/**
 * The team surface's reads.
 *
 * Every query is owner-scoped and disabled until the browser is paired, so an unpaired page
 * never fires a request.
 */

export interface TeamSeatSummary { role: "lead" | "implementer" | "reviewer"; client: string; model?: string }
export interface TeamSummary { id: string; name: string; repository: string; seats: TeamSeatSummary[]; kind?: "project" | "test" }
export interface RunSummary {
  phase?: "planning" | "delivery"; messageCount?: number; executionTaskCount?: number; resultCount?: number;
  id: string; rigId: string; rigName: string; state: TeamRunState; planRef: string; displayName: string; createdAt: string;
}

export const teamsKey = ["team", "teams"] as const;
export const runsKey = ["team", "runs"] as const;

export const teamModelSettingsKey = (teamId: string) => ["team", "model-settings", teamId] as const;

export function useTeamModelSettings(teamId: string, enabled = true) {
  const { paired, request } = useOwnerSession();
  return useQuery({
    queryKey: teamModelSettingsKey(teamId), enabled: paired && enabled && !!teamId, retry: false, refetchInterval: 5_000,
    queryFn: ({ signal }) => request<{ settings: TeamModelSettings; modelChoices?: TeamModelChoice[] }>(
      `/teams/${encodeURIComponent(teamId)}/settings`, { signal }),
  });
}

export function useTeams() {
  const { paired, request } = useOwnerSession();
  return useQuery({
    queryKey: teamsKey, enabled: paired, retry: false, refetchInterval: 5_000,
    queryFn: async ({ signal }) => (await request<{ teams: TeamSummary[] }>("/teams", { signal })).teams,
  });
}

export function useRuns() {
  const { paired, request } = useOwnerSession();
  return useQuery({
    queryKey: runsKey, enabled: paired, retry: false, refetchInterval: 5_000,
    queryFn: async ({ signal }) => (await request<{ runs: RunSummary[] }>("/runs", { signal })).runs,
  });
}

/** The run a team opened most recently; a team with no run has none. */
export function latestRunFor(runs: readonly RunSummary[] | undefined, teamId: string): RunSummary | undefined {
  return (runs ?? []).filter(run => run.rigId === teamId).at(0);
}

export function useTeamChat(runId: string, enabled: boolean) {
  const { paired, request } = useOwnerSession();
  return useQuery<ChatState>({
    queryKey: ["team", runId, "chat"], enabled: paired && enabled && !!runId, retry: false,
    queryFn: ({ signal }) => readChat(request, runId, signal),
  });
}

export function useIntegration(runId: string, enabled: boolean) {
  const { paired, request } = useOwnerSession();
  return useQuery<IntegrationState>({
    queryKey: ["team", runId, "integration"], enabled: paired && enabled && !!runId, retry: false,
    queryFn: ({ signal }) => readIntegration(request, runId, signal),
  });
}

export function observedTokens(usages: readonly (TurnUsage | undefined)[]): { tokens: number | null; partial: boolean } {
  let tokens: number | null = null;
  let partial = false;
  for (const usage of usages) {
    if (!usage || usage.status === "unavailable") { partial = true; continue; }
    partial ||= usage.status === "partial";
    // Reasoning output is already part of outputTokens.
    for (const value of [usage.inputTokens, usage.cacheReadInputTokens, usage.cacheWriteInputTokens, usage.outputTokens]) {
      if (value !== null) tokens = (tokens ?? 0) + value;
      else partial = true;
    }
  }
  return { tokens, partial };
}

function attemptUsageQuery(request: ReturnType<typeof useOwnerSession>["request"], runId: string, attempt: TeamAttemptView) {
  return {
    queryKey: ["team", runId, "attempt", attempt.attemptId, "usage", attempt.state],
    retry: false, staleTime: attempt.state === "stopped" ? Infinity : 0,
    queryFn: async ({ signal }: { signal: AbortSignal }) => (await request<{ activity: AttemptActivity }>(
      "/runs/" + encodeURIComponent(runId) + "/attempts/" + encodeURIComponent(attempt.attemptId)
        + "/activity?after=" + Number.MAX_SAFE_INTEGER, { signal })).activity.usage,
  };
}

/** Run totals use each attempt's native telemetry, never governance budget counters or another run's spend. */
export function useRunTokens(read: TeamOwnerRead | undefined) {
  const { paired, request } = useOwnerSession();
  const queries = useQueries({ queries: (read?.attempts ?? []).map(attempt => ({
    ...attemptUsageQuery(request, read!.runId, attempt), enabled: paired,
  })) });
  return observedTokens(queries.map(query => query.isError ? undefined : query.data));
}

/** Live observations also cover attempts older than the bounded launch audit. */
export function useAttemptModels(read: TeamOwnerRead | undefined, enabled: boolean): ReadonlyMap<string, string> {
  const { paired, request } = useOwnerSession();
  const active = (read?.attempts ?? []).filter(attempt => attempt.state !== "stopped");
  const queries = useQueries({ queries: active.map(attempt => ({
    ...attemptUsageQuery(request, read!.runId, attempt), enabled: paired && enabled, refetchInterval: 5_000,
  })) });
  const models = new Map<string, string>();
  queries.forEach((query, index) => { if (query.data?.model) models.set(active[index]!.attemptId, query.data.model); });
  return models;
}
