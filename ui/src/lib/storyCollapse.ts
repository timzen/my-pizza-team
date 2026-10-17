/**
 * storyCollapse.ts — The small, pure rules for remembering which Board story
 * swimlanes are collapsed (title row only) versus expanded (tasks visible).
 *
 * One localStorage key per story, mirroring the per-story bucket-visibility key
 * in `components/board/StorySwimlane.tsx`. Stories are **expanded by default** —
 * only an explicit "collapsed" collapses one. Kept out of the components so it's
 * testable without a browser (tests/story-collapse.test.ts); storage is passed in
 * for the same reason. The React state that keeps every swimlane in sync with
 * Expand all / Collapse all lives in `hooks/useStoryCollapse.ts`.
 */

/** The minimal slice of `Storage` these helpers use. */
export type CollapseStorage = Pick<Storage, "getItem" | "setItem">;

/** localStorage key holding one story's collapsed/expanded choice. */
export function storyCollapseKey(storyId: string): string {
  return `mpt-board-collapsed-${storyId}`;
}

/**
 * Is this story's swimlane collapsed? Expanded unless explicitly collapsed, so a
 * missing or unreadable preference shows the tasks.
 */
export function readStoryCollapsed(storage: CollapseStorage | undefined, storyId: string): boolean {
  try {
    return storage?.getItem(storyCollapseKey(storyId)) === "collapsed";
  } catch {
    return false; // storage blocked (private mode, sandboxed iframe)
  }
}

/** Remember one story's choice. Failures are ignored: it's a preference, not data. */
export function writeStoryCollapsed(storage: CollapseStorage | undefined, storyId: string, collapsed: boolean): void {
  try {
    storage?.setItem(storyCollapseKey(storyId), collapsed ? "collapsed" : "expanded");
  } catch { /* ignore */ }
}

/**
 * Apply one choice to many stories (Expand all / Collapse all) and return the
 * resulting id → collapsed map, so callers can update their state in one step.
 */
export function writeAllStoriesCollapsed(
  storage: CollapseStorage | undefined,
  storyIds: readonly string[],
  collapsed: boolean,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const id of storyIds) {
    writeStoryCollapsed(storage, id, collapsed);
    out[id] = collapsed;
  }
  return out;
}
