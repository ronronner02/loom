import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { TEAM_CONTROL_VERSION, parseProtocolVersion } from "../contracts/team-control.js";
import { teamControlAuthentication, type TeamControlCredentials, type TeamControlEnv } from "../middleware/auth-bearer-token.js";
import { controlErrorHandler } from "../middleware/control-error.js";

/**
 * The owner's stop request.
 *
 * On Windows a process ends outright on SIGTERM, so a signal cannot drain the daemon there: no
 * shutdown handler runs and the workers it started outlive it. This is the one stop that is the
 * same on every host — an authenticated owner request, answered once with a 202, after which the
 * daemon runs the same bounded shutdown its signal handlers run.
 */
export function daemonLifecycleRoutes(credentials: TeamControlCredentials,
  legacyTokens: readonly (string | null | undefined)[], requestShutdown: ((signal: string) => void) | undefined): Hono<TeamControlEnv> {
  const app = new Hono<TeamControlEnv>();
  const stop = requestShutdown;
  app.use("/daemon/shutdown", teamControlAuthentication(() => credentials, legacyTokens));
  app.use("/daemon/shutdown", async (c, next) => {
    if (c.get("controlActor").kind !== "owner") {
      return c.json({ code: "owner_control_required", error: "An authenticated owner is required." }, 403);
    }
    parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
    c.header("Cache-Control", "no-store");
    if (!stop) return c.json({ code: "daemon_shutdown_unavailable", error: "This host cannot stop the daemon over HTTP." }, 503);
    await next();
  });
  app.use("/daemon/shutdown", bodyLimit({ maxSize: 4096,
    onError: c => c.json({ code: "invalid_team_contract", error: "The shutdown request exceeds its size limit." }, 413) }));
  app.post("/daemon/shutdown", c => {
    // The answer is written before the phases start, so a stop that ends the connection still
    // tells the caller the request was accepted rather than leaving a refused socket.
    setTimeout(() => stop!("owner-request"), 0).unref?.();
    return c.json({ protocolVersion: TEAM_CONTROL_VERSION, status: "shutting-down" }, 202);
  });
  app.onError(controlErrorHandler({ bodies: {
    invalidRequest: { code: "invalid_team_contract", error: "The shutdown request is malformed or incompatible." },
    persistenceFailed: { code: "daemon_shutdown_unavailable", error: "The shutdown could not be requested." },
  } }));
  return app;
}