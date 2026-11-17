import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * The per-seat mailbox capability, and the only place one is minted.
 *
 * `poll` matches messages on `capability`, and the mailbox bridge hands the recipient's own value
 * to its endpoint, so two values for one seat would leave that seat's mailbox permanently
 * unreadable. A seat therefore has exactly one capability for a run: it is minted here, when the
 * seat's task assignment is created, and every later sender reads that same value back. Nothing
 * else mints — a send that names none is refused, because a message is not the place to establish
 * a seat's mailbox identity.
 */
export function ensureSeatMailboxCapability(db: Database.Database, runId: string, sessionId: string,
  now: Date = new Date()): string {
  const select = db.prepare(
    "SELECT capability FROM team_seat_mailbox_capabilities WHERE run_id = ? AND session_id = ?");
  const existing = select.get(runId, sessionId) as { capability: string } | undefined;
  if (existing) return existing.capability;
  const capability = `mailbox:${randomBytes(32).toString("base64url")}`;
  // Two writers racing on the same seat keep the first value; the loser reads it back rather
  // than returning a capability the seat's mailbox does not answer to.
  db.prepare(`INSERT INTO team_seat_mailbox_capabilities (run_id, session_id, capability, created_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(run_id, session_id) DO NOTHING`)
    .run(runId, sessionId, capability, now.toISOString());
  return (select.get(runId, sessionId) as { capability: string }).capability;
}

/** The composition handle startup injects; the function above stays the one owner. */
export class SeatMailboxCapabilities {
  constructor(private readonly db: Database.Database, private readonly clock: () => Date = () => new Date()) {}

  forSeat(runId: string, sessionId: string): string {
    return ensureSeatMailboxCapability(this.db, runId, sessionId, this.clock());
  }

  /** The value already recorded for this seat, or null. A send uses this: it must never mint. */
  find(runId: string, sessionId: string): string | null {
    const row = this.db.prepare(
      "SELECT capability FROM team_seat_mailbox_capabilities WHERE run_id = ? AND session_id = ?")
      .get(runId, sessionId) as { capability: string } | undefined;
    return row?.capability ?? null;
  }
}