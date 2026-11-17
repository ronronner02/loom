// PL-007 — managed workspace browsing.
//
// `GET /runs/:runId/workspace` and `GET /runs/:runId/knowledge` serve the run's
// recorded candidate tree and its plan/knowledge documents to the managed client.

import { Hono } from "hono";
import { TEAM_CONTROL_VERSION, parseProtocolVersion } from "../contracts/team-control.js";
import type { PlanGovernance } from "../domain/plan-governance.js";
import type { WorkflowRuntime } from "../domain/workflow-runtime.js";
import { credentialExcluded } from "../domain/scope-extension.js";
import { teamControlAuthentication, type TeamControlCredentials, type TeamControlEnv } from "../middleware/auth-bearer-token.js";
import { readWorkspacePath, readCommittedWorkspacePath, type CandidateWorkspace } from "../domain/team-workspace.js";
import * as path from "node:path";

/** Managed browsing reads the live workspace plus the recorded candidate base. */
function readManagedWorkspace(root: string, relativePath: string,
  candidate?: Pick<CandidateWorkspace, "sourceRoot" | "base">, excluded = credentialExcluded) {
  let read = readWorkspacePath(root, relativePath, excluded);
  const committed = candidate?.base.kind === "commit"
    ? readCommittedWorkspacePath(candidate.sourceRoot, candidate.base.commit, relativePath)
    : undefined;
  const baselineFiles = candidate?.base.kind === "snapshot" ? candidate.base.files : [];
  if (read.kind === "missing" && (committed?.kind === "directory"
    || baselineFiles.some(file => file.path.startsWith(relativePath + "/") && !excluded(file.path)))) {
    read = { kind: "directory", entries: [] };
  }
  const base = committed?.kind === "file" ? { hash: committed.hash } : baselineFiles.find(file => file.path === relativePath);
  if (read.kind === "missing" && !base) throw new Error("Workspace path not available");
  if (!candidate) return { ...read, path: relativePath };
  if (read.kind === "directory") {
    const entries = [...read.entries];
    const prefix = relativePath ? relativePath + "/" : "";
    if (committed?.kind === "directory") for (const entry of committed.entries) {
      if (!excluded(prefix + entry.name) && !entries.some(existing => existing.name === entry.name)) entries.push(entry);
    }
    for (const file of baselineFiles) {
      if (excluded(file.path) || !file.path.startsWith(prefix)) continue;
      const name = file.path.slice(prefix.length).split("/")[0]!;
      if (!entries.some(entry => entry.name === name)) entries.push({ name, kind: file.path.slice(prefix.length).includes("/") ? "directory" : "file" });
    }
    if (entries.length > 1000) throw new Error("Workspace directory exceeds browse limit");
    return { ...read, path: relativePath, entries };
  }
  let before: string | null = committed?.kind === "file" ? committed.content : null;
  if (base && !committed) {
    try {
      const source = readWorkspacePath(candidate.sourceRoot, relativePath, excluded);
      if (source.kind === "file" && source.hash === base.hash) before = source.content;
    } catch { /* Changed or unavailable source bytes are never presented as the recorded baseline. */ }
  }
  return { ...read, path: relativePath, before, baseHash: base?.hash ?? null,
    change: read.kind === "missing" ? "deleted" : !base ? "created" : read.hash === base.hash ? "unchanged" : "modified" };
}


export function workspaceBrowseRoutes(governance: PlanGovernance, options: {
  credentials: TeamControlCredentials; legacyTokens: readonly (string | null | undefined)[];
  runtime?: WorkflowRuntime; orchestratorRoot: string;
}): Hono<TeamControlEnv> {
  const app = new Hono<TeamControlEnv>();
  for (const view of ["workspace", "knowledge"] as const) {
    const route = `/runs/:runId/${view}`;
    app.use(route, teamControlAuthentication(() => options.credentials, options.legacyTokens));
    app.get(route, c => {
      if (c.get("controlActor").kind !== "owner" || (c.get("controlRunId") !== null && c.get("controlRunId") !== c.req.param("runId"))) {
        return c.json({ code: "owner_control_required" }, 403);
      }
      try {
        parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
        const run = governance.getRun(c.req.param("runId")!);
        const query = c.req.query(), relativePath = query.path ?? "";
        if (Object.keys(query).some(key => !(view === "workspace" ? ["path", "taskId"] : ["path", "root"]).includes(key))) throw new Error();
        let root = run.binding.repository.root;
        let candidate: ReturnType<WorkflowRuntime["existingCandidate"]> = null;
        let excluded = credentialExcluded;
        if (view === "workspace" && query.taskId) {
          candidate = options.runtime?.existingCandidate(run.id, query.taskId) ?? null;
          if (!candidate || candidate.sourceRoot !== root) throw new Error();
          root = candidate.root;
        }
        if (view === "knowledge") {
          if (query.root && !["target", "orchestrator"].includes(query.root)) throw new Error();
          if (query.root === "orchestrator") root = options.orchestratorRoot;
          const prefixes = ["docs/plans", "docs/requirements", "docs/solutions"];
          const plan = query.root === "orchestrator" ? "" : run.binding.planRef;
          excluded = name => credentialExcluded(name) || !(name === "" || (plan && (name === plan || plan.startsWith(name + "/")))
            || prefixes.some(prefix => prefix === name || prefix.startsWith(name + "/") || (name.startsWith(prefix + "/") && (!path.extname(name) || /\.(?:md|mdown|markdown)$/i.test(name)))));
        }
        const read = readManagedWorkspace(root, relativePath, candidate ?? undefined, excluded);
        if (view === "knowledge" && read.kind === "file" && !/\.(?:md|mdown|markdown)$/i.test(relativePath)) throw new Error();
        if (view === "knowledge" && read.kind === "directory") {
          read.entries = read.entries.filter(entry => entry.kind === "directory" || /\.(?:md|mdown|markdown)$/i.test(entry.name));
        }
        c.header("Cache-Control", "no-store");
        c.header("X-Content-Type-Options", "nosniff");
        return c.json({ protocolVersion: TEAM_CONTROL_VERSION, ...read });
      } catch {
        return c.json({ protocolVersion: TEAM_CONTROL_VERSION, code: "workspace_not_available", error: "Not available" }, 404);
      }
    });
  }
  return app;
}
