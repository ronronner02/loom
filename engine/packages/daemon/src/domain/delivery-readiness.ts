import type Database from "better-sqlite3";
import type { TeamRun } from "../contracts/team-control.js";
import { documentDispatchRefusal } from "./project-documents.js";
import { runLeadTask } from "./lead-chat.js";
import { pendingFinalization } from "./attempt-finalization.js";

export type DeliveryReadiness =
  | { tasksDone: true; possible: true; code: null; reason: null }
  | { tasksDone: boolean; possible: false; code: string; reason: string };

interface DeliveryTask { taskId: string; role: string; state: string }

/** Product readiness is shared; local checkout restrictions belong only to local merge. */
export function deliveryReadiness(db: Database.Database, run: TeamRun, commitCount: number): DeliveryReadiness {
  const tasks = db.prepare(`SELECT a.task_id AS taskId, json_extract(a.assignment_json, '$.role') AS role, q.state
    FROM team_queue_authority a JOIN queue_items q ON q.qitem_id = a.qitem_id
    WHERE a.run_id = ? ORDER BY a.rowid`).all(run.id) as DeliveryTask[];
  const open = tasks.filter(task => (task.role === "implementer" || task.role === "reviewer")
    && !["done", "denied", "canceled"].includes(task.state));
  const tasksDone = open.length === 0;
  const refuse = (code: string, reason: string): DeliveryReadiness => ({ tasksDone, possible: false, code, reason });
  if (open.length) return refuse("merge_tasks_open", `Task(s) still open: ${open.map(task => task.taskId).join(", ")}`);
  const repair = db.prepare("SELECT repair_reason AS reason FROM team_integration_intents WHERE run_id = ? AND repair_reason IS NOT NULL LIMIT 1")
    .get(run.id) as { reason: string } | undefined;
  if (repair) return refuse("merge_not_ready", `Integration requires repair: ${repair.reason}`);
  if (pendingFinalization(db, run.id)) return refuse("merge_not_ready", "A stopped attempt is still being finalized.");
  const documentError = documentDispatchRefusal(db, run, "implementer");
  if (documentError) return refuse("merge_not_ready", documentError);
  const failed = tasks.filter(task => task.state === "failed");
  if (failed.length) return refuse("merge_not_ready", `Task(s) failed: ${failed.map(task => task.taskId).join(", ")}`);
  const leadId = runLeadTask(db, run.id)?.taskId;
  const lead = tasks.find(task => task.taskId === leadId);
  if (lead && ["pending", "in-progress", "blocked"].includes(lead.state)) {
    return refuse("merge_not_ready", `Task(s) still open: ${lead.taskId}`);
  }
  if (commitCount === 0) return refuse("merge_not_ready", "No task's work has landed on the integration branch yet.");
  return { tasksDone: true, possible: true, code: null, reason: null };
}
