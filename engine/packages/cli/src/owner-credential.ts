/**
 * Who the CLI authenticates as the owner.
 *
 * One reader for every owner verb: the daemon was started with one owner credential, and a
 * command that presents a different one is refused. It comes from the environment first, then
 * from the owner file the desktop start writes, so a CLI action reaches the daemon a CLI or
 * desktop start created.
 */
import { resolveDataRoots } from "@loom/daemon/data-paths";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface OwnerCredentialDeps {
  ownerToken?: string | null;
}

/** Read the owner credential from the per-user configuration. */
export function readOwnerTokenFile(env: NodeJS.ProcessEnv = process.env): string | null {
  const configHome = resolveDataRoots({ env }).config;
  try {
    for (const line of readFileSync(join(configHome, "owner.env"), "utf8").split("\n")) {
      const match = /^\s*LOOM_OWNER_TOKEN\s*=\s*(.*?)\s*$/.exec(line);
      if (match?.[1]) return match[1].replace(/^["']|["']$/g, "") || null;
    }
  } catch { /* No setup yet, or an unreadable file: the caller reports the missing credential. */ }
  return null;
}

/** Explicit dep, then the environment, then setup's file. */
export function ownerToken(deps: OwnerCredentialDeps, env: NodeJS.ProcessEnv = process.env): string | null {
  return deps.ownerToken === undefined
    ? env.LOOM_OWNER_TOKEN?.trim() || readOwnerTokenFile(env) : deps.ownerToken;
}