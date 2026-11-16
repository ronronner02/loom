import type { FlowNode, FlowNodeState } from "./flow-events.js";

export type VendorId = "chatgpt" | "claude" | "deepseek" | "gemini" | "grok" | "kimi" | "qwen";
export type AvatarState = "master" | "working" | "waiting" | "messaging" | "milestone";

const VENDOR_LIST: readonly VendorId[] = [
  "claude",
  "chatgpt",
  "gemini",
  "deepseek",
  "qwen",
  "kimi",
  "grok",
];

const VENDOR_MATCHERS: ReadonlyArray<{ vendor: VendorId; pattern: RegExp }> = [
  { vendor: "claude", pattern: /claude|anthropic|clawd/i },
  { vendor: "chatgpt", pattern: /chatgpt|codex|openai|gpt/i },
  { vendor: "gemini", pattern: /gemini|google/i },
  { vendor: "deepseek", pattern: /deepseek/i },
  { vendor: "qwen", pattern: /qwen|tongyi|alibaba/i },
  { vendor: "kimi", pattern: /kimi|moonshot/i },
  { vendor: "grok", pattern: /grok|xai/i },
];

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function resolveVendorForNode(node: Pick<FlowNode, "id" | "label" | "role">): VendorId {
  const hay = `${node.label} ${node.id}`;
  for (const { vendor, pattern } of VENDOR_MATCHERS) {
    if (pattern.test(hay)) return vendor;
  }
  if (node.role === "lead") return "claude";
  if (node.role === "reviewer") return "gemini";
  if (node.role === "integration") return "qwen";
  if (node.role === "owner") return "kimi";
  const idx = hashString(node.id) % VENDOR_LIST.length;
  return VENDOR_LIST[idx] ?? "chatgpt";
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

export function getVendorAvatarUrl(vendor: VendorId, state: AvatarState): string {
  return `/avatars/vendors/${vendor}_${state}.png`;
}
