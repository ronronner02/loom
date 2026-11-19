import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { createInterfaceI18n, type InterfaceI18n } from "@loom/i18n";
import { I18nextProvider } from "react-i18next";
import { OwnerSessionProvider, useOwnerSession } from "../hooks/useOwnerSession.js";
import { EntryFrame, GithubGate } from "./github-gate.js";
import { SetupScreen, type SetupState } from "./setup.js";
import { SettingsSheet } from "./settings-sheet.js";
import { useThemePreference } from "./theme.js";
import { TeamWorkspaceScreen } from "./team-workspace.js";

export const INTERFACE_LANGUAGE_KEY = "loom.interfaceLanguage";
export type LanguagePreference = "zh-CN" | "en";

/** Setup's completion is stored in settings; this browser remembers it so its next load skips it. */
const SETUP_CHOICE_KEY = "loom.setupComplete";

function setupRead(): boolean {
  try { return localStorage.getItem(SETUP_CHOICE_KEY) === "done"; } catch { return false; }
}

/**
 * The composition above the shell: the owner gate first, then first-run setup, the GitHub account
 * check third, the workspace only inside all of them.
 *
 * The setup screen precedes the GitHub check because a network that blocks GitHub blocks sign-in
 * itself, and the proxy that fixes it lives on that screen. Completion is recorded in settings and
 * remembered here, so a later launch skips it; Settings and the gate's own link reopen it.
 */
export function Entry({ language, onLanguage, appearance, paired }: {
  language: InterfaceI18n; onLanguage: (next: LanguagePreference) => void;
  appearance: ReturnType<typeof useThemePreference>; paired: boolean;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(() => !setupRead());
  const finishSetup = () => {
    try { localStorage.setItem(SETUP_CHOICE_KEY, "done"); } catch { /* This load still continues. */ }
    setSetupOpen(false);
  };
  // Settings needs no GitHub account: its account section states signed-out, and the proxy and
  // tools it shows come from the setup read. It rides inside the frame because the shell's dialog
  // styles live there. Only a paired browser has a setup read to show, so the way in waits for it.
  const frame = (content: ReactNode) => <EntryFrame language={language} onLanguage={onLanguage} appearance={appearance}
    {...(paired ? { onSettings: () => setSettingsOpen(true) } : {})}>
    {content}
    {paired && <SettingsSheet open={settingsOpen} onOpenChange={setSettingsOpen} language={language}
      onLanguage={onLanguage} appearance={appearance}
      props={{ address: window.location.origin, seats: [], onSetup: () => { setSettingsOpen(false); setSetupOpen(true); } }} />}
  </EntryFrame>;
  if (!paired) return frame(<Pairing />);
  return <FirstRun frame={frame} language={language} onLanguage={onLanguage} appearance={appearance}
    setupOpen={setupOpen} onSetupDone={finishSetup} onSetup={() => setSetupOpen(true)} />;
}

/** The setup screen until it is done, then the gate; either screen opens the other on request. */
function FirstRun({ frame, language, onLanguage, appearance, setupOpen, onSetupDone, onSetup }: {
  frame: (content: ReactNode) => ReactNode; language: InterfaceI18n;
  onLanguage: (next: LanguagePreference) => void; appearance: ReturnType<typeof useThemePreference>;
  setupOpen: boolean; onSetupDone: () => void; onSetup: () => void;
}) {
  const { paired, request } = useOwnerSession();
  useEffect(() => {
    if (!paired || setupRead()) return;
    let active = true;
    // The stored answer survives a cleared browser, so an install that already finished setup is
    // not asked again; a read that fails leaves the screen up rather than skipping it on a guess.
    void request<SetupState>("/setup").then(state => {
      if (!active || !state.complete) return;
      try { localStorage.setItem(SETUP_CHOICE_KEY, "done"); } catch { /* This load still skips it. */ }
      onSetupDone();
    }).catch(() => { /* The screen stays up and reads again on its own. */ });
    return () => { active = false; };
  }, [paired, request, onSetupDone]);
  if (setupOpen) return frame(<SetupScreen onContinue={onSetupDone} />);
  return <GithubGate frame={frame} onSetup={onSetup}>
    <TeamWorkspaceScreen language={language} onLanguage={onLanguage} appearance={appearance} onSetup={onSetup} />
  </GithubGate>;
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

/** The page root: interface language first, then the owner gate, the GitHub gate and the shell. */
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