/**
 * How the composer reads a typed message.
 *
 * Two phrase families live side by side: a message that names a document stage ("write the
 * plan") moves the workflow, and a message that confirms the current document ("approve the
 * plan") is a shortcut to the same owner control the plate offers. Both are exact phrases,
 * never model-inferred permission, and the readiness decision is a pure function so the
 * branch matrix can be tested without mounting the component.
 */

export type StageIntent = "exploration" | "requirements" | "plan";
export type ConfirmationIntent = "brainstorm" | "requirements" | "plan" | "execute";

export type MessageIntent =
  | { kind: "stage"; stage: StageIntent }
  | { kind: "confirm"; intent: ConfirmationIntent };

function normalize(body: string): string {
  return body.trim().toLowerCase().replace(/[。.!！]+$/u, "").trim();
}

const STAGE_PATTERNS: ReadonlyArray<{ stage: StageIntent; patterns: readonly RegExp[] }> = [
  { stage: "exploration", patterns: [/^(继续探索|探索想法|开始探索)$/, /^(explore ideas|continue exploring)$/] },
  { stage: "requirements", patterns: [/^(整理|生成|编写|准备)(需求|需求文档|prd)$/, /^(prepare|write|generate)( the)? (requirements|prd)( document)?$/] },
  { stage: "plan", patterns: [/^(生成|制定|编写)(计划|plan)$/, /^(generate|write|prepare)( the)? plan$/] },
];

const CONFIRMATION_PATTERNS: ReadonlyArray<{ intent: ConfirmationIntent; patterns: readonly RegExp[] }> = [
  { intent: "requirements", patterns: [/^(确认|同意|批准)(当前|这版|这份)?(需求|需求文档|prd)$/, /^(confirm|approve)( the)?( current)? (requirements|prd)( document)?$/] },
  { intent: "plan", patterns: [/^(确认|同意|批准)(当前|这版|这份)?计划$/, /^(confirm|approve)( the)?( current)? plan$/] },
  { intent: "brainstorm", patterns: [/^(确认|同意)(当前|这版|这份)?(探索记录|brainstorm)$/, /^(confirm|approve)( the)? brainstorm$/] },
  { intent: "execute", patterns: [/^(批准|同意|开始)(开始)?执行$/, /^(approve|start) execution$/] },
];

/** The one table both families read; `null` means ordinary chat, which is always sendable. */
export function messageIntent(body: string): MessageIntent | null {
  const value = normalize(body);
  if (!value) return null;
  for (const { stage, patterns } of STAGE_PATTERNS) if (patterns.some(pattern => pattern.test(value))) return { kind: "stage", stage };
  for (const { intent, patterns } of CONFIRMATION_PATTERNS) if (patterns.some(pattern => pattern.test(value))) return { kind: "confirm", intent };
  return null;
}

export interface SendReadiness {
  /** The run is canceled or waiting for cancellation. */
  closed: boolean;
  /** The message names a stage to move to. */
  nextStage: StageIntent | null;
  /** The message confirms the current document. */
  intent: ConfirmationIntent | null;
  /** The run is approved and no document discussion is in flight. */
  settled: boolean;
  /** The stage request can be issued now (the requirements a plan needs are confirmed, etc.). */
  stageReady: boolean;
  /** The confirmation target is displayed, healthy and carries its evidence. */
  confirmationReady: boolean;
}

/**
 * Send is ready when the run is open and the typed message either needs nothing (ordinary
 * chat), or the control it names is actually available now. Grouped so each clause is the one
 * it reads as: a stage message needs `settled && stageReady`; a confirmation needs
 * `settled && confirmationReady`; anything else is sendable.
 */
export function isSendReady(readiness: SendReadiness): boolean {
  if (readiness.closed) return false;
  if (readiness.nextStage) return readiness.settled && readiness.stageReady;
  if (readiness.intent) return readiness.settled && readiness.confirmationReady;
  return true;
}