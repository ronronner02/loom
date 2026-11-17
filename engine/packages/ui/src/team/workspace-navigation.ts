import { useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { teamSection, type TeamSection } from "./sections.js";

export type WorkspaceTab = "files" | "work" | "inbox" | "reviews";
export type OverviewTab = "summary" | "flow" | "analytics";

/**
 * The shell's section and sub-tab state and the URL it navigates through.
 *
 * Sections come from the path; the sub-tabs are component state, so the four legacy routes that
 * named them (`/team/reviews`, `/team/inbox`, `/team/flow`, `/team/analytics`) seed them at mount.
 */
export function useTeamNavigation(selectedTeamId: string | undefined) {
  const search = useSearch({ from: "/team" });
  const runId = search.run ?? "";
  const taskId = search.task ?? "";
  const pathname = useRouterState({ select: state => state.location.pathname });
  const rawSection = pathname.split("/")[2] || "chat";
  const section = teamSection(pathname);
  const navigate = useNavigate();
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>(() =>
    rawSection === "reviews" ? "reviews" : rawSection === "inbox" ? "inbox" : "work");
  const [overviewTab, setOverviewTab] = useState<OverviewTab>(() =>
    rawSection === "analytics" ? "analytics" : rawSection === "flow" ? "flow" : "summary");

  const go = (next: TeamSection, extra?: { run?: string; task?: string; team?: string }) => void navigate({
    to: "/team/$section", params: { section: next }, search: {
      run: extra && "run" in extra ? extra.run : runId || undefined,
      team: extra && "team" in extra ? extra.team : selectedTeamId,
      task: extra && "task" in extra ? extra.task : (["tasks", "workspace"].includes(next) ? taskId || undefined : undefined),
    },
  });
  const hrefFor = (next: TeamSection) => `/team/${next}?${new URLSearchParams({
    ...(runId ? { run: runId } : {}),
    ...(selectedTeamId ? { team: selectedTeamId } : {}),
    ...(["tasks", "workspace"].includes(next) && taskId ? { task: taskId } : {}),
  })}`;
  const openProject = (id: string) => go("chat", { team: id || undefined, run: undefined, task: undefined });

  return { runId, taskId, rawSection, section, go, hrefFor, openProject, workspaceTab, setWorkspaceTab, overviewTab, setOverviewTab };
}

export type TeamNavigation = ReturnType<typeof useTeamNavigation>;