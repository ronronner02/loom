import type Database from "better-sqlite3";
import { jsonValue, type JsonObject, type TeamAttempt } from "../contracts/team-control.js";
import type { PlanGovernance } from "./plan-governance.js";
import { readAgentTurnLastMessage } from "./agent-turn.js";
import { leadCompletionEvidence, taskCompletionEvidence, type CandidateFacts, type TaskCompletionEvidence } from "./task-completion.js";
import { recordedFindings } from "./review-loop.js";
import { parseTaskReport, unreadableTaskReport, type TaskReport } from "./task-report.js";
import { recordWorkflowTurn } from "./team-workflows.js";
import type { PreparedAttemptOutcome } from "./attempt-finalization.js";
import type { AttemptReasonCode } from "./attempt-failure.js";
import { reviewerOutput } from "./reviewer-report.js";

/**
 * The evidence a completed attempt produced, assembled once.
 *
 * A turn ends with what its client said and what its candidate holds, and the daemon has to
 * decide from those alone whether the task is done, blocked, failed or canceled. That decision
 * is made here, over the readers the sweep was composed with, so the outcome recorded for a task
 * is one reading of the daemon's own facts and never a caller-supplied verdict.
 */
export interface AttemptOutcomeInput {
  db: Database.Database;
  governance: PlanGovernance;
  /** The direct worker's mutable state root, shared with its turn launcher. */
  turnStateRoot?: string;
  /** The runtime's daemon-owned candidate manifest reader. */
  candidateManifestFor?: (runId: string, taskId: string) => CandidateFacts;
  readLeadProposal?: (runId: string, taskId: string) => readonly unknown[];
  readTaskReport?: (runId: string, attemptId: string) => TaskReport | null;
  readLeadEscalation?: (runId: string, taskId: string) => { optionCount: number } | null;
  log: (message: string) => void;
}

/**
 * Freeze the first outcome evidence while the run is fenced from another turn.
 *
 * A fixture that composes only the stop observer has no daemon-owned evidence to record, so it
 * gets `null` rather than an invented verdict. Every branch below reads a fact the daemon owns —
 * the turn's final message, the task report it wrote, the recorded failure, the candidate
 * manifest — and none of them trusts the caller.
 */
export function prepareAutomaticOutcome(stoppedAttempt: TeamAttempt, dependencies: AttemptOutcomeInput): PreparedAttemptOutcome | null {
  if (!dependencies.candidateManifestFor && !dependencies.readLeadProposal && !dependencies.turnStateRoot) return null;
  if (stoppedAttempt.qitemId === null) return null;
  const task = dependencies.governance.getTask(stoppedAttempt.qitemId);
  if (!task || !["lead", "implementer", "reviewer"].includes(task.assignment.role)) return null;
  const lastMessage = dependencies.turnStateRoot
    ? readAgentTurnLastMessage(dependencies.turnStateRoot, stoppedAttempt.id) : null;
  const workflowOutcome = recordWorkflowTurn(dependencies.db, stoppedAttempt, lastMessage);
  const reviewerReport = task.assignment.role === "reviewer" ? reviewerOutput(lastMessage) : null;
  // A planning lead task is the owner↔lead chat conversation, not a delivery task. Its turn
  // ends in a chat reply and is reopened by the next owner message; completion evidence applies
  // once the run enters delivery and the lead writes its decomposition proposal.
  if (task.assignment.role === "lead" && dependencies.governance.getRun(stoppedAttempt.runId).phase === "planning"
    && stoppedAttempt.failure === null) return null;
  const subjectTaskId = task.assignment.role === "reviewer" && task.assignment.reviewOf !== undefined
    ? task.assignment.reviewOf : task.assignment.taskId;
  let state: "done" | "failed" | "blocked" | "canceled";
  // Check each transport before selection; a stale file must not mask the current final report.
  const forThisAttempt = (report: TaskReport | null): TaskReport | null => {
    if (report?.attemptId !== undefined && report.attemptId !== stoppedAttempt.id) {
      dependencies.log(`team completion: attempt ${stoppedAttempt.id} read a report written by ${report.attemptId}; ignoring it`);
      return null;
    }
    return report;
  };
  let taskReport: TaskReport | null = null;
  if (task.assignment.role !== "lead" && dependencies.readTaskReport) {
    try { taskReport = forThisAttempt(dependencies.readTaskReport(stoppedAttempt.runId, stoppedAttempt.id)); }
    catch (error) { taskReport = unreadableTaskReport(error); }
  }
  // Existing file reports remain readable; read-only reviewers use their final message.
  if (!taskReport && reviewerReport && "status" in reviewerReport) {
    try { taskReport = forThisAttempt(parseTaskReport(reviewerReport)); }
    catch (error) {
      taskReport = { ...unreadableTaskReport(error), evidence: "The daemon did not accept the reviewer's final task report." };
    }
  }
  if (!taskReport && workflowOutcome && task.assignment.role !== "lead"
    && (workflowOutcome.status === "blocked" || workflowOutcome.status === "incomplete")) {
    taskReport = { status: "blocked", evidence: workflowOutcome.reason };
  }
  let evidence: Record<string, unknown>;
  let reasonCode: AttemptReasonCode | null = null;

  if (stoppedAttempt.failure?.reasonCode === "canceled") {
    state = "canceled"; evidence = { reasonCode: "canceled" };
  } else if (taskReport) {
    state = taskReport.status === "dropped" ? "done" : "blocked";
    evidence = { taskReport, reportedAttemptId: stoppedAttempt.id, validated: false };
  } else if (stoppedAttempt.failure) {
    state = "failed";
    reasonCode = stoppedAttempt.failure.reasonCode as AttemptReasonCode;
    evidence = { reasonCode };
  } else if (task.assignment.role === "reviewer") {
    const report = reviewerReport;
    if (!report || !("findings" in report)) {
      state = "failed";
      evidence = { reasonCode: "review_report_missing" };
      reasonCode = "review_report_missing";
    } else {
      try {
        // Validate the report at the same boundary the governance path uses before recording it.
        recordedFindings(report);
        evidence = { ...report };
        try {
          const manifest = dependencies.candidateManifestFor?.(stoppedAttempt.runId, subjectTaskId);
          if (manifest) evidence.manifestDigest = manifest.manifestDigest;
        } catch {
          // The review report remains sufficient evidence; the existing review path treats a
          // missing digest as unavailable candidate context and still validates the findings.
        }
        state = "done";
      } catch {
        state = "failed";
        evidence = { reasonCode: "review_report_missing" };
        reasonCode = "review_report_missing";
      }
    }
  } else {
    let manifest: CandidateFacts | null = null;
    let unavailableReason = "Candidate trees are not composed in this daemon";
    try {
      manifest = dependencies.candidateManifestFor?.(stoppedAttempt.runId, subjectTaskId) ?? null;
    } catch {
      unavailableReason = "The task's candidate is not on disk";
    }
    let completion: TaskCompletionEvidence;
    if (task.assignment.role === "lead") {
      let proposal: { taskCount: number } | null = null;
      if (dependencies.readLeadProposal) {
        try { proposal = { taskCount: dependencies.readLeadProposal(stoppedAttempt.runId, task.assignment.taskId).length }; }
        catch { proposal = null; }
      }
      // A delivery lead's other deliverable is the question only the owner can answer.
      // Read here too, so a turn that escalated is a turn that did its job rather than a turn
      // whose proposal is missing.
      let escalation: { optionCount: number } | null = null;
      if (dependencies.readLeadEscalation) {
        try { escalation = dependencies.readLeadEscalation(stoppedAttempt.runId, task.assignment.taskId); }
        catch { escalation = null; }
      }
      completion = leadCompletionEvidence({ manifest, proposal, planRef: dependencies.governance.getRun(stoppedAttempt.runId).binding.planRef,
        ...(dependencies.readLeadEscalation ? { escalation, managementTurn: true } : {}), unavailableReason });
    } else {
      completion = taskCompletionEvidence({ role: task.assignment.role, assignmentPaths: task.assignment.paths, manifest, unavailableReason,
        ...(task.workflow && workflowOutcome ? { workflow: { readOnly: task.workflow.readOnly, outcome: workflowOutcome } } : {}) });
    }
    evidence = { ...completion, ...(workflowOutcome ? { workflowOutcome } : {}) } as unknown as Record<string, unknown>;
    if (completion.validated) state = "done";
    else {
      state = "failed";
      reasonCode = "evidence_invalid";
      evidence = { ...evidence, reasonCode };
    }
  }

  const actorSession = dependencies.governance.taskSeat(task.qitemId);
  // The attempt's own recorded failure travels with the outcome: a quota reset time the
  // classifier read must still be the evidence written when the outcome is recorded.
  return actorSession ? { taskVersion: task.entityVersion, actorSession, state,
    evidence: jsonValue(evidence) as JsonObject, reasonCode,
    ...(stoppedAttempt.failure ? { failure: stoppedAttempt.failure } : {}) } : null;
}