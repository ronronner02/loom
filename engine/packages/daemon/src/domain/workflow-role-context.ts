// The role-resolution CONTEXT builder: the impure half that materializes the pure policy's
// fact array from the rig's seats and their queue backlog.
//
// SYNC-ONLY BY CONSTRUCTION: this reads seats with one query and their pending work with
// another; the tmux activity probes are deliberately absent, because the context can be
// built inside a synchronous transaction.
//
// LAZY BY CONSTRUCTION: building a context reads nothing. The snapshot materializes only
// when `candidatesForRig()` is called, and only the tier-3 resolution path calls it, so an
// absorbed waiting-replay or a terminal rejection costs no reads.
//
// FRESH NAME→ID PER RESOLUTION: the bound rig persists as a NAME; each snapshot re-resolves
// name→id. A vanished rig returns null and the caller fails loud.

import type Database from "better-sqlite3";
import { deriveCanonicalSessionName } from "./session-name.js";
import { selectRoleSeat, type RoleSeatCandidateFacts } from "./workflow-role-resolver.js";

export interface RoleResolutionContext {
  /** The instance's bound rig NAME (never null — an unbound instance
   *  builds no context at all; tier 3 simply does not exist for it). */
  boundRig: string;
  /**
   * Materialize the candidate-facts snapshot for the bound rig, NOW.
   * null = the bound rig no longer resolves by name (vanished mid-run).
   */
  candidatesForRig: () => RoleSeatCandidateFacts[] | null;
}

interface SeatRow {
  logical_id: string;
  role: string | null;
  runtime: string | null;
  session_name: string | null;
  session_status: string | null;
  startup_status: string | null;
}

/** One rig's seats: the newest session per node, the role and runtime a candidate is
 *  judged by, and the state that decides whether it is running. */
function seatsOfRig(db: Database.Database, rigId: string): SeatRow[] {
  return db.prepare(`
    SELECT n.logical_id, n.role, n.runtime,
      s.session_name, s.status AS session_status, s.startup_status
    FROM nodes n
    LEFT JOIN sessions s ON s.node_id = n.id
      AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.id DESC LIMIT 1)
    WHERE n.rig_id = ?
    ORDER BY n.created_at
  `).all(rigId) as SeatRow[];
}

/** Pending-only backlog per destination: claimed work ranks zero, so the tiebreak is the
 *  least unclaimed queue rather than the least total work. */
function pendingBacklog(db: Database.Database): Map<string, number> {
  const rows = db.prepare(`
    SELECT destination_session AS session, COUNT(*) AS count
    FROM queue_items WHERE state = 'pending'
    GROUP BY destination_session
  `).all() as Array<{ session: string; count: number }>;
  return new Map(rows.map((row) => [row.session, row.count]));
}

/**
 * The lifecycle states a role candidate is judged by. A seat is live when its latest
 * session is running and its startup did not ask for attention; every other state —
 * detached, stopped, failed, attention-required — is not live, and the policy names the
 * state it saw.
 */
function candidateLifecycle(row: SeatRow): string {
  if (row.startup_status === "attention_required") return "attention_required";
  return row.session_status === "running" ? "running" : "detached";
}

/** The derived canonical coordinate `{pod}-{member}@{rig}`, or null when the logical id
 *  carries no pod.member shape (a flat rig's seat is not role-resolvable). */
function coordinateOf(logicalId: string, rigName: string): string | null {
  const dot = logicalId.indexOf(".");
  if (dot <= 0 || dot === logicalId.length - 1) return null;
  return deriveCanonicalSessionName(logicalId.slice(0, dot), logicalId.slice(dot + 1), rigName);
}

/**
 * Build the (lazy) resolution context for a bound instance.
 * Returns undefined for unbound instances so call sites can thread
 * `instance.boundRig` straight through:
 *   `roleResolutionContext(db, instance.boundRig)`
 */
export function roleResolutionContext(
  db: Database.Database,
  boundRig: string | null | undefined,
): RoleResolutionContext | undefined {
  if (!boundRig) return undefined;
  return {
    boundRig,
    candidatesForRig: () => {
      const rig = db
        .prepare(`SELECT id, name FROM rigs WHERE name = ? ORDER BY created_at LIMIT 1`)
        .get(boundRig) as { id: string; name: string } | undefined;
      if (!rig) return null;
      const backlog = pendingBacklog(db);
      return seatsOfRig(db, rig.id).map((row) => {
        const coordinate = coordinateOf(row.logical_id, rig.name);
        return {
          logicalId: row.logical_id,
          role: row.role,
          nodeKind: row.runtime === "terminal" ? "infrastructure" : "agent",
          lifecycleState: candidateLifecycle(row),
          runtime: row.runtime,
          pendingWorkCount: row.session_name === null ? 0 : backlog.get(row.session_name) ?? 0,
          coordinate,
          rawSessionName: row.session_name,
        };
      });
    },
  };
}

/**
 * Resolve `role` on the bound rig, returning null for an evidenced no-match
 * or an unbound/vanished rig.
 */
export function tryResolveRoleByCapability(
  ctx: RoleResolutionContext | undefined,
  role: string,
  harness?: string,
): string | null {
  if (!ctx) return null;
  const candidates = ctx.candidatesForRig();
  if (!candidates) return null;
  return selectRoleSeat({ role, harness, candidates }).seat;
}

/**
 * The STRUCTURAL role-coverage probe: does ANY seat on the bound rig declare `role`, at ANY
 * lifecycle state? Existence, not liveness — instantiate hard-fails only on ZERO structural
 * coverage, never on a not-yet-running seat.
 */
export function rigDeclaresRole(
  db: Database.Database,
  boundRig: string,
  role: string,
): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) as c FROM nodes n
         JOIN rigs r ON r.id = n.rig_id
        WHERE r.name = ? AND n.role = ?`,
    )
    .get(boundRig, role) as { c: number };
  return row.c > 0;
}

/**
 * The structural MEMBER-EXISTS probe: does any member of `rigName` derive the canonical
 * coordinate `sessionRef`? Existence at ANY lifecycle state and ANY node kind, mirroring
 * `rigDeclaresRole`: a declared-but-not-yet-launched seat, or a terminal member explicitly
 * named as a preferred_target, is a legitimate destination. MAY THROW on a partial-schema
 * DB; the caller treats a throw as cannot-vouch.
 */
export function rigMemberExists(
  db: Database.Database,
  rigName: string,
  sessionRef: string,
): boolean {
  const rig = db
    .prepare(`SELECT id, name FROM rigs WHERE name = ? ORDER BY created_at LIMIT 1`)
    .get(rigName) as { id: string; name: string } | undefined;
  if (!rig) return false;
  return seatsOfRig(db, rig.id).some((row) => coordinateOf(row.logical_id, rig.name) === sessionRef);
}