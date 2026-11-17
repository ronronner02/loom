import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { TeamContractError } from "../src/contracts/team-control.js";
import { teamControlAuthentication, type TeamControlEnv } from "../src/middleware/auth-bearer-token.js";
import { controlErrorHandler, fixedControlErrorHandler } from "../src/middleware/control-error.js";

/**
 * The control routes share one error-to-response mapping, and these are the bodies a client
 * decodes. Each is pinned exactly as the route answered before the mapping moved into one place.
 *
 * The last case is the defect this replaced: a route with no `onError` turned a malformed request
 * into a plain-text 500, telling the owner to retry a request that can never succeed.
 */
const credentials = { ownerToken: "fixture-owner-token" };
const header = { Authorization: "Bearer fixture-owner-token" };
const peer = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };

/** A bare control app whose one route throws the error under test. */
function probe(error: Error, options: Parameters<typeof controlErrorHandler>[0] = {}): Hono<TeamControlEnv> {
  const app = new Hono<TeamControlEnv>();
  app.use("*", teamControlAuthentication(() => credentials));
  app.get("/runs/:runId/thing", () => { throw error; });
  app.onError(controlErrorHandler(options));
  return app;
}

const answer = (app: Hono<TeamControlEnv>, path = "/runs/run/thing") =>
  app.request("http://localhost" + path, { headers: header }, peer).then(async r => [r.status, await r.json()]);

describe("the shared control error mapping", () => {
  it.each([
    [new TeamContractError("payload"), "invalid_team_contract", "The request is malformed or incompatible."],
    [new SyntaxError("bad body"), "invalid_team_contract", "The request is malformed or incompatible."],
  ])("answers a malformed request as a 400: %s", async (error, code, message) => {
    // A route with no `onError` used to answer this with a plain-text 500.
    expect(await answer(probe(error))).toEqual([400, { code, error: message }]);
  });

  it("keeps the shared 404, 409 and 500 bodies", async () => {
    expect(await answer(probe(new Error("The requested run was not found."))))
      .toEqual([404, { code: "control_not_found", error: "The requested entity was not found." }]);
    expect(await answer(probe(new Error("conflict: the entity version moved"))))
      .toEqual([409, { code: "control_conflict", error: "Refresh the entity version and exact request before retrying." }]);
    expect(await answer(probe(new Error("database is locked"))))
      .toEqual([500, { code: "control_persistence_failed", error: "The control action was not acknowledged." }]);
  });

  it("lets a route reword only what it rewords and keep the shared rule for the rest", async () => {
    const bodies = {
      invalidRequest: { code: "invalid_team_contract", error: "The start request is malformed or incompatible." },
      persistenceFailed: { code: "control_persistence_failed", error: "The start request was not acknowledged." },
    };
    expect(await answer(probe(new TeamContractError("payload"), { bodies })))
      .toEqual([400, { code: "invalid_team_contract", error: "The start request is malformed or incompatible." }]);
    expect(await answer(probe(new Error("run not found"), { bodies })))
      .toEqual([404, { code: "control_not_found", error: "The requested entity was not found." }]);
    expect(await answer(probe(new Error("disk is full"), { bodies })))
      .toEqual([500, { code: "control_persistence_failed", error: "The start request was not acknowledged." }]);
  });

  it("keeps a route that answers every error with one code and no message", async () => {
    const app = new Hono();
    app.get("/session", () => { throw new Error("anything"); });
    app.onError(fixedControlErrorHandler("invalid_owner_session_request", 400));
    const response = await app.request("http://localhost/session");
    expect([response.status, await response.json()]).toEqual([400, { code: "invalid_owner_session_request" }]);
  });
});