import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { createInterfaceI18n, type InterfaceI18n } from "@loom/i18n";
import { I18nextProvider } from "react-i18next";
import { OwnerSessionProvider, useOwnerSession } from "../hooks/useOwnerSession.js";
import { SetupScreen, useSetup } from "./setup.js";
import { SettingsSheet } from "./settings-sheet.js";
import { TEAM_THEME_PREFERENCES, useThemePreference } from "./theme.js";
import { TeamWorkspaceScreen } from "./team-workspace.js";

export const INTERFACE_LANGUAGE_KEY = "loom.interfaceLanguage";
export type LanguagePreference = "zh-CN" | "en";

/** Setup's completion is stored in settings; this browser remembers it so its next load skips it. */
const SETUP_CHOICE_KEY = "loom.setupComplete";

function setupRead(): boolean {
  try { return localStorage.getItem(SETUP_CHOICE_KEY) === "done"; } catch { return false; }
}

/** The one-time mark that skips setup on a later launch; a storage failure only costs a re-read. */
function rememberSetup(): void {
  try { localStorage.setItem(SETUP_CHOICE_KEY, "done"); } catch { /* This load still continues. */ }
}

/**
 * The composition above the shell: the owner gate first, then the workspace, with first-run setup
 * shown only when the machine needs it.
 *
 * Settings needs no GitHub account: its account section starts the sign-in, and the proxy and
 * tools it shows come from the setup read. It rides inside the frame because the shell's dialog
 * styles live there. Only a paired browser has a setup read to show, so the way in waits for it.
 */
export function Entry({ language, onLanguage, appearance, paired }: {
  language: InterfaceI18n; onLanguage: (next: LanguagePreference) => void;
  appearance: ReturnType<typeof useThemePreference>; paired: boolean;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const frame = (content: ReactNode) => <EntryFrame language={language} onLanguage={onLanguage} appearance={appearance}
    {...(paired ? { onSettings: () => setSettingsOpen(true) } : {})}>
    {content}
    {paired && <SettingsSheet open={settingsOpen} onOpenChange={setSettingsOpen} language={language}
      onLanguage={onLanguage} appearance={appearance}
      props={{ address: window.location.origin, seats: [], onSetup: () => setSettingsOpen(false) }} />}
  </EntryFrame>;
  if (!paired) return frame(<Pairing />);
  return <FirstRun frame={frame} language={language} onLanguage={onLanguage} appearance={appearance} />;
}

/**
 * The workspace, and the setup screen in front of it only when a tool is missing.
 *
 * An install that already finished setup has the browser mark, so it never waits for a read. While
 * the first read is in flight neither screen shows, so a working install flashes neither setup nor
 * a workspace that then turns out to need it. All-OK tools record the mark, so the next launch is
 * decided from the browser alone. A read that fails shows the setup screen rather than guessing the
 * machine is ready, and keeps showing it while it re-reads, because a refetch reports itself as
 * pending again and would otherwise swap the screen back to the loading state on every attempt.
 */
function FirstRun({ frame, language, onLanguage, appearance }: {
  frame: (content: ReactNode) => ReactNode; language: InterfaceI18n;
  onLanguage: (next: LanguagePreference) => void; appearance: ReturnType<typeof useThemePreference>;
}) {
  const { t } = useTranslation();
  const [ready, setReady] = useState(setupRead);
  const [failed, setFailed] = useState(false);
  const setup = useSetup(!ready);
  useEffect(() => { if (setup.isError) setFailed(true); }, [setup.isError]);
  useEffect(() => {
    if (ready || !setup.data) return;
    setReady(setup.data.tools.every(tool => tool.ok));
  }, [ready, setup.data]);
  useEffect(() => { if (ready) rememberSetup(); }, [ready]);
  if (!ready && !failed && !setup.data) return frame(<p role="status">{t("web.loading")}</p>);
  if (!ready) return frame(<SetupScreen onContinue={() => setReady(true)} />);
  // The workspace carries its own shell, header and Settings, so it mounts bare rather than inside
  // the entry frame that the pairing and setup screens use.
  return <TeamWorkspaceScreen language={language} onLanguage={onLanguage} appearance={appearance} />;
}

/** The page frame for a paired browser: app name, language and appearance, today's Settings. */
export function EntryFrame({ language, onLanguage, appearance, children, onSettings }: {
  language: InterfaceI18n; onLanguage: (next: LanguagePreference) => void;
  appearance: ReturnType<typeof useThemePreference>; children: ReactNode;
  /** Settings that need no GitHub account, reachable before any project exists. */
  onSettings?: () => void;
}) {
  const { t } = useTranslation();
  return <div className="team-shell ui-entry" data-ui-theme={appearance.theme} lang={language.language}>
    <header className="ui-entry-header"><strong>{t("shell.appName")}</strong>
      <div className="ui-entry-preferences">
        <label>{t("team.settings.language")}<select value={language.language} onChange={event => onLanguage(event.target.value as LanguagePreference)}>
          <option value="en">English</option><option value="zh-CN">中文</option>
        </select></label>
        <label>{t("shell.appearance")}<select value={appearance.preference} onChange={event => appearance.setPreference(event.target.value as "dark" | "light" | "system")}>
          {TEAM_THEME_PREFERENCES.map(theme => <option key={theme} value={theme}>{t(`settings.theme.${theme}`)}</option>)}
        </select></label>
        {onSettings && <button type="button" className="btn btn-quiet" onClick={onSettings}>{t("settings.title")}</button>}
      </div>
    </header>
    <main className="ui-entry-main">{children}</main>
  </div>;
}

/** The owner-gate screen for a browser that has not paired with this daemon. */
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
        <form className="stack-form" onSubmit={async event => {
          event.preventDefault(); setBusy(true); setFailed(false);
          try { await pair(code); setCode(""); } catch { setFailed(true); } finally { setBusy(false); }
        }}>
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
      {failed && <p role="alert" className="ui-alert-inline">{t(paired || canReconnect ? "web.sessionError" : "web.pairError")}</p>}
    </section>
  </div>;
}

/** The page root: interface language first, then the owner gate, first-run setup and the shell. */
export function TeamShell() {
  const [language, setLanguage] = useState<InterfaceI18n | null>(null);
  useEffect(() => {
    let active = true;
    void createInterfaceI18n({ preference: {
      read() { try { return localStorage.getItem(INTERFACE_LANGUAGE_KEY) ?? undefined; } catch { return undefined; } },
      write(value: string) { try { localStorage.setItem(INTERFACE_LANGUAGE_KEY, value); } catch { /* The current language still changes. */ } },
    } }).then(value => { if (active) setLanguage(value); });
    return () => { active = false; };
  }, []);
  const change = (next: LanguagePreference) => { if (!language) return; void language.changeLanguage(next).then(() => setLanguage(language)); };
  return language && <I18nextProvider i18n={language.instance}>
    <OwnerSessionProvider><ManagedShell language={language} onLanguage={change} /></OwnerSessionProvider>
  </I18nextProvider>;
}

function ManagedShell({ language, onLanguage }: { language: InterfaceI18n; onLanguage: (next: LanguagePreference) => void }) {
  const { paired } = useOwnerSession();
  const appearance = useThemePreference();
  return <Entry language={language} onLanguage={onLanguage} appearance={appearance} paired={paired} />;
}