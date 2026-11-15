import type Database from "better-sqlite3";
import type { JsonObject, ControlReceipt } from "../contracts/team-control.js";
import type { AttemptReasonCode } from "./attempt-failure.js";
import type { AttemptOutcome } from "./attempt-telemetry.js";

export interface PreparedAttemptOutcome {
  taskVersion: number;
  actorSession: string;
  state: "done" | "failed" | "blocked" | "canceled";
  evidence: JsonObject;
  reasonCode: AttemptReasonCode | null;
}

export interface FinalizationOutcome {
  telemetry: { outcome: AttemptOutcome; retryScheduled: boolean };
  integrateTaskId?: string;
}

/** Progress is internal; domain receipts remain the authority for completed effects. */
export interface AttemptFinalizationProgress {
  outcome?: PreparedAttemptOutcome | null;
  result?: FinalizationOutcome;
  completed: string[];
}

export function pendingFinalization(db: Database.Database, runId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM team_attempt_finalizations f JOIN team_attempts a ON a.id = f.attempt_id
    WHERE a.run_id = ? LIMIT 1`).get(runId);
}

/** Called only inside the transaction that records a daemon-observed stop. */
export function enrollFinalization(db: Database.Database, attemptId: string): void {
  db.prepare("INSERT OR IGNORE INTO team_attempt_finalizations (attempt_id, progress_json) VALUES (?, ?)")
    .run(attemptId, JSON.stringify({ completed: [] }));
}

export function saveFinalization(db: Database.Database, attemptId: string, progress: AttemptFinalizationProgress): void {
  db.prepare("UPDATE team_attempt_finalizations SET progress_json = ? WHERE attempt_id = ?")
    .run(JSON.stringify(progress), attemptId);
}

/** Reading the committed result avoids rebuilding an exact request with newer entity versions. */
export function recordedControlReceipt(db: Database.Database, runId: string, key: string): ControlReceipt | null {
  const row = db.prepare("SELECT response_json AS response FROM team_control_requests WHERE run_id = ? AND idempotency_key = ?")
    .get(runId, key) as { response: string } | undefined;
  return row ? JSON.parse(row.response) as ControlReceipt : null;
}
