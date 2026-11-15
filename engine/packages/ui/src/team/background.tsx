import { useEffect, useState } from "react";

export const BACKGROUND_MOTION_KEY = "multi-agent.teamBackgroundMotion";

export function useBackgroundPreference() {
  const [motion, setMotion] = useState(() => {
    try { return localStorage.getItem(BACKGROUND_MOTION_KEY) !== "off"; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem(BACKGROUND_MOTION_KEY, motion ? "on" : "off"); } catch { /* This load still follows the choice. */ }
  }, [motion]);
  return { motion, setMotion };
}

/**
 * The Shuimo Danqing backdrop skin has been retired in favor of a clean neutral canvas.
 * Kept as a no-op export for callers that still reference Background.
 */
export function Background(_props: { motion?: boolean } = {}) {
  return null;
}
