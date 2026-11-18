import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { TEAM_CONTROL_VERSION, TeamContractError, object, parseProtocolVersion } from "../contracts/team-control.js";
import { probeAgentSignIn, type SignInProbe } from "../domain/agent-sign-in.js";
import { resolveClientDependencies, type Resolution } from "../domain/executable-resolver.js";
import { configuredProxy, proxyEnvironment } from "../domain/network-proxy.js";
import type { SettingsStore } from "../domain/user-settings/settings-store.js";
import { teamControlAuthentication, type TeamControlCredentials, type TeamControlEnv } from "../middleware/auth-bearer-token.js";

/**
 * The first-run setup read, for an owner who has not signed in to GitHub yet.
 *
 * Three facts, each from the process that owns it rather than a second implementation here:
 *  - the tools, from the daemon's own executable resolver, so a path this screen shows is the
 *    path a worker launch will use;
 *  - the agent sign-in state, from each installed client's own status subcommand;
 *  - the one network proxy the owner set, which GitHub operations and the clients share.
 *
 * This lives apart from the team settings route because setup precedes GitHub sign-in, while the
 * team settings route is what the shell's Settings screen reads once signed in.
 */

export const SETUP_COMPLETE_KEY = "ui.setup_complete";

interface ToolRow { client: Resolution["client"]; ok: boolean; path?: string; reason?: string }

function toolRows(resolutions: Resolution[]): ToolRow[] {
  // A client that runs through Node is installed where its JavaScript entry is, which is the path
  // the owner can recognize; the program that runs it is the daemon's own Node.
  return resolutions.map(resolution => resolution.ok
    ? { client: resolution.client, ok: true, path: resolution.args?.[0] ?? resolution.path }
    : { client: resolution.client, ok: false, reason: resolution.reason });
}

/**
 * The two host questions the setup read asks, and the seam a test uses to answer them.
 *
 * Production leaves both out: the resolver probes PATH, and each installed client's own status
 * subcommand answers the sign-in question. A test supplies them so the read's shape is asserted
 * the same way on a host with every client installed and on one with none.
 */
export interface SetupReadDependencies {
  resolveClients?: () => Resolution[];
  probeSignIn?: (client: SignInProbe["client"], executable: string, options: { env: NodeJS.ProcessEnv }) => Promise<SignInProbe>;
}

export function setupRoutes(store: SettingsStore | undefined, credentials: TeamControlCredentials,
  legacyTokens: readonly (string | null | undefined)[], dependencies: SetupReadDependencies = {}): Hono<TeamControlEnv> {
  const app = new Hono<TeamControlEnv>();
  app.use("/setup", teamControlAuthentication(() => credentials, legacyTokens));
  app.use("/setup", async (c, next) => {
    if (c.get("controlActor").kind !== "owner") {
      return c.json({ code: "owner_control_required", error: "An authenticated owner is required." }, 403);
    }
    parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
    c.header("Cache-Control", "no-store");
    if (!store) return c.json({ code: "team_settings_unavailable", error: "Team settings are unavailable." }, 503);
    await next();
  });
  app.use("/setup", bodyLimit({ maxSize: 4096,
    onError: c => c.json({ code: "invalid_team_contract", error: "The setup request exceeds its size limit." }, 413) }));

  app.get("/setup", async c => c.json({ protocolVersion: TEAM_CONTROL_VERSION, ...await read(store!, dependencies) }));

  app.put("/setup", async c => {
    const body = object(await c.req.json(), "setup");
    if (Object.keys(body).some(key => key !== "proxy" && key !== "complete")) throw new TeamContractError("setup");
    if (body.complete !== undefined && typeof body.complete !== "boolean") throw new TeamContractError("complete");
    if (body.proxy !== undefined) {
      // The proxy may be cleared, so an empty string is an answer here where `text` would refuse it.
      const proxy = typeof body.proxy === "string" ? body.proxy : null;
      if (proxy === null || proxy.length > 256) throw new TeamContractError("proxy");
      try { store!.set("network.proxy", proxy); }
      catch (error) {
        if (error instanceof Error && /^Invalid value for network\./.test(error.message)) {
          return c.json({ code: "invalid_network_proxy", error: "Use http://host:port, or leave the proxy empty." }, 400);
        }
        throw error;
      }
    }
    if (body.complete === true) store!.set(SETUP_COMPLETE_KEY, "true");
    return c.json({ protocolVersion: TEAM_CONTROL_VERSION, ...await read(store!, dependencies) });
  });

  app.onError((error, c) => error instanceof TeamContractError || error instanceof SyntaxError
    ? c.json({ code: "invalid_team_contract", error: "The setup request is malformed or incompatible." }, 400)
    : c.json({ code: "team_settings_unavailable", error: "The setup state could not be read or saved." }, 500));
  return app;
}

/**
 * The screen's whole state.
 *
 * Tools and sign-in are read on every request rather than cached, which is what makes a re-check
 * mean what it says: an install or a sign-in the owner just finished shows up on the next read.
 * The sign-in probes run in parallel and each is bounded, so a client that hangs costs its own
 * timeout and not the screen's.
 *
 * A client that is not installed has no sign-in row at all. The tools row above it already says
 * the client is missing and names its install line; a second row repeating that, or offering a
 * sign-in command for a program that is not there, would only be more to read.
 */
async function read(store: SettingsStore, dependencies: SetupReadDependencies) {
  const resolutions = (dependencies.resolveClients ?? resolveClientDependencies)();
  const probe = dependencies.probeSignIn ?? probeAgentSignIn;
  const proxy = configuredProxy(store);
  const env = { ...process.env, ...proxyEnvironment(proxy) };
  const installed = new Map(resolutions.filter((r): r is Extract<Resolution, { ok: true }> => r.ok)
    .map(resolution => [resolution.client, resolution.args?.[0] ?? resolution.path]));
  const clients = (["claude", "codex", "gemini"] as const).filter(client => installed.has(client));
  const signIn = await Promise.all(clients.map(client => probe(client, installed.get(client)!, { env })));
  return { tools: toolRows(resolutions), signIn, proxy, complete: store.resolveOne(SETUP_COMPLETE_KEY).value === true };
}