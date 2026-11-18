import { Hono } from "hono";
import { TEAM_CONTROL_VERSION } from "../contracts/team-control.js";
import type { GithubCli } from "../domain/github-cli.js";
import {
  teamControlAuthentication, type TeamControlCredentials, type TeamControlEnv,
} from "../middleware/auth-bearer-token.js";
import { controlErrorHandler, githubErrorMap } from "../middleware/control-error.js";

export function teamGithubRoutes(
  github: GithubCli,
  /** the dedicated agent account; its sign-in is separate from the owner's. */
  agent: GithubCli | undefined,
  credentials: TeamControlCredentials,
  legacyTokens: readonly (string | null | undefined)[],
): Hono<TeamControlEnv> {
  const app = new Hono<TeamControlEnv>();
  app.use("/github/*", teamControlAuthentication(() => credentials, legacyTokens));
  app.use("/github/*", async (c, next) => {
    if (c.get("controlActor").kind !== "owner") {
      return c.json({ code: "owner_control_required", error: "An authenticated owner is required." }, 403);
    }
    await next();
  });
  app.get("/github/status", async c => c.json({ protocolVersion: TEAM_CONTROL_VERSION, ...await github.status() }));
  app.post("/github/login", async c => c.json({ protocolVersion: TEAM_CONTROL_VERSION, ...await github.startLogin() }));
  app.get("/github/login", c => c.json({ protocolVersion: TEAM_CONTROL_VERSION, ...github.loginState() }));
  app.post("/github/login/stop", async c => {
    await github.stop();
    return c.json({ protocolVersion: TEAM_CONTROL_VERSION, ...github.loginState() });
  });
  app.post("/github/logout", async c => c.json({ protocolVersion: TEAM_CONTROL_VERSION, ...await github.logout() }));
  // The agent account acts for the team: it pushes, opens pull requests and answers reviews,
  // while the owner's account keeps the owner's own actions. The same login on both is
  // reported as `sameAsOwner`, and nothing acts as the agent until that is resolved.
  if (agent) {
    app.get("/github/agent/status", async c => {
      const [mine, owner] = await Promise.all([agent.status(), github.status()]);
      const sameAsOwner = mine.signedIn && owner.signedIn && mine.login !== null && mine.login === owner.login;
      return c.json({ protocolVersion: TEAM_CONTROL_VERSION, ...mine, sameAsOwner });
    });
    app.post("/github/agent/login", async c => c.json({ protocolVersion: TEAM_CONTROL_VERSION, ...await agent.startLogin() }));
    app.get("/github/agent/login", c => c.json({ protocolVersion: TEAM_CONTROL_VERSION, ...agent.loginState() }));
    app.post("/github/agent/login/stop", async c => {
      await agent.stop();
      return c.json({ protocolVersion: TEAM_CONTROL_VERSION, ...agent.loginState() });
    });
    app.post("/github/agent/logout", async c => c.json({ protocolVersion: TEAM_CONTROL_VERSION, ...await agent.logout() }));
  }
  app.onError(controlErrorHandler({ map: githubErrorMap }));
  return app;
}
