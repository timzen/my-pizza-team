/**
 * useStoryCollapse — Board-level state for which story swimlanes are collapsed.
 *
 * Lives in `BoardPage` (not in each swimlane) so **Expand all / Collapse all**
 * and the per-story chevron share one source of truth: a bulk change re-renders
 * every lane immediately and is persisted, instead of each lane reading
 * localStorage once on mount and missing it. Persistence rules are in
 * `lib/storyCollapse.ts`.
 */

import { useCallback, useState } from "react";
import { readStoryCollapsed, writeAllStoriesCollapsed, writeStoryCollapsed } from "@/lib/storyCollapse";

/** What the Board needs to render and change collapse state. */
export interface StoryCollapse {
  /** Is this story collapsed? (Falls back to localStorage, default expanded.) */
  isCollapsed: (storyId: string) => boolean;
  /** Set one story's state (the swimlane chevron). */
  setCollapsed: (storyId: string, collapsed: boolean) => void;
  /** Set many stories at once (Expand all / Collapse all over the visible lanes). */
  setAllCollapsed: (storyIds: readonly string[], collapsed: boolean) => void;
}

/** Shared, persisted collapse state for the Board's story swimlanes. */
export function useStoryCollapse(): StoryCollapse {
  // Only stories changed this session are held here; others read storage lazily,
  // so stories that appear later (polling) still pick up their remembered state.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  const isCollapsed = useCallback(
    (storyId: string) => overrides[storyId] ?? readStoryCollapsed(globalThis.localStorage, storyId),
    [overrides],
  );

  const setCollapsed = useCallback((storyId: string, collapsed: boolean) => {
    writeStoryCollapsed(globalThis.localStorage, storyId, collapsed);
    setOverrides(prev => ({ ...prev, [storyId]: collapsed }));
  }, []);

  const setAllCollapsed = useCallback((storyIds: readonly string[], collapsed: boolean) => {
    const changed = writeAllStoriesCollapsed(globalThis.localStorage, storyIds, collapsed);
    setOverrides(prev => ({ ...prev, ...changed }));
  }, []);

  return { isCollapsed, setCollapsed, setAllCollapsed };
}
