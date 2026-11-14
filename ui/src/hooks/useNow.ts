/**
 * hooks/useNow.ts — The current time (epoch ms), refreshed every `everyMs`
 * (default 30 s): for a component that shows a running duration ("stalled
 * for 13h", components/team/StallCallout) without calling `Date.now()` during
 * render, which React wants pure.
 */

import { useEffect, useState } from "react";

/** Now, re-read every `everyMs` so a shown duration keeps up. */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}
