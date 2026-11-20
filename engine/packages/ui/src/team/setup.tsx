import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Check, CircleDashed, Info, RotateCw, X } from "lucide-react";
import { useOwnerSession } from "../hooks/useOwnerSession.js";

export interface ToolRow { client: "git" | "gh" | "claude" | "codex" | "gemini"; ok: boolean; path?: string; reason?: string }
export interface SignInRow { client: "claude" | "codex" | "gemini"; state: "signed-in" | "signed-out" | "unknown"; signIn: string | null }
export interface SetupState { tools: ToolRow[]; signIn: SignInRow[]; proxy: string; complete: boolean }

export const setupKey = ["team", "setup"] as const;

/** The one install line per tool, keyed by the resolver's client name. */
const INSTALL_KEYS = { git: "setup.install.git", gh: "setup.install.gh", claude: "setup.install.claude", codex: "setup.install.codex",
  gemini: "setup.install.gemini" } as const;
const TOOL_LABELS = { git: "Git", gh: "GitHub CLI", claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI" } as const;
const SIGN_IN_KEYS = { "signed-in": "setup.signedIn", "signed-out": "setup.signedOut", unknown: "setup.unknown" } as const;
/** The order the tools read in: the two every project needs, then the clients. */
const TOOL_ORDER = ["git", "gh", "claude", "codex", "gemini"] as const;

/**
 * A sign-in row's mark. Only a client that answered "signed out" is a failure; one that did not
 * answer is a gap in the evidence, so it gets a neutral mark rather than the same red cross.
 */
function SignInMark({ state }: { state: SignInRow["state"] }) {
  if (state === "signed-in") return <Check className="setup-mark" aria-hidden="true" />;
  if (state === "signed-out") return <X className="setup-mark" aria-hidden="true" />;
  return <CircleDashed className="setup-mark" aria-hidden="true" />;
}

/** The setup read: tools, agent sign-in and the proxy, as the daemon just observed them. */
export function useSetup(enabled = true) {
  const { paired, request } = useOwnerSession();
  return useQuery({ queryKey: setupKey, enabled: paired && enabled, retry: false,
    queryFn: ({ signal }) => request<SetupState>("/setup", { signal }) });
}

/**
 * The proxy field, shared by the setup screen and Settings.
 *
 * One value covers GitHub operations and every agent CLI. The daemon validates it and applies it
 * to the next call, so saving is the whole action, and an emptied field removes the proxy.
 */
export function NetworkProxy() {
  const { t } = useTranslation();
  const { request } = useOwnerSession();
  const cache = useQueryClient();
  const setup = useSetup();
  const [draft, setDraft] = useState<string>();
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  const saved = setup.data?.proxy ?? "";
  const save = async () => {
    setBusy(true); setFailed(false);
    try {
      cache.setQueryData(setupKey, await request<SetupState>("/setup", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ proxy: draft }) }));
      setDraft(undefined);
    } catch { setFailed(true); } finally { setBusy(false); }
  };
  return <section className="setup-block" aria-label={t("setup.network")}>
    <h2 className="setup-block-title">{t("setup.network")}</h2>
    <form className="setup-proxy" onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="field">
        <label htmlFor="network-proxy">{t("setup.proxy")}</label>
        <input id="network-proxy" className="input mono" type="text" autoComplete="off" spellCheck={false}
          placeholder="http://host:port" value={draft ?? saved} disabled={!setup.data}
          onChange={event => setDraft(event.target.value)} />
      </div>
      {draft !== undefined && draft !== saved && <div className="plate-foot"><button className="btn btn-outline"
        type="submit" disabled={busy || !setup.data}>{t("settings.save")}</button></div>}
    </form>
    {failed && <p role="alert">{t("setup.proxyRejected")}</p>}
  </section>;
}

function Tools() {
  const { t } = useTranslation();
  const setup = useSetup();
  if (!setup.data) return setup.isError ? <p role="alert">{t("setup.readFailed")}</p> : <p role="status">{t("web.loading")}</p>;
  return <section className="setup-block" aria-label={t("setup.tools")}>
    <div className="setup-block-head">
      <h2 className="setup-block-title">{t("setup.tools")}</h2>
      <button type="button" className="ui-icon-button" aria-label={t("setup.recheck")} title={t("setup.recheck")}
        disabled={setup.isFetching} onClick={() => void setup.refetch()}><RotateCw aria-hidden="true" /></button>
    </div>
    <ul className="setup-rows">{[...setup.data.tools].sort((a, b) => TOOL_ORDER.indexOf(a.client) - TOOL_ORDER.indexOf(b.client)).map(row => <li key={row.client} data-ok={row.ok}>
      {row.ok ? <Check className="setup-mark" aria-hidden="true" /> : <X className="setup-mark" aria-hidden="true" />}
      <strong>{TOOL_LABELS[row.client]}</strong>
      {row.path
        ? <span className="setup-path" title={row.path} aria-label={t("setup.path")}><Info aria-hidden="true" /></span>
        : <span className="mono setup-command">{t(INSTALL_KEYS[row.client])}</span>}
    </li>)}</ul>
  </section>;
}

function SignIn() {
  const { t } = useTranslation();
  const setup = useSetup();
  // A client that is not installed reports no sign-in state at all.
  if (!setup.data?.signIn.length) return null;
  return <section className="setup-block" aria-label={t("setup.agents")}>
    <h2 className="setup-block-title">{t("setup.agents")}</h2>
    <ul className="setup-rows">{setup.data.signIn.map(row => <li key={row.client} data-ok={row.state === "signed-in"}
      data-state={row.state}>
      <SignInMark state={row.state} />
      <strong>{TOOL_LABELS[row.client]}</strong>
      <span className="setup-state">{t(SIGN_IN_KEYS[row.state])}</span>
      {row.signIn && <span className="mono setup-command">{row.signIn}</span>}
    </li>)}</ul>
  </section>;
}

/** First-run setup: the tools a team needs, and the proxy that reaches them. */
export function SetupScreen({ onContinue }: { onContinue: () => void }) {
  const { t } = useTranslation();
  const setup = useSetup();
  return <div className="page page-narrow ui-setup">
    <section className="plate" aria-label={t("setup.title")}>
      <h1 className="display">{t("setup.title")}</h1>
      <NetworkProxy />
      <Tools />
      <SignIn />
      <div className="plate-foot"><button className="btn btn-primary" disabled={!setup.data}
        onClick={onContinue}>{t("setup.continue")}</button></div>
    </section>
  </div>;
}
