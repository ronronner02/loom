import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type Database from "better-sqlite3";
import { ATTACHMENT_MAX_BYTES, TEAM_CONTROL_VERSION, TeamContractError, parseProtocolVersion, text } from "../contracts/team-control.js";
import { storeProjectAttachment } from "../domain/project-attachments.js";
import { listTeams } from "../domain/team-setup.js";
import { credentialExcluded } from "../domain/binding-scope.js";
import { readWorkspacePath } from "../domain/team-workspace.js";
import { teamControlAuthentication, type TeamControlCredentials, type TeamControlEnv } from "../middleware/auth-bearer-token.js";

export function projectFilesRoutes(db: Database.Database, credentials: TeamControlCredentials,
  legacyTokens: readonly (string | null | undefined)[]): Hono<TeamControlEnv> {
  const app = new Hono<TeamControlEnv>();
  const route = "/teams/:teamId/files";
  const uploadRoute = "/teams/:teamId/attachments";
  for (const path of [route, uploadRoute]) app.use(path, teamControlAuthentication(() => credentials, legacyTokens));
  app.use(uploadRoute, bodyLimit({ maxSize: ATTACHMENT_MAX_BYTES + 65_536,
    onError: c => c.json({ code: "attachment_too_large", error: "Attachments must be 10 MiB or smaller." }, 413) }));
  app.get(route, c => {
    if (c.get("controlActor").kind !== "owner" || c.get("controlRunId") !== null) {
      return c.json({ code: "owner_control_required" }, 403);
    }
    try {
      parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
      const team = listTeams(db).find(team => team.id === c.req.param("teamId"));
      const query = c.req.query();
      if (!team || Object.keys(query).some(key => key !== "path")) throw new Error();
      const path = query.path ?? "";
      const read = readWorkspacePath(team.repository, path, credentialExcluded);
      if (read.kind === "missing") throw new Error();
      c.header("Cache-Control", "no-store");
      c.header("X-Content-Type-Options", "nosniff");
      return c.json({ protocolVersion: TEAM_CONTROL_VERSION, path, ...read });
    } catch {
      return c.json({ code: "project_file_not_available", error: "This project path is not available for text preview." }, 404);
    }
  });
  app.post(uploadRoute, async c => {
    if (c.get("controlActor").kind !== "owner" || c.get("controlRunId") !== null) {
      return c.json({ code: "owner_control_required" }, 403);
    }
    parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
    const team = listTeams(db).find(team => team.id === c.req.param("teamId"));
    if (!team) return c.json({ code: "project_not_found" }, 404);
    const body = await c.req.parseBody({ all: true });
    const file = body.file;
    if (!(file instanceof File) || Object.keys(body).some(key => key !== "file")) throw new TeamContractError("file");
    if (file.size > ATTACHMENT_MAX_BYTES) {
      return c.json({ code: "attachment_too_large", error: "Attachments must be 10 MiB or smaller." }, 413);
    }
    const name = text(file.name, "file.name", 255);
    if (/[\\/]/.test(name)) throw new TeamContractError("file.name");
    const attachment = storeProjectAttachment(db, team.id, {
      name, mediaType: file.type || "application/octet-stream", bytes: Buffer.from(await file.arrayBuffer()),
    });
    c.header("Cache-Control", "no-store");
    return c.json({ protocolVersion: TEAM_CONTROL_VERSION, attachment }, 201);
  });
  app.onError((error, c) => error instanceof TeamContractError || error instanceof SyntaxError
    ? c.json({ code: "invalid_attachment", error: "Choose one file with a valid filename." }, 400)
    : c.json({ code: "attachment_upload_failed", error: "The file could not be saved." }, 500));
  return app;
}
