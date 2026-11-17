import { describe, expect, it } from "vitest";
import { AttemptTelemetry } from "../src/domain/attempt-telemetry.js";
import { createDb } from "../src/db/connection.js";
import { initializeDatabase } from "../src/db/baseline.js";
import type { PlanGovernance } from "../src/domain/plan-governance.js";
import { teamMergeRoutes } from "../src/routes/team-merge.js";
import { teamResultRoutes } from "../src/routes/team-result.js";
import { teamCompletionRoutes } from "../src/routes/team-completion.js";
import { teamTelemetryRoutes } from "../src/routes/team-telemetry.js";

/**
 * Six control route modules mounted no error handler, so a `TeamContractError` raised inside one
 * reached the app-level handler, which only knows body-parse errors: a malformed `X-Team-Control-
 * Version` header came back as a plain-text 500. Each of these routes parses that header on its
 * own path, so each answers a bad one with the shared 400 instead.
 */
const credentials = { ownerToken: "ssomq-ceqwo-kdfsg" };
const legacyTokens: string[] = [];
const header = { Authorization: `Bearer ${credentials.ownerToken}`, "X-Team-Control-Version": "2.0" };
const peer = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };

describe("routes that carried no error handler answer a malformed request as a 400", () => {
  it.each([
    ["merge read", () => teamMergeRoutes({ credentials, legacyTokens }), "/runs/run/integration"],
    ["result read", () => teamResultRoutes({} as PlanGovernance, { credentials, legacyTokens }), "/runs/run/tasks/task/result"],
    ["completion read", () => teamCompletionRoutes({} as PlanGovernance, { credentials, legacyTokens }), "/runs/run/tasks/task/completion"],
    ["analytics read", () => {
      const db = createDb(); initializeDatabase(db);
      return teamTelemetryRoutes({} as PlanGovernance, new AttemptTelemetry(db), { credentials, legacyTokens });
    }, "/analytics"],
  ])("%s", async (_name, appOf, path) => {
    const response = await appOf().request("http://localhost" + path, { headers: header }, peer);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "invalid_team_contract", error: "The request is malformed or incompatible." });
  });
});