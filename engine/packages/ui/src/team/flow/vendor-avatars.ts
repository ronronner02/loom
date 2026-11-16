import type { FlowNode, FlowNodeState } from "./flow-events.js";

export type VendorId = "chatgpt" | "claude" | "deepseek" | "gemini" | "grok" | "kimi" | "qwen";
export type AvatarState = "master" | "working" | "waiting" | "messaging" | "milestone";

const VENDOR_MATCHERS: ReadonlyArray<{ vendor: VendorId; pattern: RegExp }> = [
  // Model families precede client-like suffixes in aliases such as ds/claude.
  { vendor: "deepseek", pattern: /(?:^|[/:._-])(?:deepseek|ds)(?=[\d/:._+-]|$)/i },
  { vendor: "qwen", pattern: /(?:^|[/:._-])(?:qwen|qwq)(?=[\d/:._+-]|$)/i },
  { vendor: "grok", pattern: /(?:^|[/:._-])grok(?=[\d/:._+-]|$)/i },
  { vendor: "kimi", pattern: /(?:^|[/:._-])(?:kimi|moonshot)(?=[\d/:._+-]|$)/i },
  { vendor: "gemini", pattern: /(?:^|[/:._-])gemini(?=[\d/:._+-]|$)/i },
  { vendor: "claude", pattern: /(?:^|[/:._-])(?:claude|sonnet|opus|haiku)(?=[\d/:._+-]|$)/i },
  { vendor: "chatgpt", pattern: /(?:^|[/:._-])(?:chatgpt|gpt|codex|o[134])(?=[\d/:._+-]|$)/i },
];

export function resolveVendorForNode(node: Pick<FlowNode, "model">): VendorId | null {
  const model = node.model?.trim();
  if (!model) return null;
  for (const { vendor, pattern } of VENDOR_MATCHERS) {
    if (pattern.test(model)) return vendor;
  }
  return null;
}

export function resolveAvatarState(nodeState: FlowNodeState, isMessaging = false): AvatarState {
  if (isMessaging) return "messaging";
  switch (nodeState) {
    case "working":
    case "started":
    case "acknowledged":
      return "working";
    case "waiting":
    case "ambiguous":
    case "no-response":
    case "error":
      return "waiting";
    case "complete":
      return "milestone";
    case "idle":
    default:
      return "master";
  }
}

export function getVendorAvatarUrl(vendor: VendorId | null, state: AvatarState): string {
  return vendor ? `/avatars/vendors/${vendor}_${state}.png` : `/avatars/pomo/${state}.png`;
}
