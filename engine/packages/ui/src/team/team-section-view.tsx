import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { MessageKey } from "@loom/i18n";
import type { TeamReviewView } from "@loom/daemon/team-control";
import { DocumentsScreen } from "./documents.js";
import { InboxScreen } from "./inbox.js";
import { ProjectHome } from "./project-home.js";
import { ProjectFiles } from "./project-files.js";
import { ProjectsScreen } from "./create-project.js";
import { Overview } from "./overview.js";
import { TasksScreen } from "./tasks.js";
import { WorkspaceScreen } from "./workspace/workspace-screen.js";
import { ReviewsScreen } from "./reviews.js";
import { AnalyticsScreen } from "./analytics.js";
import { ChatMainScreen } from "./chat-main.js";
import { TabGroup } from "./tab-group.js";
import { adaptTeamEvents, mapTeamAttemptStates, mapTeamSeats } from "./flow/team-flow-adapter.js";
import { FlowView } from "./flow/FlowView.js";
import { useAttemptModels, useTeamModelSettings } from "./hooks.js";
import type { TeamWorkspace } from "./workspace-data.js";
import type { OverviewTab, TeamNavigation, WorkspaceTab } from "./workspace-navigation.js";

/** What the destinations ask the shell to open; each one is a dialog or drawer state it owns. */
export interface WorkspaceActions {
  onOpenChat: (opener: HTMLButtonElement) => void;
  onAskLead: (task: TeamReviewView, opener: HTMLButtonElement) => void;
  onDiscussDocument: (opener: HTMLButtonElement, body?: string) => void;
  onNewWork: (teamId: string) => void;
  onOpenCreate: (opener: HTMLButtonElement) => void;
  onOpenExisting: (opener: HTMLButtonElement) => void;
  onOpenSettings: () => void;
}

export interface SectionViewProps extends WorkspaceActions {
  workspace: TeamWorkspace;
  navigation: TeamNavigation;
  banner?: ReactNode;
}

const WORKSPACE_TABS: ReadonlyArray<{ id: WorkspaceTab; label: MessageKey; needsRun?: boolean }> = [
  { id: "files", label: "files.title" },
  { id: "work", label: "workspace.tabWork", needsRun: true },
  { id: "inbox", label: "workspace.tabInbox", needsRun: true },
  { id: "reviews", label: "workspace.tabReviews", needsRun: true },
];
const OVERVIEW_TABS: ReadonlyArray<{ id: OverviewTab; label: MessageKey }> = [
  { id: "summary", label: "overview.tabSummary" },
  { id: "flow", label: "overview.tabFlow" },
  { id: "analytics", label: "overview.tabAnalytics" },
];

/** The Flow sub-tab owns the model it draws: the settings and launch reads exist only for it. */
function FlowDestination({ workspace, runId }: { workspace: TeamWorkspace; runId: string }) {
  const { selectedTeamId, read, events } = workspace;
  const modelSettings = useTeamModelSettings(selectedTeamId ?? "", true);
  const observedModels = useAttemptModels(read, true);
  // The canvas rebuilds when its props change identity; key the observed models by content so
  // the memo holds across parent renders, and derive the rest from the read they came from.
  const observedModelsKey = JSON.stringify([...observedModels].sort(([a], [b]) => a.localeCompare(b)));
  const seats = useMemo(() => mapTeamSeats(read?.seats ?? [], read?.attempts ?? [], modelSettings.data?.settings, observedModels),
    [read?.seats, read?.attempts, modelSettings.data?.settings, observedModelsKey]);
  const nodeStates = useMemo(() => mapTeamAttemptStates(read?.attempts ?? [], read?.seats), [read?.attempts, read?.seats]);
  const flowEvents = useMemo(() => adaptTeamEvents(events?.events ?? [], runId), [events?.events, runId]);
  return <FlowView key={runId} events={flowEvents}
    loading={!!runId && (workspace.runPending || (!!read && events === undefined))}
    error={!!workspace.runError}
    seats={seats} nodeStates={nodeStates} />;
}

function WorkspaceDestination({ workspace, navigation, onAskLead }: SectionViewProps) {
  const { t } = useTranslation();
  const { read, selectedTeamId, integration, integrationError } = workspace;
  const { runId, taskId, workspaceTab, setWorkspaceTab, go } = navigation;
  const tab: WorkspaceTab = !runId ? "files" : workspaceTab;
  return <div className="ui-screen">
    <TabGroup label={t("nav.workspace")} value={tab} onChange={setWorkspaceTab}
      items={WORKSPACE_TABS.map(({ id, label, needsRun }) => ({ id, label: t(label), disabled: needsRun && !runId }))} />
    {tab === "files" ? selectedTeamId ? <ProjectFiles key={"files-" + selectedTeamId} projectId={selectedTeamId} />
      : <p className="ui-muted ui-workbench-empty">{t("shell.chooseProject")}</p>
      : tab === "work" ? <WorkspaceScreen key={"workspace-" + runId} read={read} selectedTaskId={taskId} />
        : tab === "inbox" ? <InboxScreen teamId={selectedTeamId} onOpenRun={id => go("overview", { run: id, task: undefined })} />
          : <ReviewsScreen read={read} selectedTaskId={taskId} integration={integrationError ? undefined : integration}
            onSelect={task => go("workspace", { task })} onAskLead={onAskLead} />}
  </div>;
}

function OverviewDestination({ workspace, navigation, onOpenChat }: SectionViewProps) {
  const { t } = useTranslation();
  const { read, chat, integration, health, healthError } = workspace;
  const { overviewTab, setOverviewTab, go, runId, setWorkspaceTab } = navigation;
  return <div className="ui-screen">
    <TabGroup label={t("nav.overview")} value={overviewTab} onChange={setOverviewTab}
      items={OVERVIEW_TABS.map(({ id, label }) => ({ id, label: t(label) }))} />
    {overviewTab === "summary"
      ? <Overview read={read} chat={chat} integration={integration} health={healthError ? undefined : health}
        onOpenWorkspace={task => { setWorkspaceTab("work"); go("workspace", { task }); }}
        onOpenReviews={task => { setWorkspaceTab("reviews"); go("workspace", { task }); }}
        onOpenTasks={() => go("tasks")} onOpenTask={task => go("tasks", { task })}
        onOpenChat={onOpenChat} />
      : overviewTab === "flow" ? <FlowDestination workspace={workspace} runId={runId} />
        : <AnalyticsScreen teamId={workspace.selectedTeamId} seats={read?.seats} />}
  </div>;
}

/** The content switch: one destination per section, all reading the same workspace and navigation. */
export function TeamSectionView(props: SectionViewProps) {
  const { t } = useTranslation();
  const { workspace, navigation, onOpenChat, onAskLead, onDiscussDocument, onNewWork, onOpenCreate, onOpenExisting } = props;
  const { section, go, runId, taskId, openProject, setWorkspaceTab } = navigation;
  const { paired, read, chat, chatError, runs, teams, selectedTeamId, team } = workspace;

  if (!paired) return null;
  if (!runId && (teams.isError || runs.isError)) {
    return <div className="page"><p role="alert">{t("records.readFailed")}</p>
      <button className="btn btn-outline" onClick={workspace.refetchTeams}>{t("action.retry")}</button></div>;
  }
  // A project without a run shows its own history for every destination but Workspace.
  if (!runId && section !== "workspace" && section !== "chat") {
    return team ? <ProjectHome team={team} runs={workspace.currentRuns} section={section}
      onOpenRun={(id, destination) => {
        if (destination === "reviews") { setWorkspaceTab("reviews"); go("workspace", { run: id, task: undefined }); }
        else go(destination, { run: id, task: undefined });
      }} onDiscuss={onOpenChat} onModels={props.onOpenSettings} />
      : <ProjectsScreen teams={teams.data} runs={runs.data} loading={teams.isPending} onOpenProject={openProject}
        onOpenRun={nextRun => go("overview", { run: nextRun, task: undefined })}
        onNewWork={onNewWork} onCreate={onOpenCreate} onOpenExisting={onOpenExisting} />;
  }
  switch (section) {
    case "chat":
      if (!runId && !team) {
        return <ProjectsScreen teams={teams.data} runs={runs.data} loading={teams.isPending} onOpenProject={openProject}
          onOpenRun={nextRun => go("chat", { run: nextRun, task: undefined })}
          onNewWork={onNewWork} onCreate={onOpenCreate} onOpenExisting={onOpenExisting} />;
      }
      return <ChatMainScreen key={`chat-main:${runId || team?.id}`} read={read} runId={runId} chat={chat}
        connectionError={chatError} project={team}
        onStarted={nextRun => { workspace.refetchRuns(); go("chat", { run: nextRun }); }}
        onChanged={workspace.refresh}
        onOpenDocuments={() => go("documents")} onOpenOverview={() => go("overview")} />;
    case "documents":
      return <DocumentsScreen key={`documents:${runId}`} read={read} chat={chat} failed={chatError}
        onChanged={workspace.refresh} onDiscuss={onDiscussDocument} />;
    case "tasks":
      return <TasksScreen read={read} selectedTaskId={taskId}
        onSelect={task => go("tasks", { task })}
        onOpenWorkspace={task => { setWorkspaceTab("work"); go("workspace", { task }); }}
        onOpenReviews={task => { setWorkspaceTab("reviews"); go("workspace", { task }); }}
        onNewTask={() => { if (selectedTeamId) onNewWork(selectedTeamId); }} />;
    case "workspace":
      return <WorkspaceDestination {...props} />;
    default:
      return <OverviewDestination {...props} />;
  }
}
