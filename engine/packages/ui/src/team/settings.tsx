import { ModelSettings } from "./model-settings.js";
import { SoulSettings } from "./soul-settings.js";
import { PromptSectionSettings } from "./prompt-sections.js";
import { IntakeSettings } from "./intake-settings.js";
import { AgentAccount } from "./agent-account.js";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { TabGroup } from "./tab-group.js";
import { Monitor, Moon, Sun } from "lucide-react";
import type { InterfaceI18n } from "@loom/i18n";
import { useOwnerSession } from "../hooks/useOwnerSession.js";
import { TEAM_THEME_PREFERENCES, type useThemePreference } from "./theme.js";
import { GithubSignIn, githubStatusKey, useGithubStatus, type GithubStatus } from "./github-sign-in.js";
import { clientLabel } from "./display.js";
import type { TeamSeatSummary } from "./hooks.js";

/** The section navigation. `setup` leaves this screen for the setup screen rather than a pane. */
export const SETTINGS_SECTIONS = ["general", "setup", "github", "appearance", "sessions", "agents"] as const;
const AGENTS_TABS = ["models", "prompts", "seats"] as const;
const THEME_ICONS = { dark: Moon, light: Sun, system: Monitor };
const settingsKey = ["team", "settings"] as const;
interface SettingsReply { settings: { "team.leadClient": { value: "claude-code" | "codex" | "gemini"; source: string } } }

function General({ language, onLanguage }: { language: InterfaceI18n; onLanguage: (next: "en" | "zh-CN") => void }) {
  const { t } = useTranslation();
  const { paired, request } = useOwnerSession();
  const cache = useQueryClient();
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  const settings = useQuery({ queryKey: settingsKey, enabled: paired, retry: false,
    queryFn: ({ signal }) => request<SettingsReply>("/settings", { signal }) });
  const lead = settings.data?.settings["team.leadClient"];
  const save = async (value: string) => {
    setBusy(true); setFailed(false);
    try {
      cache.setQueryData(settingsKey, await request<SettingsReply>("/settings", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "team.leadClient", value }),
      }));
    } catch { setFailed(true); } finally { setBusy(false); }
  };
  return <section className="plate ui-settings-panel" aria-label={t("settings.section.general")}>
    <h2>{t("settings.section.general")}</h2>
    <label className="field">{t("team.settings.language")}<select className="input" value={language.language}
      onChange={event => onLanguage(event.target.value as "en" | "zh-CN")}>
      <option value="en">English</option><option value="zh-CN">中文</option>
    </select></label>
    <label className="field">{t("settings.leadClient")}<select className="input" value={lead?.value ?? "claude-code"}
      disabled={busy || !lead || settings.isError || lead.source === "env"} onChange={event => void save(event.target.value)}>
      <option value="claude-code">Claude Code</option><option value="codex">Codex</option><option value="gemini">Gemini CLI</option>
    </select></label>
    {lead?.source === "env" && <p className="muted">{t("settings.managedByEnvironment")}</p>}
    {(settings.isError || failed) && <p role="alert">{t("settings.saveFailed")}</p>}
    {settings.isError && <button className="btn btn-outline" onClick={() => void settings.refetch()}>{t("github.retry")}</button>}
  </section>;
}

function GithubAccount() {
  const { t } = useTranslation();
  const { request } = useOwnerSession();
  const status = useGithubStatus(), cache = useQueryClient();
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  return <section className="plate ui-settings-panel" aria-label={t("settings.section.github")}>
    <h2>{t("settings.section.github")}</h2>
    {/* A failed read is the sign-in control's to state, with its retry. */}
    {!status.isError && <p className="ui-account"><strong>{status.data?.login ?? "—"}</strong><span className="muted">{status.data?.host}</span></p>}
    <GithubSignIn />
    <button className="btn btn-outline" disabled={busy || !status.data?.signedIn} onClick={async () => {
      setBusy(true); setFailed(false);
      try {
        const signedOut = await request<GithubStatus>("/github/logout", { method: "POST" });
        await cache.cancelQueries({ queryKey: githubStatusKey });
        cache.setQueryData(githubStatusKey, signedOut);
      }
      catch { setFailed(true); } finally { setBusy(false); }
    }}>{t("settings.signOut")}</button>
    {failed && <p role="alert">{t("settings.saveFailed")}</p>}
  </section>;
}

function Sessions({ address }: { address: string }) {
  const { t } = useTranslation();
  const { paired, revoke } = useOwnerSession();
  const cache = useQueryClient();
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  return <section className="plate ui-settings-panel" aria-label={t("settings.sessions")}>
    <h2>{t("settings.thisBrowser")}</h2>
    <dl className="ui-facts">
      <div><dt>{t("settings.runtime.address")}</dt><dd><code>{address}</code></dd></div>
    </dl>
    <p className="muted">{t("settings.revokeConsequence")}</p>
    <button className="btn btn-outline" disabled={busy || !paired} onClick={async () => {
      setBusy(true); setFailed(false);
      try { await revoke(); cache.removeQueries({ queryKey: ["team"] }); }
      catch { setFailed(true); } finally { setBusy(false); }
    }}>{t("team.settings.revoke")}</button>
    {failed && <p role="alert">{t("settings.sessions.failed")}</p>}
  </section>;
}

/** Restored section navigation, limited to current owner preferences and read-only seats. */
export function SettingsScreen({ language, onLanguage, appearance, address, seats, teamId, onSetup }: {
  language: InterfaceI18n; onLanguage: (next: "en" | "zh-CN") => void;
  appearance: ReturnType<typeof useThemePreference>;
  address: string; teamId?: string;
  /** Opens first-run setup; the screen closes so the owner can leave it by continuing. */
  onSetup: () => void;
  seats: readonly (TeamSeatSummary & { index?: number | null; retired?: boolean })[];
}) {
  const { t } = useTranslation();
  const [section, setSection] = useState<typeof SETTINGS_SECTIONS[number]>(teamId ? "agents" : "general");
  const [agentsTab, setAgentsTab] = useState<"models" | "prompts" | "seats">("models");
  return <div className="page ui-settings">
    <div className="page-head"><h1 className="display">{t("settings.title")}</h1></div>
    <div className="ui-settings-body">
      <nav className="ui-sections" aria-label={t("settings.sections")}>{SETTINGS_SECTIONS.map(id =>
        <button key={id} type="button" aria-pressed={section === id}
          onClick={() => { if (id === "setup") { onSetup(); return; } setSection(id); }}>{t(`settings.section.${id}`)}</button>)}</nav>
      <div className="ui-settings-pane">
        {section === "general" && <General language={language} onLanguage={onLanguage} />}
        {section === "github" && <><GithubAccount /><AgentAccount /></>}
        {section === "appearance" && <section className="plate ui-settings-panel" aria-label={t("settings.appearance")}>
          <h2>{t("settings.theme")}</h2>
          <div className="ui-themes" role="radiogroup" aria-label={t("settings.theme")}>{TEAM_THEME_PREFERENCES.map(theme => {
            const Icon = THEME_ICONS[theme];
            return <label key={theme} className="ui-theme-option" data-checked={appearance.preference === theme}>
              <Icon aria-hidden="true" /><span>{t(`settings.theme.${theme}`)}</span>
              <input type="radio" name="team-theme" checked={appearance.preference === theme} onChange={() => appearance.setPreference(theme)} />
            </label>;
          })}</div>
        </section>}
        {section === "sessions" && <Sessions address={address} />}
        {section === "agents" && <>
          {teamId && <TabGroup label={t("settings.section.agents")} value={agentsTab} onChange={setAgentsTab}
            items={AGENTS_TABS.map(id => ({ id, label: t(`settings.agentsTab.${id}`) }))} />}
          {teamId && agentsTab === "models" && <ModelSettings key={teamId} teamId={teamId} />}
          {teamId && agentsTab === "prompts" && <>
            <SoulSettings key={teamId + "-souls"} teamId={teamId} />
            <PromptSectionSettings key={teamId + "-sections"} teamId={teamId} />
          </>}
          {(!teamId || agentsTab === "seats") && <>
            {teamId && <IntakeSettings key={teamId + "-intake"} teamId={teamId} />}
            <section className="plate ui-settings-panel" aria-label={t("settings.section.agents")}>
              <h2>{t("settings.section.agents")}</h2>
              <p className="muted">{t(teamId ? "models.seats" : "settings.agentsReadOnly")}</p>
              {seats.length === 0 ? <p className="muted">{t("settings.noSeats")}</p>
                : <ul className="ui-seat-settings">{seats.map((seat, index) => <li key={index}>
                  <strong>{t(`role.${seat.role}`)} · {clientLabel(seat.client, t)}{seat.index == null ? "" : " " + seat.index}</strong>
                  {seat.model && <span className="mono muted">{seat.model}</span>}
                  {seat.retired && <span className="muted">{t("workspace.retired")}</span>}
                </li>)}</ul>}
            </section>
          </>}
        </>}
      </div>
    </div>
  </div>;
}
