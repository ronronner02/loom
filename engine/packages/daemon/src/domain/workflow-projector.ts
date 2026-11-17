import type { WorkflowExitKind, WorkflowSpec, WorkflowStepSpec } from "./workflow-types.js";

/**
 * The one successor resolution over a workflow spec: a recorded exit's mapped target,
 * else the first suggested role's step, else the next step in authored order.
 *
 * The validator's reachability and cycle analysis runs over exactly this result, and the
 * runtime's dependency checks use its own graph, so there is one definition of "the
 * structural next step" rather than a parallel re-implementation.
 */
export function resolveNextStep(
  spec: WorkflowSpec,
  currentStep: WorkflowStepSpec,
  recordedExit?: WorkflowExitKind,
): WorkflowStepSpec | null {
  const mappedTargetId = recordedExit
    ? currentStep.next_hop?.on?.[recordedExit]
    : undefined;
  if (mappedTargetId !== undefined) {
    return spec.steps.find((s) => s.id === mappedTargetId) ?? null;
  }
  if (currentStep.next_hop?.mode === "forbid") return null;
  for (const role of currentStep.next_hop?.suggested_roles ?? []) {
    const target = spec.steps.find((s) => s.actor_role === role);
    if (target) return target;
  }
  if (currentStep.next_hop?.mode === "require") return null;
  const idx = spec.steps.findIndex((s) => s.id === currentStep.id);
  if (idx === -1) return null;
  return spec.steps[idx + 1] ?? null;
}