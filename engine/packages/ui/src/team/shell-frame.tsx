import { useEffect, useRef, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import type { InterfaceI18n, MessageKey } from "@multi-agent/i18n";
import { useTranslation } from "react-i18next";
import { Bell, FolderPlus, GitBranch, Menu, MessageSquare, Search, Settings, X } from "lucide-react";
import { PomoAvatar, resolvePomoAvatarState, type PomoAvatarState } from "./pomo-avatar.js";
import { NAV_ICONS, SECTION_LABELS, TEAM_SECTIONS, type TeamSection } from "./sections.js";
import { TEAM_THEME_PREFERENCES, type useThemePreference } from "./theme.js";

/** Everything the chrome renders, so the frame takes one object instead of a dozen scalars. */
export interface ShellChrome {
  project: string;
  projectPicker?: ReactNode;
  runName: string;
  runPicker?: ReactNode;
  coordinator: MessageKey;
  connection: MessageKey;
  streamError?: string;
  branch: string;
  notifications: number;
  canChat: boolean;
  avatarState?: PomoAvatarState;
  action?: ReactNode;
}

interface ShellFrameProps {
  language: InterfaceI18n;
  section: TeamSection;
  appearance: ReturnType<typeof useThemePreference>;
  chrome: ShellChrome;
  contextOpen?: boolean;
  onToggleContext?: () => void;
  onOpenSettings?: () => void;
  onLanguage: (next: "zh-CN" | "en") => void;
  hrefFor: (section: TeamSection) => string;
  onSelect: (section: TeamSection) => void;
  onOpenChat: (opener: HTMLButtonElement) => void;
  onSearch: (opener: HTMLElement) => void;
  onCreateProject?: (opener: HTMLButtonElement) => void;
  contextPanel?: ReactNode;
  children: ReactNode;
}

/** Muse-style slim left icon rail + centered main column + on-demand right context panel. */
export function ShellFrame({ language, section, appearance, chrome, contextOpen = false, onToggleContext,
  onOpenSettings, onLanguage, hrefFor, onSelect, onOpenChat, onSearch, onCreateProject, contextPanel, children }: ShellFrameProps) {
  const { t } = useTranslation();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const navigationOpenRef = useRef(false);
  const navigationTrigger = useRef<HTMLButtonElement>(null);
  navigationOpenRef.current = navigationOpen;
  const resolvedAvatarState = chrome.avatarState ?? resolvePomoAvatarState(chrome.coordinator, { hasPendingOwner: chrome.notifications > 0 });
  useEffect(() => {
    const jump = (event: KeyboardEvent) => {
      if (chrome.canChat && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault(); setNavigationOpen(false);
        onSearch(navigationOpenRef.current && navigationTrigger.current ? navigationTrigger.current : document.activeElement as HTMLElement);
      } else if ((event.ctrlKey || event.metaKey) && event.key === ",") {
        if (onOpenSettings) {
          event.preventDefault();
          onOpenSettings();
        }
      }
    };
    window.addEventListener("keydown", jump);
    return () => window.removeEventListener("keydown", jump);
  }, [chrome.canChat, onOpenSettings, onSearch]);

  const rail = <>
    <div className="ui-brand" title={t("shell.appName")}>
      <img className="ui-brand-icon" src="/loom-icon.png" alt="" aria-hidden="true" />
    </div>
    <button
      type="button"
      className="ui-rail-search"
      disabled={!chrome.canChat}
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
  const misconnected = ["web.disconnected", "web.error", "web.notFound"].includes(chrome.connection);
  return <Dialog.Root open={navigationOpen} onOpenChange={setNavigationOpen}>
    <div className="team-shell" lang={language.language} data-ui-theme={appearance.theme} data-testid="team-shell">
      <aside className="ui-sidebar ui-rail">{rail}</aside>
      <div className="ui-content">
        <header className="ui-topstrip">
          <Dialog.Trigger ref={navigationTrigger} className="ui-icon-button ui-menu-button" aria-label={t("shell.openNavigation")}>
            <Menu aria-hidden="true" />
          </Dialog.Trigger>
          <div className="ui-breadcrumb">
            {chrome.projectPicker ?? <span>{chrome.project || t("shell.project")}</span>}
            {chrome.runPicker && <><span aria-hidden="true">/</span>{chrome.runPicker}</>}
            {!chrome.runPicker && chrome.runName && <><span aria-hidden="true">/</span><span className="ui-run-name">{chrome.runName}</span></>}
            <span className="ui-current-section sr-only">{navSection}</span>
          </div>
          <div className="ui-top-meta">
            {chrome.action}
            <button
              type="button"
              className="ui-agent-pill"
              aria-expanded={contextOpen}
              aria-label={t("shell.contextPanel")}
              onClick={() => onToggleContext?.()}
            >
              <span className="ui-agent-avatar" aria-hidden="true">
                <PomoAvatar state={resolvedAvatarState} />
              </span>
              <span>{t("shell.coordinator")}</span>
              <span className="ui-dot" data-state={["shell.active", "status.attempt.working", "status.attempt.started"].includes(chrome.coordinator) ? "ok" : "unknown"} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="ui-icon-button"
              disabled={!chrome.canChat}
              aria-label={t("shell.openChat")}
              onClick={event => onOpenChat(event.currentTarget)}
            >
              <MessageSquare aria-hidden="true" />
            </button>
            <button
              type="button"
              className="ui-bell ui-icon-button"
              disabled={!chrome.canChat}
              aria-label={t("shell.notificationsCount", { count: chrome.notifications })}
              onClick={event => onOpenChat(event.currentTarget)}
            >
              <Bell aria-hidden="true" />
              {chrome.notifications > 0 && <span className="ui-badge">{chrome.notifications}</span>}
            </button>
          </div>
        </header>
        <div className="ui-workspace-body">
          <div className="ui-main">
            {misconnected && <p className="ui-snapshot-warning" role="alert">{t("shell.snapshotWarning")}</p>}
            {chrome.streamError && <p className="ui-snapshot-warning" role="alert">{t("shell.streamError", { message: chrome.streamError })}</p>}
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
          <span><GitBranch aria-hidden="true" /><span>{chrome.branch || t("shell.noBranch")}</span></span>
          <span title={t(chrome.connection)}>
            <span className="ui-dot" data-state={chrome.connection === "shell.connected" ? "ok" : "unknown"} aria-hidden="true" />
            <span className="sr-only">{t(chrome.connection)}</span>
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