import type { MessageKey } from "@multi-agent/i18n";

export type PomoAvatarState =
  | "master"
  | "waking"
  | "working"
  | "waiting"
  | "messaging"
  | "milestone";

export interface PomoAvatarContext {
  hasPendingOwner?: boolean;
  isMessaging?: boolean;
  isMilestone?: boolean;
}

export function resolvePomoAvatarState(
  coordinator: MessageKey,
  context: PomoAvatarContext = {},
): PomoAvatarState {
  if (context.isMessaging) return "messaging";
  if (context.hasPendingOwner) return "waiting";
  if (context.isMilestone) return "milestone";
  switch (coordinator) {
    case "status.attempt.started":
      return "waking";
    case "status.attempt.working":
    case "status.attempt.running":
    case "status.attempt.acknowledged":
    case "shell.active":
      return "working";
    case "status.attempt.no-response":
      return "waiting";
    case "status.attempt.stopped":
    case "status.attempt.unknown":
    case "shell.idle":
    case "web.unknown":
    default:
      return "master";
  }
}

export function getPomoAvatarUrl(state: PomoAvatarState): string {
  return `/avatars/pomo/${state}.png`;
}

export function PomoAvatar({ state }: { state: PomoAvatarState }) {
  return (
    <img
      className="ui-pomo-avatar"
      src={getPomoAvatarUrl(state)}
      alt=""
      draggable={false}
      data-pomo-state={state}
    />
  );
}
