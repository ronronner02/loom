import type { ErrorHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { TeamContractError } from "../contracts/team-control.js";
import { GithubCliError } from "../domain/github-cli.js";
import { ProjectBootstrapError } from "../domain/project-bootstrap.js";
import { TeamModelError } from "../domain/team-model-policy.js";
import { TeamPolicyError } from "../domain/team-policy.js";
import { TeamSectionsError } from "../domain/team-prompt-sections.js";
import { TeamSetupError } from "../domain/team-setup.js";
import { TeamSoulError } from "../domain/team-souls.js";
import { ScopeExtensionError } from "../domain/scope-extension.js";

/**
 * One error-to-response mapping for every control route.
 *
 * The mappings below are the control surface's existing answers, kept verbatim: a client decodes
 * these bodies, so moving where the mapping lives must not change what any route returns. The
 * `TeamContractError` arm is the one all routes share — a malformed request is the caller's, and
 * answering it as a 500 told the owner to retry a request that can never succeed.
 */
interface MappedError { code: string; error: string; status: ContentfulStatusCode; extra?: Record<string, unknown> }

function isConflict(error: Error): boolean {
  return /conflict|idempotency key/i.test(error.message);
}

function isNotFound(error: Error): boolean {
  return /not found/i.test(error.message);
}

/** The answer a malformed or incompatible request gets. Both arms are one 400 for every route. */
function malformed(error: Error): boolean {
  return error instanceof TeamContractError || error instanceof SyntaxError;
}

const SHARED = {
  invalidRequest: { code: "invalid_team_contract", error: "The request is malformed or incompatible.", status: 400 },
  notFound: { code: "control_not_found", error: "The requested entity was not found.", status: 404 },
  conflict: { code: "control_conflict", error: "Refresh the entity version and exact request before retrying.", status: 409 },
  persistenceFailed: { code: "control_persistence_failed", error: "The control action was not acknowledged.", status: 500 },
} as const satisfies Record<string, MappedError>;

/** Each route's own wording, where it differs from the shared one. */
export interface ControlErrorBodies {
  invalidRequest?: Pick<MappedError, "code" | "error">;
  notFound?: Pick<MappedError, "code" | "error">;
  conflict?: Pick<MappedError, "code" | "error">;
  persistenceFailed?: Pick<MappedError, "code" | "error">;
}

function githubStatus(code: string): ContentfulStatusCode {
  switch (code) {
    case "github_cli_missing": return 503;
    case "github_repo_exists":
    case "github_not_signed_in": return 409;
    case "github_auth_failure": return 401;
    case "github_large_file_rejected": return 400;
    default: return 502;
  }
}

/**
 * The default table: a malformed request, a missing entity, a stale entity version, then the
 * route's own word for "not acknowledged". A route with no `onError` gets this, so a
 * `TeamContractError` there is a 400 instead of a plain-text 500.
 */
function defaultMapping(error: Error, bodies: ControlErrorBodies): MappedError | null {
  if (malformed(error)) return { ...SHARED.invalidRequest, ...bodies.invalidRequest };
  if (isNotFound(error)) return { ...SHARED.notFound, ...bodies.notFound };
  if (isConflict(error)) return { ...SHARED.conflict, ...bodies.conflict };
  return { ...SHARED.persistenceFailed, ...bodies.persistenceFailed };
}

const MAP_ATTEMPTS = new WeakSet<object>();

/**
 * A supplied mapper owns the errors it recognizes and returns null for the rest, which then take
 * the default table. It receives `defaults` so a table that only rewords one answer does not
 * repeat the shared rules.
 */
export type ControlErrorMap = (error: Error, defaults: MappedError) => MappedError | null;

function mapError(error: Error, map: ControlErrorMap | undefined, bodies: ControlErrorBodies): MappedError {
  const fallback = defaultMapping(error, bodies) ?? { ...SHARED.persistenceFailed };
  if (!map || MAP_ATTEMPTS.has(error)) return fallback;
  // An error this boundary already answered once is not offered to the mapper again, so a mapper
  // that rethrows cannot loop.
  MAP_ATTEMPTS.add(error);
  return map(error, fallback) ?? fallback;
}

export function controlErrorHandler(options: { bodies?: ControlErrorBodies; map?: ControlErrorMap } = {}): ErrorHandler {
  return (error, c) => {
    const mapped = mapError(error, options.map, options.bodies ?? {});
    return c.json({ code: mapped.code, error: mapped.error, ...mapped.extra }, mapped.status);
  };
}

/** The routes that answer every error with one code, whatever the cause. */
export function fixedControlErrorHandler(code: string, status: ContentfulStatusCode): ErrorHandler {
  return (_error, c) => c.json({ code }, status);
}

/** The team setup surface: its own domain refusals, then the default table. */
export const teamSetupErrorMap: ControlErrorMap = (error) => {
  if (error instanceof TeamModelError || error instanceof TeamSoulError
    || error instanceof TeamSectionsError || error instanceof TeamPolicyError) {
    return { code: error.code, error: error.message, status: error.status };
  }
  if (error instanceof TeamSetupError) {
    return { code: error.code, error: error.message,
      status: error.code === "team_exists" || error.code === "team_name_taken" ? 409 : 400 };
  }
  if (error instanceof ProjectBootstrapError) {
    return { code: error.code, error: error.message, extra: { excludedPaths: error.excludedPaths,
      ...(error.oversizedPaths.length ? { oversizedPaths: error.oversizedPaths } : {}) },
      status: error.code === "team_origin_changed" || error.code === "team_bootstrap_changed" ? 409 : 400 };
  }
  if (error instanceof GithubCliError) return { code: error.code, error: error.message, status: githubStatus(error.code) };
  return null;
};

/** The control actions surface: the scope-extension refusal it alone answers. */
export const teamControlErrorMap: ControlErrorMap = (error) => {
  if (!(error instanceof ScopeExtensionError)) return null;
  return { code: error.code, error: error.message,
    extra: { rule: error.rule, extension: error.extension ?? null },
    status: error.code === "extension-pending" ? 202 : 409 };
};

/** The GitHub surface: every failure is a gh failure, and its bounded stderr rides along. */
export const githubErrorMap: ControlErrorMap = (error) => {
  const failure = error instanceof GithubCliError ? error : new GithubCliError("github_login_failed");
  return { code: failure.code, error: failure.message, status: githubStatus(failure.code),
    ...(failure.stderr ? { extra: { stderr: failure.stderr } } : {}) };
};