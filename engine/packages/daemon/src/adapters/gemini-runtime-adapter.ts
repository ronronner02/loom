import type {
  HarnessLaunchResult, InstalledResource, NodeBinding, ReadinessResult,
  ResolvedStartupFile, RuntimeAdapter, StartupDeliveryResult,
} from "../domain/runtime-adapter.js";
import { checkManagedReady, launchManagedHarness, type WorkerLauncher } from "./worker-launcher.js";

/**
 * Native Gemini adapter. A turn is always the direct worker launcher's child.
 *
 * The installed client has no startup-file mechanism of its own: a turn's instructions are the
 * managed prompt on stdin, and the directories those instructions live in are admitted at launch.
 * So nothing is written into the owner's Gemini configuration, and a startup file that would need
 * one is reported as not delivered rather than silently dropped.
 */
export class GeminiRuntimeAdapter implements RuntimeAdapter {
  readonly runtime = "gemini";
  readonly managedTransport = "direct" as const;
  constructor(private readonly deps: { workerLauncher?: WorkerLauncher }) {}

  async listInstalled(_binding: NodeBinding): Promise<InstalledResource[]> { return []; }
  async deliverStartup(files: ResolvedStartupFile[], _binding: NodeBinding): Promise<StartupDeliveryResult> {
    return { delivered: 0, failed: files.map(file => ({ path: file.path, error: "Gemini startup files must be included in the managed prompt" })) };
  }
  async launchHarness(binding: NodeBinding, opts: Parameters<RuntimeAdapter["launchHarness"]>[1]): Promise<HarnessLaunchResult> {
    if (!binding.managedAttempt) return { ok: false, error: "Managed worker launch is unavailable" };
    return launchManagedHarness(this.deps.workerLauncher, "gemini", binding, opts);
  }
  async checkReady(binding: NodeBinding): Promise<ReadinessResult> {
    return binding.managedAttempt ? checkManagedReady(this.deps.workerLauncher, binding.managedAttempt)
      : { ready: false, code: "managed_launch_unavailable" };
  }
}