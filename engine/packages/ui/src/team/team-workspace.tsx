import { useRef, useState } from "react";
import { useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { InterfaceI18n } from "@loom/i18n";
import type { TeamReviewView } from "@loom/daemon/team-control";
import { useOwnerSession } from "../hooks/useOwnerSession.js";
import { readableBranch, taskName } from "./display.js";
import { useTeamWorkspace } from "./workspace-data.js";
import { useTeamNavigation } from "./workspace-navigation.js";
import { TeamSectionView, type WorkspaceActions } from "./team-section-view.js";
import { ShellFrame, type ShellChrome } from "./shell-frame.js";
import { ContextPanel } from "./context-panel.js";
import { SettingsSheet } from "./settings-sheet.js";
import { SetupScreen } from "./setup.js";
import { CommandPalette } from "./command-palette.js";
import { CreateProject } from "./create-project.js";
import { NewWorkSheet } from "./new-task.js";
import { ChatPanel } from "./chat-panel.js";
import type { useThemePreference } from "./theme.js";

export function TeamWorkspaceScreen({ language, onLanguage, appearance }: {
  language: InterfaceI18n; onLanguage: (next: "zh-CN" | "en") => void;
  appearance: ReturnType<typeof useThemePreference>;
}) {
  const { t } = useTranslation();
  const { paired } = useOwnerSession();
  const search = useSearch({ from: "/team" });
  const workspace = useTeamWorkspace(search.run ?? "", search.team);
  const navigation = useTeamNavigation(workspace.selectedTeamId);
  const { section, runId, go, hrefFor } = navigation;

  const [chatOpen, setChatOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(() => navigation.rawSection === "settings");
  const [setupOpen, setSetupOpen] = useState(false);
  const [draftContext, setDraftContext] = useState<{ runId: string; body: string }>();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newWorkFor, setNewWorkFor] = useState<string | null>(null);
  const [creating, setCreating] = useState(false), [opening, setOpening] = useState(false);
  const createOpener = useRef<HTMLElement>(null), openOpener = useRef<HTMLElement>(null);
  const newWorkOpener = useRef<HTMLElement>(null);
  const chatOpener = useRef<HTMLButtonElement>(null);
  const paletteOpener = useRef<HTMLElement>(null);

  const openNewWork = (teamId: string, opener?: HTMLElement) => {
    if (opener) newWorkOpener.current = opener;
    setNewWorkFor(teamId);
  };

  const openChat = (opener: HTMLButtonElement) => {
    chatOpener.current = opener;
    const previous = workspace.currentRuns.find(run => run.phase === "planning" && !["canceled", "cancel_requested", "invalidated"].includes(run.state));
    if (!runId && previous) go(section, { run: previous.id });
    if (section === "chat") setContextOpen(false);
    else setChatOpen(true);
  };
  const openCreate = (opener: HTMLButtonElement) => { createOpener.current = opener; setCreating(true); };
  const openExisting = (opener: HTMLButtonElement) => { openOpener.current = opener; setOpening(true); };
  const openProject = (id: string) => { setChatOpen(false); go("chat", { team: id || undefined, run: undefined, task: undefined }); };
  const actions: WorkspaceActions = {
    onOpenChat: openChat,
    onAskLead: (task: TeamReviewView, opener: HTMLButtonElement) => {
      chatOpener.current = opener;
      setDraftContext({ runId, body: t("reviews.chatContext", { task: taskName(task, t) }) });
      setChatOpen(true);
    },
    onDiscussDocument: (opener: HTMLButtonElement, body?: string) => {
      chatOpener.current = opener; if (body) setDraftContext({ runId, body }); setChatOpen(true);
    },
    onNewWork: openNewWork,
    onOpenCreate: openCreate,
    onOpenExisting: openExisting,
    onOpenSettings: () => setSettingsOpen(true),
  };

  const chrome: ShellChrome = {
    project: workspace.teamName,
    runName: workspace.runName ? workspace.runName + " · " + t(workspace.read?.run.phase === "planning" ? "planning.mode" : "execution.mode")
      : workspace.team ? t("records.projectHistory") : "",
    coordinator: workspace.coordinator,
    connection: workspace.connection,
    streamError: workspace.events?.lastError?.message,
    branch: readableBranch(workspace.integration?.branch ?? ""),
    notifications: workspace.attention,
    canChat: paired && (!!runId || !!workspace.team?.seats.some(seat => seat.role === "lead")),
    avatarState: workspace.avatarState,
    action: workspace.canStartWork ? <button className="btn btn-quiet ui-new-work" onClick={event => { if (workspace.selectedTeamId) openNewWork(workspace.selectedTeamId, event.currentTarget); }}>{t("team.teams.newWork")}</button> : undefined,
    projectPicker: <select className="ui-project-picker" aria-label={t("shell.project")} value={workspace.team?.id ?? ""} onChange={event => openProject(event.target.value)}>
      <option value="">{t("shell.allProjects")}</option>{workspace.teams.data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>,
    runPicker: workspace.team ? <select className="ui-runselect" aria-label={t("shell.run")} value={runId}
      onChange={event => go(section, { run: event.target.value || undefined, task: undefined })}>
      <option value="">{t("records.projectHistory")}</option>
      {(["planning", "delivery"] as const).map(phase => <optgroup key={phase} label={t(phase === "planning" ? "records.planning" : "records.execution")}>
        {workspace.currentRuns.filter(run => (run.phase ?? "delivery") === phase).map(run => <option key={run.id} value={run.id}>{run.displayName}</option>)}
      </optgroup>)}</select> : undefined,
  };

  // Setup is its own screen, above the shell and the GitHub gate: it is the way back to the proxy
  // that a blocked sign-in needs. It keeps the shell's own wrapper, because its styles are scoped
  // to that wrapper and the first-run route reaches it through one.
  if (setupOpen) return <div className="team-shell ui-entry" data-ui-theme={appearance.theme} lang={language.language}>
    <SetupScreen onContinue={() => setSetupOpen(false)} />
  </div>;
  return <ShellFrame
    language={language}
    section={section}
    appearance={appearance}
    chrome={chrome}
    contextOpen={contextOpen}
    onToggleContext={() => setContextOpen(open => !open)}
    onOpenSettings={() => setSettingsOpen(true)}
    contextPanel={<ContextPanel workspace={workspace} onClose={() => setContextOpen(false)} go={go} />}
    onLanguage={onLanguage}
    hrefFor={hrefFor}
    onSelect={go}
    onOpenChat={openChat}
    onSearch={opener => { paletteOpener.current = opener; setPaletteOpen(true); }}
    onCreateProject={openCreate}
  >
    {workspace.read?.run.phase === "planning" && section !== "chat" && <p className="ui-phase-banner" role="status">{t("planning.executionGate")}</p>}
    <TeamSectionView workspace={workspace} navigation={navigation} {...actions} />
    {paired && (runId || workspace.team) && <ChatPanel key={`chat:${runId || workspace.team?.id}`} read={workspace.read} runId={runId} chat={workspace.chat}
      connectionError={workspace.chatError} project={workspace.team}
      onStarted={nextRun => { workspace.refetchRuns(); go("chat", { run: nextRun }); }}
      onChanged={workspace.refresh} onOpenDocuments={() => { setChatOpen(false); go("documents"); }}
      open={chatOpen} onOpenChange={setChatOpen} opener={chatOpener} draftContext={draftContext?.runId === runId ? draftContext : undefined} />}
    <CommandPalette open={paired && paletteOpen} onOpenChange={setPaletteOpen} tasks={paired ? workspace.read?.tasks ?? [] : []}
      onChoose={task => go("tasks", { task })} opener={paletteOpener} />
    <CreateProject open={creating} onOpenChange={setCreating} opener={createOpener}
      onCreated={created => go("chat", { team: created.id, run: undefined, task: undefined })} />
    <CreateProject open={opening} mode="open" onOpenChange={setOpening} opener={openOpener}
      onCreated={created => go("chat", { team: created.id, run: undefined, task: undefined })} />
    {newWorkFor && <NewWorkSheet teams={workspace.teams.data} teamId={newWorkFor} open opener={newWorkOpener}
      onOpenChange={open => { if (!open) setNewWorkFor(null); }} onStarted={nextRun => { setNewWorkFor(null); go("chat", { run: nextRun }); }} />}
    <SettingsSheet open={settingsOpen} onOpenChange={setSettingsOpen} language={language} onLanguage={onLanguage} appearance={appearance}
      props={{
        seats: workspace.read?.seats ?? workspace.team?.seats ?? [],
        address: window.location.origin,
        // Setup is its own screen; leaving Settings open would put it back after Continue.
        onSetup: () => { setSetupOpen(true); setSettingsOpen(false); },
        teamId: workspace.team?.seats.some(seat => seat.role === "lead") ? workspace.team.id : undefined,
      }} />
  </ShellFrame>;
}