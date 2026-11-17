import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { createInterfaceI18n, type InterfaceI18n } from "@multi-agent/i18n";
import { I18nextProvider } from "react-i18next";
import { OwnerSessionProvider, useOwnerSession } from "../hooks/useOwnerSession.js";
import { EntryFrame, GithubGate } from "./github-gate.js";
import { useThemePreference } from "./theme.js";
import { TeamWorkspaceScreen } from "./team-workspace.js";

export const INTERFACE_LANGUAGE_KEY = "multi-agent.interfaceLanguage";
export type LanguagePreference = "zh-CN" | "en";

/**
 * The composition above the shell: the owner gate first, the GitHub account check second, the
 * workspace only inside both. A screen that must come before the GitHub check (first-run
 * setup) mounts inside `Entry` here, which takes a node rather than assuming the pairing plate.
 */
export function Entry({ language, onLanguage, appearance, paired }: {
  language: InterfaceI18n; onLanguage: (next: LanguagePreference) => void;
  appearance: ReturnType<typeof useThemePreference>; paired: boolean;
}) {
  const frame = (content: ReactNode) => <EntryFrame language={language} onLanguage={onLanguage} appearance={appearance}>{content}</EntryFrame>;
  if (!paired) return frame(<Pairing />);
  return <GithubGate frame={frame}>
    <TeamWorkspaceScreen language={language} onLanguage={onLanguage} appearance={appearance} />
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