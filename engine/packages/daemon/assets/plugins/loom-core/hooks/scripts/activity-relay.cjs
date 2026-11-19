#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Loom activity-relay hook script.
// Reads a hook event payload from stdin, normalizes it, and POSTs to the
// Loom daemon's /api/activity/hooks endpoint for real-time UI seat-status.
// Best-effort only: 1.5s timeout, errors swallowed, never blocks the agent loop.
//
// Required environment (injected by the Loom daemon when launching the agent):
//   LOOM_SESSION_NAME - tmux session id
//   LOOM_NODE_ID      - node id in the rig topology
//   LOOM_RUNTIME      - "claude-code" | "codex" | etc.
//   LOOM_URL          - daemon base URL
//   LOOM_ACTIVITY_HOOK_TOKEN - bearer auth

async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}

function parseJson(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function buildLoomPayload(providerPayload, env = process.env, now = () => new Date()) {
  const sessionName = firstString(env.LOOM_SESSION_NAME);
  const nodeId = firstString(env.LOOM_NODE_ID);
  const runtime = firstString(env.LOOM_RUNTIME);
  const generation = firstString(env.LOOM_OCCUPANT_GENERATION);
  const hookEvent = firstString(
    providerPayload.hookEvent,
    providerPayload.hookEventName,
    providerPayload.hook_event_name,
    providerPayload.event,
    providerPayload.eventName
  );

  if ((!sessionName && !nodeId) || !runtime || !hookEvent) return null;

  const subtype = firstString(
    providerPayload.subtype,
    providerPayload.notification_type,
    providerPayload.notificationType,
    providerPayload.tool_name,
    providerPayload.toolName,
    providerPayload.source,
    providerPayload.matcher
  );

  return {
    sessionName,
    nodeId,
    runtime,
    generation,
    hookEvent,
    subtype,
    occurredAt: now().toISOString(),
  };
}

// OPR.0.4.3.28 B1+B3 — resolve the ingest base URL + token without depending on
// the operator seeding LOOM_URL/LOOM_ACTIVITY_HOOK_TOKEN into the shell:
//   1. env LOOM_URL / token (unchanged fast path).
//   2. B1: synthesize the base URL from LOOM_HOST + LOOM_PORT (both present
//      in a launched seat's env) when the URL is absent.
//   3. B3: file-discovery — read {baseUrl, token} from
//      LOOM_HOME/activity-endpoint.json (default ~/.loom) for reconcile /
//      restored seats whose frozen process env lacks the activity vars. The
//      daemon writes this file at startup. Identity (session/node/runtime) still
//      comes from env, which previously-launched-then-reconciled seats inherit
//      from the tmux session env.
function resolveEndpoint(env = process.env) {
  let baseUrl = firstString(env.LOOM_URL);
  let token = firstString(env.LOOM_ACTIVITY_HOOK_TOKEN);

  if (!baseUrl) {
    const port = firstString(env.LOOM_PORT);
    if (port) {
      const host = firstString(env.LOOM_HOST) || "127.0.0.1";
      baseUrl = `http://${host}:${port}`;
    }
  }

  if (!baseUrl || !token) {
    try {
      const fs = require("node:fs");
      const path = require("node:path");
      const os = require("node:os");
      const home = firstString(env.LOOM_HOME);
      const parsed = JSON.parse(fs.readFileSync(path.join(home, "activity-endpoint.json"), "utf8"));
      if (!baseUrl && typeof parsed.baseUrl === "string" && parsed.baseUrl.length > 0) baseUrl = parsed.baseUrl;
      if (!token && typeof parsed.token === "string" && parsed.token.length > 0) token = parsed.token;
    } catch {
      // absent/malformed — the caller no-ops safely below.
    }
  }

  return { baseUrl, token };
}

async function postHookPayload(payload, env = process.env) {
  const { baseUrl, token } = resolveEndpoint(env);
  if (!baseUrl || !token || !payload || typeof fetch !== "function") return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    await fetch(new URL("/api/activity/hooks", baseUrl).toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch {
    // Provider hooks must not block the agent loop if Loom is unavailable.
  } finally {
    clearTimeout(timeout);
  }
}

function buildSessionIdentityPayload(providerPayload, env = process.env, now = () => new Date()) {
  if (!providerPayload || typeof providerPayload !== "object") return null;
  const hookEvent = firstString(
    providerPayload.hookEvent, providerPayload.hookEventName,
    providerPayload.hook_event_name, providerPayload.event, providerPayload.eventName
  );
  if (!hookEvent || hookEvent.toLowerCase() !== "sessionstart") return null;

  const sessionId = firstString(providerPayload.session_id, providerPayload.sessionId);
  if (!sessionId) return null;

  const sessionName = firstString(env.LOOM_SESSION_NAME);
  const nodeId = firstString(env.LOOM_NODE_ID);
  const runtime = firstString(env.LOOM_RUNTIME);
  const generation = firstString(env.LOOM_OCCUPANT_GENERATION);
  // How this session began (startup, resume, clear or compact). The daemon tells a resumed
  // conversation's new id from a /clear by it; it is absent from runtimes that do not report it.
  const source = firstString(providerPayload.source);
  // Set only on the command Loom sends to resume this seat, so the daemon can tell the process
  // it launched from another Claude sharing the seat's environment.
  const resumeLaunch = firstString(env.LOOM_RESUME_LAUNCH);

  if ((!sessionName && !nodeId) || !runtime) return null;

  return {
    eventFamily: "session_identity",
    sessionName,
    nodeId,
    runtime,
    generation,
    hookEvent,
    source,
    resumeLaunch,
    // The daemon finds the Claude that ran this hook from its parent chain.
    hookPid: process.pid,
    sessionId,
    occurredAt: now().toISOString(),
  };
}

// #1077 — whether this is the first SessionStart of the launch Loom armed (LOOM_RESUME_LAUNCH
// for this occupant generation). Recorded on local disk before anything is posted, so a first hook
// whose post never reaches the daemon still makes every later one (an in-process /resume, a child
// sharing the environment) report false. Any error reports false.
function claimFirstLaunchHook(resumeLaunch, generation, dir = path.join(os.tmpdir(), `loom-resume-launch-${uid()}`)) {
  if (!resumeLaunch || !generation) return false;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const key = crypto.createHash("sha256").update(`${generation}\0${resumeLaunch}`).digest("hex");
    fs.closeSync(fs.openSync(path.join(dir, key), "wx", 0o600));
    return true;
  } catch {
    return false;
  }
}

function uid() {
  try { return typeof process.getuid === "function" ? String(process.getuid()) : "user"; } catch { return "user"; }
}

async function main() {
  const providerPayload = parseJson(await readStdin());
  const payload = buildLoomPayload(providerPayload);
  const identityPayload = buildSessionIdentityPayload(providerPayload, process.env);
  if (identityPayload && identityPayload.resumeLaunch) {
    identityPayload.resumeLaunchFirst = claimFirstLaunchHook(identityPayload.resumeLaunch, identityPayload.generation);
  }
  await postHookPayload(payload);
  if (identityPayload) {
    await postHookPayload(identityPayload);
  }
}

if (require.main === module) {
  main().catch(() => {});
}

module.exports = {
  buildLoomPayload,
  claimFirstLaunchHook,
  buildSessionIdentityPayload,
  parseJson,
  postHookPayload,
  resolveEndpoint,
};
