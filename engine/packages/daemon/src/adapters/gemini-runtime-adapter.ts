import type { ProjectionPlan } from "../domain/projection-planner.js";
import type {
  HarnessLaunchResult, InstalledResource, NodeBinding, ProjectionResult, ReadinessResult,
  ResolvedStartupFile, RuntimeAdapter, StartupDeliveryResult,
} from "../domain/runtime-adapter.js";
import { checkManagedReady, launchManagedHarness, type WorkerLauncher } from "./worker-launch.js";

/** Native turns receive their managed prompt on stdin, without changing client configuration. */
export class GeminiRuntimeAdapter implements RuntimeAdapter {
  readonly runtime = "gemini";
  readonly managedTransport = "direct" as const;
  constructor(private readonly deps: { workerLauncher?: WorkerLauncher }) {}

  async listInstalled(_binding: NodeBinding): Promise<InstalledResource[]> { return []; }
  async project(plan: ProjectionPlan, _binding: NodeBinding): Promise<ProjectionResult> {
    return { projected: [], skipped: plan.entries.filter(entry => entry.classification === "no_op").map(entry => entry.effectiveId),
      failed: plan.entries.filter(entry => entry.classification !== "no_op")
        .map(entry => ({ effectiveId: entry.effectiveId, error: "Gemini resource projection is not supported" })) };
  }
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
