import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import { OwnerReadError, useOwnerSession } from "../hooks/useOwnerSession.js";

export interface GithubStatus { signedIn: boolean; login: string | null; host: string }
interface LoginState { state: "idle" | "pending" | "done" | "failed"; code?: string; url?: string }
export const githubStatusKey = ["team", "github", "status"] as const;
const loginKey = ["team", "github", "login"] as const;

export function useGithubStatus() {
  const { paired, request } = useOwnerSession();
  return useQuery({ queryKey: githubStatusKey, enabled: paired, retry: false, refetchInterval: 10_000,
    queryFn: ({ signal }) => request<GithubStatus>("/github/status", { signal }) });
}

/**
 * The owner's GitHub sign-in by device flow, where the account is needed: Settings starts it from
 * its GitHub section, and Create project offers it inline once the daemon refuses a project for
 * lack of an account.
 *
 * It renders nothing while the account is signed in or its state is still unknown, so a surface
 * that embeds it does not have to decide when the account matters. `refused` is the daemon's own
 * answer that it is signed out; it shows the control even before the status read agrees.
 */
export function GithubSignIn({ refused = false }: { refused?: boolean }) {
  const { t } = useTranslation();
  const { request } = useOwnerSession();
  const cache = useQueryClient();
  const status = useGithubStatus();
  const signedOut = status.data?.signedIn === false || refused;
  const flow = useQuery({ queryKey: loginKey, retry: false, enabled: signedOut,
    queryFn: ({ signal }) => request<LoginState>("/github/login", { signal }),
    refetchInterval: query => query.state.data?.state === "pending" ? 1_500 : false });
  useEffect(() => {
    if (flow.data?.state === "done") void cache.invalidateQueries({ queryKey: githubStatusKey });
  }, [flow.data?.state, cache]);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  if (!signedOut && !status.isError) return null;
  const pending = flow.data?.state === "pending";
  const failed = startError !== null || flow.isError || flow.data?.state === "failed";
  const missing = startError === "github_cli_missing"
    || (status.error instanceof OwnerReadError && status.error.code === "github_cli_missing");
  const start = async () => {
    setStarting(true); setStartError(null);
    try { cache.setQueryData(loginKey, await request<LoginState>("/github/login", { method: "POST" })); }
    catch (error) { setStartError(error instanceof OwnerReadError ? error.code : "github_login_failed"); }
    finally { setStarting(false); }
  };
  return <div className="ui-github-signin">
    {status.isError ? <>
      <p role="alert">{t(missing ? "github.missing" : "github.statusFailed")}</p>
      <button type="button" className="btn btn-outline" onClick={() => void status.refetch()}>{t("github.retry")}</button>
    </> : <>
      {pending && <div className="ui-device-flow" role="status">
        <span>{t("github.deviceCode")}</span><code>{flow.data?.code}</code>
        {flow.data?.url === "https://github.com/login/device" && <a className="btn btn-primary" href={flow.data.url} target="_blank" rel="noopener noreferrer">
          {t("github.openDevice")}<ExternalLink aria-hidden="true" /></a>}
      </div>}
      {failed && <p role="alert">{t(missing ? "github.missing" : "github.failed")}</p>}
      {!pending && <button type="button" className="btn btn-primary" disabled={starting} onClick={() => void start()}>
        {t(starting ? "web.loading" : failed ? "github.retry" : "github.title")}</button>}
    </>}
  </div>;
}