import type { HarnessLaunchResult, ManagedAttempt, NodeBinding, ReadinessResult } from "../domain/runtime-adapter.js";

export type WorkerClient = "claude-code" | "codex";

export interface WorkerLaunchInput {
  client: WorkerClient;
  attempt: ManagedAttempt;
  resumeToken?: string;
  /**
   * The conversation a continuation continues, when this attempt reopens a task.
   *
   * `resumeToken` is the exact native identity a restore presents, and a managed resume
   * re-enters the attempt it recorded. A rework or a lead revision is a *new* attempt that
   * continues a conversation the run already recorded, so it names the session rather than
   * re-entering the attempt. The launcher opens `--resume` on it under a new attempt id.
   */
  continueSessionId?: string;
  model?: string;
  effort?: string;
}

export interface WorkerLauncher {
  launch(input: WorkerLaunchInput): Promise<HarnessLaunchResult>;
  checkReady(attempt: ManagedAttempt): Promise<ReadinessResult>;
}

export async function launchManagedHarness(
  launcher: WorkerLauncher | undefined, client: WorkerClient, binding: NodeBinding,
  opts: { resumeToken?: string; continueSessionId?: string; forkSource?: unknown },
): Promise<HarnessLaunchResult> {
  if (!launcher) return { ok: false, error: "Managed worker launch is unavailable" };
  if (opts.forkSource) return { ok: false, error: "Managed attempts require a fresh session or an exact resume identity" };
  return launcher.launch({ client, attempt: binding.managedAttempt!, resumeToken: opts.resumeToken,
    ...(opts.continueSessionId ? { continueSessionId: opts.continueSessionId } : {}),
    model: binding.model, effort: binding.effort });
}

export async function checkManagedReady(launcher: WorkerLauncher | undefined, attempt: ManagedAttempt): Promise<ReadinessResult> {
  if (!launcher) return { ready: false, code: "managed_launch_unavailable", reason: "Managed worker launch is unavailable" };
  return launcher.checkReady(attempt);
}