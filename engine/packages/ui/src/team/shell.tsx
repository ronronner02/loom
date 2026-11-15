import { useEffect, useRef, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { createInterfaceI18n, type InterfaceI18n, type MessageKey } from "@multi-agent/i18n";
import { I18nextProvider, useTranslation } from "react-i18next";
import {
  Bell,
  FileText,
  FolderPlus,
  GitBranch,
  LayoutDashboard,
  ListTodo,
  Menu,
  MessageSquare,
  Search,
  Settings,
  Users,
  X,
} from "lucide-react";
import { OwnerReadError, OwnerSessionProvider, useOwnerSession } from "../hooks/useOwnerSession.js";
import { useTeamRun } from "../hooks/useTeamRun.js";
import { useAttemptStatus } from "../hooks/useAttemptStatus.js";
import type { TeamOwnerRead } from "@multi-agent/daemon/team-control";
import { useIntegration, useRuns, useTeamChat, useTeams, type TeamSummary } from "./hooks.js";
import { DocumentsScreen } from "./documents.js";
import { InboxScreen } from "./inbox.js";
import { ProjectHome } from "./project-home.js";
import { CreateProject, ProjectsScreen } from "./create-project.js";
import { Overview } from "./overview.js";
import { TasksScreen } from "./tasks.js";
import { WorkspaceScreen } from "./workspace/workspace-screen.js";
import { ReviewsScreen } from "./reviews.js";
import { SettingsScreen } from "./settings.js";
import { AnalyticsScreen } from "./analytics.js";
import { NewWorkSheet } from "./new-task.js";
import { isFinished, namedSeat, readableBranch, taskName } from "./display.js";
import { isRunActive } from "./clients.js";
import { TEAM_THEME_PREFERENCES, useThemePreference } from "./theme.js";
import { EntryFrame, GithubGate } from "./github-gate.js";
import { ChatPanel, Composer, LeadConversation, pendingOwnerDecisions, pendingWorkerQuestions } from "./chat-panel.js";
import { CommandPalette } from "./command-palette.js";
import { FlowView } from "./flow/FlowView.js";
import { adaptTeamEvents, mapTeamSeat } from "./flow/team-flow-adapter.js";
import "./fonts.js";
import "./team.css";

export const INTERFACE_LANGUAGE_KEY = "multi-agent.interfaceLanguage";
export const TEAM_SECTIONS = ["chat", "overview", "tasks", "workspace", "documents"] as const;
export type TeamSection = (typeof TEAM_SECTIONS)[number];
type TeamDestination = TeamSection;
const DESTINATIONS: readonly string[] = TEAM_SECTIONS;
const LEGACY_SECTIONS: Readonly<Record<string, TeamSection>> = {
  agents: "workspace",
  logs: "workspace",
  knowledge: "workspace",
  decisions: "workspace",
  reviews: "workspace",
  inbox: "workspace",
  analytics: "overview",
  flow: "overview",
};

export function teamSection(pathname: string): TeamDestination {
  const raw = pathname.split("/")[2] || "chat";
  return LEGACY_SECTIONS[raw] ?? (DESTINATIONS.includes(raw) ? raw as TeamDestination : "chat");
}

const SECTION_LABELS: Record<TeamDestination, MessageKey> = {
  chat: "nav.chat",
  overview: "nav.overview",
  tasks: "nav.tasks",
  workspace: "nav.workspace",
  documents: "nav.documents",
};

const NAV_ICONS = {
  chat: MessageSquare,
  overview: LayoutDashboard,
  tasks: ListTodo,
  workspace: Users,
  documents: FileText,
};

export function Pairing() {
  const { t } = useTranslation();
  const { paired, pair, revoke, reconnect, canReconnect } = useOwnerSession();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return <div className="page page-narrow">
    <section className="plate" aria-label={t(canReconnect ? "settings.connection" : "web.pair")}>
      {paired ? <>
        <h2 className="plate-title">{t("web.paired")}</h2>
        <div className="plate-foot"><button className="btn btn-outline" disabled={busy} onClick={async () => {
          setBusy(true); setFailed(false);
          try { await revoke(); } catch { setFailed(true); } finally { setBusy(false); }
        }}>{t("web.revoke")}</button></div>
      </> : canReconnect ? <>
        <h2 className="plate-title">{t("settings.connection")}</h2>
        <button className="btn btn-primary" disabled={busy} onClick={async () => {
          setBusy(true); setFailed(false);
          try { if (!await reconnect()) setFailed(true); } catch { setFailed(true); } finally { setBusy(false); }
        }}>{t(busy ? "team.connecting" : "action.retry")}</button>
      </> : <>
        <h2 className="plate-title">{t("web.pairRequired")}</h2>
        <form onSubmit={async event => {
          event.preventDefault(); setBusy(true); setFailed(false);
          try { await pair(code); setCode(""); } catch { setFailed(true); } finally { setBusy(false); }
        }} style={{ display: "grid", gap: 12 }}>
          <div className="field">
            <label htmlFor="pair-code">{t("web.pairCode")}</label>
            <input id="pair-code" className="input mono" type="password" autoComplete="off"
              value={code} onChange={event => setCode(event.target.value)} />
          </div>
          <div className="plate-foot">
            <button className="btn btn-primary" type="submit" disabled={busy || !code}>{t("web.pair")}</button>
          </div>
        </form>
      </>}
      {failed && <p role="alert" style={{ color: "var(--danger)", fontSize: 13 }}>{t(paired || canReconnect ? "web.sessionError" : "web.pairError")}</p>}
    </section>
  </div>;
}

/** Muse-style slim left icon rail + centered main column + on-demand right context panel. */
export function ShellFrame({ language, section, appearance, project, projectPicker, runName, runPicker, coordinator,
  connection, branch, notifications, canChat, contextOpen = false, onToggleContext, onOpenSettings,
  onLanguage, hrefFor, onSelect, onOpenChat, onSearch, onCreateProject, action, contextPanel, children }: {
  language: InterfaceI18n; section: TeamDestination; appearance: ReturnType<typeof useThemePreference>;
  project: string; projectPicker?: ReactNode; runName: string; runPicker?: ReactNode; coordinator: MessageKey;
  connection: MessageKey; branch: string; notifications: number; canChat: boolean;
  contextOpen?: boolean; onToggleContext?: () => void; onOpenSettings?: () => void;
  onLanguage: (next: "zh-CN" | "en") => void; hrefFor: (section: TeamSection) => string;
  onSelect: (section: TeamSection) => void; onOpenChat: (opener: HTMLButtonElement) => void;
  onSearch: (opener: HTMLElement) => void; onCreateProject?: (opener: HTMLButtonElement) => void;
  action?: ReactNode; backgroundMotion?: boolean; contextPanel?: ReactNode; children: ReactNode;
}) {
  const { t } = useTranslation();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const navigationTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const jump = (event: KeyboardEvent) => {
      if (canChat && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault(); setNavigationOpen(false);
        onSearch(navigationOpen && navigationTrigger.current ? navigationTrigger.current : document.activeElement as HTMLElement);
      } else if ((event.ctrlKey || event.metaKey) && event.key === ",") {
        if (onOpenSettings) {
          event.preventDefault();
          onOpenSettings();
        }
      }
    };
    window.addEventListener("keydown", jump);
    return () => window.removeEventListener("keydown", jump);
  }, [canChat, navigationOpen, onOpenSettings, onSearch]);

  const rail = <>
    <div className="ui-brand" title={t("shell.appName")}>
      <img className="ui-brand-icon" src="/loom-icon.png" alt="" aria-hidden="true" />
    </div>
    <button
      type="button"
      className="ui-rail-search"
      disabled={!canChat}
      aria-label={t("shell.search")}
      title={`${t("shell.search")} (${t("shell.ctrlK")})`}
      onClick={event => {
        setNavigationOpen(false);
        onSearch(event.currentTarget);
      }}
    >
      <Search aria-hidden="true" />
    </button>
    <nav className="ui-nav" aria-label={t("shell.appName")}>
      {TEAM_SECTIONS.map(id => {
        const Icon = NAV_ICONS[id];
        return <a
          key={id}
          href={hrefFor(id)}
          title={t(`nav.${id}`)}
          aria-current={section === id ? "page" : undefined}
          onClick={event => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault(); onSelect(id); setNavigationOpen(false);
          }}
        >
          <Icon aria-hidden="true" />
          <span>{t(`nav.${id}`)}</span>
        </a>;
      })}
    </nav>
    <div className="ui-sidebar-foot">
      {onCreateProject && <button
        type="button"
        className="ui-rail-btn"
        aria-label={t("projects.create")}
        title={t("projects.create")}
        onClick={event => {
          const opener = navigationOpen && navigationTrigger.current ? navigationTrigger.current : event.currentTarget;
          setNavigationOpen(false); onCreateProject(opener);
        }}
      >
        <FolderPlus aria-hidden="true" />
      </button>}
      {onOpenSettings && <button
        type="button"
        className="ui-rail-btn"
        aria-label={t("nav.settings")}
        title={t("nav.settings")}
        onClick={() => { setNavigationOpen(false); onOpenSettings(); }}
      >
        <Settings aria-hidden="true" />
      </button>}
      <div className="lang" role="group" aria-label={t("team.settings.language")}>
        <button aria-pressed={language.language === "zh-CN"} onClick={() => onLanguage("zh-CN")}>中</button>
        <button aria-pressed={language.language === "en"} onClick={() => onLanguage("en")}>EN</button>
      </div>
    </div>
  </>;

  const navSection = t(SECTION_LABELS[section]);
  return <Dialog.Root open={navigationOpen} onOpenChange={setNavigationOpen}>
    <div className="team-shell" lang={language.language} data-ui-theme={appearance.theme} data-testid="team-shell">
      <aside className="ui-sidebar ui-rail">{rail}</aside>
      <div className="ui-content">
        <header className="ui-topstrip">
          <Dialog.Trigger ref={navigationTrigger} className="ui-icon-button ui-menu-button" aria-label={t("shell.openNavigation")}>
            <Menu aria-hidden="true" />
          </Dialog.Trigger>
          <div className="ui-breadcrumb">
            {projectPicker ?? <span>{project || t("shell.project")}</span>}
            {runPicker && <><span aria-hidden="true">/</span>{runPicker}</>}
            {!runPicker && runName && <><span aria-hidden="true">/</span><span className="ui-run-name">{runName}</span></>}
            <span className="ui-current-section sr-only">{navSection}</span>
          </div>
          <div className="ui-top-meta">
            {action}
            <button
              type="button"
              className="ui-agent-pill"
              aria-expanded={contextOpen}
              aria-label={t("shell.contextPanel")}
              onClick={() => onToggleContext?.()}
            >
              <span className="ui-agent-avatar" aria-hidden="true">L</span>
              <span>{t("shell.coordinator")}</span>
              <span className="ui-dot" data-state={["shell.active", "status.attempt.working", "status.attempt.started"].includes(coordinator) ? "ok" : "unknown"} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="ui-icon-button"
              disabled={!canChat}
              aria-label={t("shell.openChat")}
              onClick={event => onOpenChat(event.currentTarget)}
            >
              <MessageSquare aria-hidden="true" />
            </button>
            <button
              type="button"
              className="ui-bell ui-icon-button"
              disabled={!canChat}
              aria-label={t("shell.notificationsCount", { count: notifications })}
              onClick={event => onOpenChat(event.currentTarget)}
            >
              <Bell aria-hidden="true" />
              {notifications > 0 && <span className="ui-badge">{notifications}</span>}
            </button>
          </div>
        </header>
        <div className="ui-workspace-body">
          <div className="ui-main">
            {["web.stale", "web.disconnected", "web.error", "web.notFound"].includes(connection) &&
              <p className="ui-snapshot-warning" role="alert">{t("shell.snapshotWarning")}</p>}
            {children}
          </div>
          {contextOpen && contextPanel && <aside className="ui-context-panel" aria-label={t("shell.contextPanel")}>
            {contextPanel}
          </aside>}
        </div>
        <nav className="ui-bottom-nav" aria-label={t("shell.navigation")}>
          {TEAM_SECTIONS.map(id => {
            const Icon = NAV_ICONS[id];
            return <a
              key={id}
              href={hrefFor(id)}
              aria-current={section === id ? "page" : undefined}
              onClick={event => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault(); onSelect(id);
              }}
            >
              <Icon aria-hidden="true" />
              <span>{t(`nav.${id}`)}</span>
            </a>;
          })}
        </nav>
        <footer className="ui-footer">
          <span><GitBranch aria-hidden="true" /><span>{branch || t("shell.noBranch")}</span></span>
          <span>
            <span className="ui-dot" data-state={connection === "shell.connected" ? "ok" : "unknown"} aria-hidden="true" />
            <span>{t("shell.runtimeConnection")}: {t(connection)}</span>
          </span>
        </footer>
      </div>
      <Dialog.Overlay className="ui-dialog-overlay" />
      <Dialog.Content className="ui-mobile-sidebar" aria-describedby={undefined}>
        <Dialog.Title className="sr-only">{t("shell.navigation")}</Dialog.Title>
        <Dialog.Close className="ui-icon-button ui-menu-close" aria-label={t("shell.closeNavigation")}><X aria-hidden="true" /></Dialog.Close>
        <div className="ui-appearance">
          <span>{t("shell.appearance")}</span>
          <select aria-label={t("shell.appearance")} value={appearance.preference}
            onChange={event => appearance.setPreference(event.target.value as "dark" | "light" | "system")}>
            {TEAM_THEME_PREFERENCES.map(value => <option key={value} value={value}>{t(`settings.theme.${value}`)}</option>)}
          </select>
        </div>
        {rail}
      </Dialog.Content>
    </div>
  </Dialog.Root>;
}

export function showsNewWork(read?: TeamOwnerRead): boolean {
  if (!read) return false;
  if (!isRunActive(read.run)) return true;
  return read.tasks.length > 0 && read.tasks.every(task => isFinished(task));
}

function ChatMainScreen({ read, runId, chat, connectionError, project, onStarted, onChanged, onOpenDocuments, onOpenOverview }: {
  read?: TeamOwnerRead; runId: string; chat?: ReturnType<typeof useTeamChat>["data"]; connectionError?: boolean;
  project?: TeamSummary; onStarted: (runId: string) => void; onChanged: () => void;
  onOpenDocuments: () => void; onOpenOverview: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const examples = [
    t("chat.examplePlan"),
    t("chat.exampleFix"),
    t("chat.exampleSummary"),
  ];

  if (!runId && project) {
    return <div className="ui-chat-main">
      <div className="ui-chat-welcome">
        <h1>{t("chat.welcomeTitle")}</h1>
        <p>{t("chat.welcomeHint")}</p>
        <div className="ui-example-prompts">
          {examples.map(prompt => (
            <button key={prompt} type="button" className="ui-example-prompt" onClick={() => setDraft(prompt)}>
              {prompt}
            </button>
          ))}
        </div>
      </div>
      <Composer runId="" entityVersion={0} body={draft} onBodyChange={setDraft} projectId={project.id} onStarted={onStarted} />
    </div>;
  }

  return <div className="ui-chat-main">
    <LeadConversation
      read={read}
      runId={runId}
      chat={chat}
      connectionError={connectionError}
      draft={draft}
      onDraftChange={setDraft}
      onChanged={onChanged}
      welcome={chat?.available && chat.messages.length === 0 && !chat.liveTurn ? (
        <div className="ui-chat-welcome">
          <h1>{read?.run.displayName || t("nav.chat")}</h1>
          <p>{t("chat.welcomeHint")}</p>
        </div>
      ) : undefined}
      documentTools={chat?.documentWorkflow && <div className="ui-chat-documents">
        <button type="button" className="btn btn-outline" onClick={onOpenDocuments}>
          <FileText aria-hidden="true" />
          {t("documents.open")}
        </button>
        <button type="button" className="btn btn-quiet" onClick={onOpenOverview}>
          {t("nav.overview")}
        </button>
      </div>}
    />
  </div>;
}

function ManagedShell({ language, onLanguage }: { language: InterfaceI18n; onLanguage: (next: "zh-CN" | "en") => void }) {
  const { paired } = useOwnerSession();
  const appearance = useThemePreference();
  const frame = (content: ReactNode) => <EntryFrame language={language} onLanguage={onLanguage} appearance={appearance}>{content}</EntryFrame>;
  return paired ? <GithubGate frame={frame}><ProjectShell language={language} onLanguage={onLanguage} appearance={appearance} /></GithubGate> : frame(<Pairing />);
}

function ProjectShell({ language, onLanguage, appearance }: {
  language: InterfaceI18n; onLanguage: (next: "zh-CN" | "en") => void;
  appearance: ReturnType<typeof useThemePreference>;
}) {
  const { t } = useTranslation();
  const { paired } = useOwnerSession();
  const search = useSearch({ from: "/team" });
  const runId = search.run ?? "";
  const taskId = search.task ?? "";
  const pathname = useRouterState({ select: state => state.location.pathname });
  const rawSection = pathname.split("/")[2] || "chat";
  const section = teamSection(pathname);
  const navigate = useNavigate();
  const data = useTeamRun(runId);
  const teams = useTeams();
  const runs = useRuns();
  const chat = useTeamChat(runId, paired);
  const integration = useIntegration(runId, paired);

  const [chatOpen, setChatOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(() => rawSection === "settings");
  const [workspaceTab, setWorkspaceTab] = useState<"work" | "inbox" | "reviews">(() =>
    rawSection === "reviews" ? "reviews" : rawSection === "inbox" ? "inbox" : "work");
  const [overviewTab, setOverviewTab] = useState<"summary" | "flow" | "analytics">(() =>
    rawSection === "analytics" ? "analytics" : rawSection === "flow" ? "flow" : "summary");
  const [draftContext, setDraftContext] = useState<{ runId: string; body: string }>();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newWorkFor, setNewWorkFor] = useState<string | null>(null);
  const [creating, setCreating] = useState(false), [opening, setOpening] = useState(false);
  const createOpener = useRef<HTMLElement>(null), openOpener = useRef<HTMLElement>(null);
  const chatOpener = useRef<HTMLButtonElement>(null);
  const paletteOpener = useRef<HTMLElement>(null);

  const read = data.read.data;
  const error = data.read.error ?? data.events.error ?? data.health.error;
  const connection = !paired ? "web.pairRequired"
    : error instanceof OwnerReadError ? (error.status === 404 ? "web.notFound" : "web.error")
      : error instanceof TypeError || data.events.data?.connection === "reconnecting" ? "web.disconnected" : error ? "web.error"
        : (runId ? data.read.isPending : data.health.isPending) ? "web.loading" : "shell.connected";
  const selectedTeamId = read?.run.rigId ?? runs.data?.find(entry => entry.id === runId)?.rigId ?? search.team;
  const team = teams.data?.find(entry => entry.id === selectedTeamId);
  const teamName = team?.name ?? runs.data?.find(entry => entry.id === runId)?.rigName ?? "";
  const runName = read?.run.displayName ?? runs.data?.find(entry => entry.id === runId)?.displayName ?? "";
  const lead = read?.attempts.filter(attempt => attempt.role === "lead").at(-1);
  const leadStatus = useAttemptStatus(runId, lead, !!chat.data?.liveTurn?.progress?.sequence);
  const coordinator: MessageKey = !read ? "web.unknown" : !leadStatus ? "shell.idle" : `status.attempt.${leadStatus}`;

  const go = (next: TeamDestination, extra?: { run?: string; task?: string; team?: string }) => void navigate({
    to: "/team/$section", params: { section: next }, search: {
      run: extra && "run" in extra ? extra.run : runId || undefined,
      team: extra && "team" in extra ? extra.team : selectedTeamId,
      task: extra && "task" in extra ? extra.task : (["tasks", "workspace"].includes(next) ? taskId || undefined : undefined),
    },
  });
  const canStartWork = showsNewWork(read) && runId !== "";
  const currentRuns = runs.data?.filter(run => run.rigId === selectedTeamId) ?? [];
  const openProject = (id: string) => { setChatOpen(false); go("chat", { team: id || undefined, run: undefined, task: undefined }); };
  const openChat = (opener: HTMLButtonElement) => {
    chatOpener.current = opener;
    const previous = currentRuns.find(run => run.phase === "planning" && !["canceled", "cancel_requested", "invalidated"].includes(run.state));
    if (!runId && previous) go(section, { run: previous.id });
    if (section === "chat") setContextOpen(false);
    else setChatOpen(true);
  };
  const openCreate = (opener: HTMLButtonElement) => { createOpener.current = opener; setCreating(true); };
  const openExisting = (opener: HTMLButtonElement) => { openOpener.current = opener; setOpening(true); };
  const pendingDecisions = paired ? pendingOwnerDecisions(read, chat.data) : [];
  const pendingQuestions = paired ? pendingWorkerQuestions(read) : [];
  const activeSeats = read?.seats.filter(seat => !seat.retired) ?? [];

  const contextPanel = <>
    <div className="ui-context-head">
      <div className="ui-context-identity">
        <span className="ui-context-avatar" aria-hidden="true">L</span>
        <div>
          <strong>{t("shell.coordinator")}</strong>
          <div className="ui-status" style={{ fontSize: 12, color: "var(--ui-muted)", marginTop: 2 }}>
            <span className="ui-dot" data-state={["shell.active", "status.attempt.working", "status.attempt.started"].includes(coordinator) ? "ok" : "unknown"} aria-hidden="true" />
            <span>{t(coordinator)}</span>
          </div>
        </div>
      </div>
      <button type="button" className="ui-icon-button" aria-label={t("shell.closeContextPanel")} onClick={() => setContextOpen(false)}>
        <X aria-hidden="true" />
      </button>
    </div>
    <section className="ui-context-section">
      <h3>{t("shell.ownerDecisions")}</h3>
      {pendingDecisions.length === 0 && pendingQuestions.length === 0
        ? <p className="ui-muted" style={{ margin: 0, fontSize: 13 }}>{t("tasks.empty")}</p>
        : <ul className="ui-fleet-list">
            {pendingDecisions.map((decision, idx) => (
              <li key={idx}>
                <span className="ui-dot" data-state="awaiting-decision" aria-hidden="true" />
                <span>{decision.kind === "plan" ? t("overview.planApproval") : decision.kind === "resume" ? t("team.resume.action") : decision.message.body}</span>
              </li>
            ))}
            {pendingQuestions.map(q => (
              <li key={q.taskId}>
                <span className="ui-dot" data-state="awaiting-decision" aria-hidden="true" />
                <span>{q.title}</span>
              </li>
            ))}
          </ul>}
    </section>
    <section className="ui-context-section">
      <h3>{t("overview.fleet")}</h3>
      {activeSeats.length === 0
        ? <p className="ui-muted" style={{ margin: 0, fontSize: 13 }}>{t("settings.noSeats")}</p>
        : <ul className="ui-fleet-list">
            {activeSeats.map(seat => (
              <li key={seat.seat}>
                <span className="ui-dot" data-state="ok" aria-hidden="true" />
                <strong>{namedSeat(seat, t)}</strong>
              </li>
            ))}
          </ul>}
    </section>
    {read && <section className="ui-context-section">
      <h3>{t("nav.tasks")}</h3>
      <p className="ui-muted" style={{ margin: 0, fontSize: 13 }}>
        {t("tasks.count", { count: read.tasks.length })}
      </p>
      <button type="button" className="btn btn-outline" onClick={() => go("tasks")}>
        {t("nav.tasks")}
      </button>
    </section>}
  </>;

  let content: ReactNode;
  if (!paired) content = <Pairing />;
  else if (!runId && (teams.isError || runs.isError)) content = <div className="page"><p role="alert">{t("records.readFailed")}</p>
    <button className="btn btn-outline" onClick={() => { void teams.refetch(); void runs.refetch(); }}>{t("action.retry")}</button></div>;
  else if (section === "chat") {
    if (!runId && !team) {
      content = <ProjectsScreen teams={teams.data} runs={runs.data} loading={teams.isPending} onOpenProject={openProject}
        onOpenRun={nextRun => go("chat", { run: nextRun, task: undefined })} onNewWork={setNewWorkFor} onCreate={openCreate} onOpenExisting={openExisting} />;
    } else {
      content = <ChatMainScreen
        read={read}
        runId={runId}
        chat={chat.data}
        connectionError={chat.isError}
        project={team}
        onStarted={nextRun => { void runs.refetch(); go("chat", { run: nextRun }); }}
        onChanged={() => { void chat.refetch(); void data.read.refetch(); }}
        onOpenDocuments={() => go("documents")}
        onOpenOverview={() => go("overview")}
      />;
    }
  }
  else if (!runId) content = team ? <ProjectHome team={team} runs={currentRuns} section={section}
    onOpenRun={(id, destination) => {
      if (destination === "reviews") { setWorkspaceTab("reviews"); go("workspace", { run: id, task: undefined }); }
      else go(destination, { run: id, task: undefined });
    }} onDiscuss={openChat} onModels={() => setSettingsOpen(true)} />
    : <ProjectsScreen teams={teams.data} runs={runs.data} loading={teams.isPending} onOpenProject={openProject}
      onOpenRun={nextRun => go("overview", { run: nextRun, task: undefined })} onNewWork={setNewWorkFor} onCreate={openCreate} onOpenExisting={openExisting} />;
  else if (section === "documents") content = <DocumentsScreen key={`documents:${runId}`} read={read} chat={chat.data} failed={chat.isError}
    onChanged={() => { void chat.refetch(); void data.read.refetch(); }} onDiscuss={(opener, body) => {
      chatOpener.current = opener; if (body) setDraftContext({ runId, body }); setChatOpen(true);
    }} />;
  else if (section === "tasks") content = <TasksScreen read={read} selectedTaskId={taskId}
    onSelect={task => go("tasks", { task })} onOpenWorkspace={task => { setWorkspaceTab("work"); go("workspace", { task }); }}
    onOpenReviews={task => { setWorkspaceTab("reviews"); go("workspace", { task }); }} onNewTask={() => { if (selectedTeamId) setNewWorkFor(selectedTeamId); }} />;
  else if (section === "workspace") content = <div className="ui-screen">
    <div className="ui-subtabs" role="group" aria-label={t("nav.workspace")}>
      <button type="button" aria-pressed={workspaceTab === "work"} onClick={() => setWorkspaceTab("work")}>{t("workspace.tabWork")}</button>
      <button type="button" aria-pressed={workspaceTab === "inbox"} onClick={() => setWorkspaceTab("inbox")}>{t("workspace.tabInbox")}</button>
      <button type="button" aria-pressed={workspaceTab === "reviews"} onClick={() => setWorkspaceTab("reviews")}>{t("workspace.tabReviews")}</button>
    </div>
    {workspaceTab === "work"
      ? <WorkspaceScreen key={"workspace-" + runId} read={read} selectedTaskId={taskId} />
      : workspaceTab === "inbox"
        ? <InboxScreen teamId={selectedTeamId} onOpenRun={id => go("overview", { run: id, task: undefined })} />
        : <ReviewsScreen read={read} selectedTaskId={taskId} integration={integration.isError ? undefined : integration.data}
            onSelect={task => go("workspace", { task })} onAskLead={(task, opener) => {
              chatOpener.current = opener;
              setDraftContext({ runId, body: t("reviews.chatContext", { task: taskName(task, t) }) });
              setChatOpen(true);
            }} />}
  </div>;
  else content = <div className="ui-screen">
    <div className="ui-subtabs" role="group" aria-label={t("nav.overview")}>
      <button type="button" aria-pressed={overviewTab === "summary"} onClick={() => setOverviewTab("summary")}>{t("overview.tabSummary")}</button>
      <button type="button" aria-pressed={overviewTab === "flow"} onClick={() => setOverviewTab("flow")}>{t("overview.tabFlow")}</button>
      <button type="button" aria-pressed={overviewTab === "analytics"} onClick={() => setOverviewTab("analytics")}>{t("overview.tabAnalytics")}</button>
    </div>
    {overviewTab === "summary"
      ? <Overview read={read} chat={chat.data} integration={integration.data} health={data.health.isError ? undefined : data.health.data}
          onOpenWorkspace={task => { setWorkspaceTab("work"); go("workspace", { task }); }}
          onOpenReviews={task => { setWorkspaceTab("reviews"); go("workspace", { task }); }}
          onOpenTasks={() => go("tasks")} onOpenTask={task => go("tasks", { task })}
          onOpenChat={opener => { chatOpener.current = opener; setChatOpen(true); }} />
      : overviewTab === "flow"
        ? <FlowView events={adaptTeamEvents(data.events.data?.events ?? [], runId)} seats={read?.seats.map(mapTeamSeat)} />
        : <AnalyticsScreen teamId={selectedTeamId} seats={read?.seats} />}
  </div>;

  return <ShellFrame
    language={language}
    section={section}
    appearance={appearance}
    project={teamName}
    runName={runName ? runName + " · " + t(read?.run.phase === "planning" ? "planning.mode" : "execution.mode") : team ? t("records.projectHistory") : ""}
    coordinator={coordinator}
    connection={connection}
    branch={readableBranch(integration.data?.branch ?? "")}
    notifications={pendingDecisions.length + pendingQuestions.length}
    canChat={paired && (!!runId || !!team?.seats.some(seat => seat.role === "lead"))}
    contextOpen={contextOpen}
    onToggleContext={() => setContextOpen(open => !open)}
    onOpenSettings={() => setSettingsOpen(true)}
    contextPanel={contextPanel}
    projectPicker={<select className="ui-project-picker" aria-label={t("shell.project")} value={team?.id ?? ""} onChange={event => openProject(event.target.value)}>
      <option value="">{t("shell.allProjects")}</option>{teams.data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}
    runPicker={team ? <select className="ui-runselect" aria-label={t("shell.run")} value={runId}
      onChange={event => go(section, { run: event.target.value || undefined, task: undefined })}>
      <option value="">{t("records.projectHistory")}</option>
      {(["planning", "delivery"] as const).map(phase => <optgroup key={phase} label={t(phase === "planning" ? "records.planning" : "records.execution")}>
        {currentRuns.filter(run => (run.phase ?? "delivery") === phase).map(run => <option key={run.id} value={run.id}>{run.displayName}</option>)}
      </optgroup>)}</select> : undefined}
    onLanguage={onLanguage}
    hrefFor={next => `/team/${next}?${new URLSearchParams({
      ...(runId ? { run: runId } : {}),
      ...(selectedTeamId ? { team: selectedTeamId } : {}),
      ...(["tasks", "workspace"].includes(next) && taskId ? { task: taskId } : {}),
    })}`}
    onSelect={go}
    onOpenChat={openChat}
    onSearch={opener => { paletteOpener.current = opener; setPaletteOpen(true); }}
    onCreateProject={openCreate}
    action={canStartWork ? <button className="btn btn-quiet ui-new-work" onClick={() => { if (selectedTeamId) setNewWorkFor(selectedTeamId); }}>{t("team.teams.newWork")}</button> : undefined}
  >
    {read?.run.phase === "planning" && section !== "chat" && <p className="ui-phase-banner" role="status">{t("planning.executionGate")}</p>}
    {content}
    {paired && (runId || team) && <ChatPanel key={`chat:${runId || team?.id}`} read={read} runId={runId} chat={chat.data} connectionError={chat.isError} project={team}
      onStarted={nextRun => { void runs.refetch(); go("chat", { run: nextRun }); }}
      onChanged={() => { void chat.refetch(); void data.read.refetch(); }} onOpenDocuments={() => { setChatOpen(false); go("documents"); }} open={chatOpen} onOpenChange={setChatOpen} opener={chatOpener} draftContext={draftContext?.runId === runId ? draftContext : undefined} />}
    <CommandPalette open={paired && paletteOpen} onOpenChange={setPaletteOpen} tasks={paired ? read?.tasks ?? [] : []}
      onChoose={task => go("tasks", { task })} opener={paletteOpener} />
    <CreateProject open={creating} onOpenChange={setCreating} opener={createOpener}
      onCreated={created => go("chat", { team: created.id, run: undefined, task: undefined })} />
    <CreateProject open={opening} mode="open" onOpenChange={setOpening} opener={openOpener}
      onCreated={created => go("chat", { team: created.id, run: undefined, task: undefined })} />
    {newWorkFor && <NewWorkSheet teams={teams.data} teamId={newWorkFor} open
      onOpenChange={open => { if (!open) setNewWorkFor(null); }} onStarted={nextRun => { setNewWorkFor(null); go("chat", { run: nextRun }); }} />}
    <Dialog.Root open={settingsOpen} onOpenChange={setSettingsOpen}>
      <Dialog.Overlay className="ui-dialog-overlay" />
      <Dialog.Content className="ui-settings-modal" aria-describedby={undefined}>
        <header className="ui-panel-heading">
          <Dialog.Title>{t("settings.title")}</Dialog.Title>
          <Dialog.Close className="ui-icon-button" aria-label={t("shell.closeSettings")}><X aria-hidden="true" /></Dialog.Close>
        </header>
        <div className="ui-settings-modal-body">
          <SettingsScreen
            language={language}
            connection={connection}
            onLanguage={onLanguage}
            appearance={appearance}
            seats={read?.seats ?? team?.seats ?? []}
            isolation={data.health.data?.runtime?.isolation ?? null}
            address={window.location.origin}
            teamId={team?.seats.some(seat => seat.role === "lead") ? team.id : undefined}
          />
        </div>
      </Dialog.Content>
    </Dialog.Root>
  </ShellFrame>;
}

export function TeamShell() {
  const [language, setLanguage] = useState<InterfaceI18n | null>(null);
  useEffect(() => {
    let active = true;
    void createInterfaceI18n({ preference: {
      read() { try { return localStorage.getItem(INTERFACE_LANGUAGE_KEY); } catch { return undefined; } },
      write(value) { try { localStorage.setItem(INTERFACE_LANGUAGE_KEY, value); } catch { /* The current language still changes. */ } },
    } }).then(value => { if (active) setLanguage(value); });
    return () => { active = false; };
  }, []);
  const change = (next: "zh-CN" | "en") => { if (!language) return; void language.changeLanguage(next).then(() => setLanguage(language)); };
  return language && <I18nextProvider i18n={language.instance}>
    <OwnerSessionProvider><ManagedShell language={language} onLanguage={change} /></OwnerSessionProvider>
  </I18nextProvider>;
}
