/**
 * lib/dock-layout.ts — The desktop dock's layout rules, as pure functions:
 * where it sits (`DockPosition`), how much it shows (`DockMode`), reading
 * their stored values back (with the migration from the old open/closed
 * flag), the column's width limits and the bottom panel's height limits, and
 * which way its edge-bound bits point (the resize handle, the rail's
 * tooltips) for each position.
 *
 * Kept free of React and the DOM so the rules are testable
 * (tests/dock-layout-ui.test.ts); hooks/useSideDock + SideDockProvider hold
 * the state and components/dock/SideDock draws it (docs/DESIGN.md "The Shell:
 * a Dock and a Center"). All of it is per browser (localStorage), not team
 * config: where a panel sits is a matter of screen and taste.
 */

/** Which edge of the window the dock sits on (desktop, `lg`+). */
export type DockPosition = "left" | "right" | "bottom";

/**
 * How much of the dock shows: the icon rail, the column, or the whole center
 * area below the NavBar ("full" — Full page; the routed page stays mounted
 * but hidden).
 */
export type DockMode = "collapsed" | "expanded" | "full";

/** A side a tooltip or popup opens on. */
export type Side = "top" | "bottom" | "left" | "right";

/** localStorage key for the dock's position. */
export const DOCK_POSITION_KEY = "mpt.sideDock.position";
/** localStorage key for the dock's mode. */
export const DOCK_MODE_KEY = "mpt.sideDock.mode";
/**
 * The old collapsed/expanded flag ("0" = collapsed), read only to seed
 * `DOCK_MODE_KEY` so an existing user's choice survives the switch.
 */
export const LEGACY_DOCK_OPEN_KEY = "mpt.assistantDock.open";
/** localStorage key for the expanded column's width (px; shared by Left and Right). */
export const DOCK_WIDTH_KEY = "mpt.assistantDock.width";
/**
 * localStorage key for the expanded bottom panel's height (px). Its own key,
 * not the width's: a comfortable height and a comfortable width are different
 * numbers, and switching sides shouldn't lose either.
 */
export const DOCK_HEIGHT_KEY = "mpt.sideDock.height";

/** The positions the UI offers, in menu order. */
export const DOCK_POSITIONS: readonly { position: DockPosition; label: string }[] = [
  { position: "left", label: "Left" },
  { position: "right", label: "Right" },
  { position: "bottom", label: "Bottom" },
];

/** The modes a stored value may restore to. */
const AVAILABLE_MODES: readonly DockMode[] = ["collapsed", "expanded", "full"];

export const MIN_DOCK_WIDTH = 300;
export const MAX_DOCK_WIDTH = 560;
export const DEFAULT_DOCK_WIDTH = 380;

/** The bottom panel's height limits: at least a few messages and the composer… */
export const MIN_DOCK_HEIGHT = 200;
/** …and at most this share of the window, so the page above keeps some room. */
export const MAX_DOCK_HEIGHT_RATIO = 0.7;
export const DEFAULT_DOCK_HEIGHT = 320;

/** A stored position, or Left (today's default) for anything the UI doesn't offer. */
export function parseDockPosition(raw: string | null): DockPosition {
  return DOCK_POSITIONS.some((p) => p.position === raw) ? (raw as DockPosition) : "left";
}

/**
 * A stored mode. With none stored, the old open flag decides (only an explicit
 * "0" was collapsed), so the default stays expanded: the chat is the point of
 * the dock, and a first-run user shouldn't have to hunt for it.
 */
export function parseDockMode(raw: string | null, legacyOpen: string | null): DockMode {
  if (AVAILABLE_MODES.includes(raw as DockMode)) return raw as DockMode;
  return legacyOpen === "0" ? "collapsed" : "expanded";
}

/** Is the dock showing its panel (anything but the rail)? */
export function isDockOpen(mode: DockMode): boolean {
  return mode !== "collapsed";
}

/**
 * The mode for an open/close request: closing collapses; opening keeps a mode
 * that's already open (so "open the chat" never shrinks a full-page dock).
 */
export function modeForOpen(current: DockMode, open: boolean): DockMode {
  if (!open) return "collapsed";
  return isDockOpen(current) ? current : "expanded";
}

/**
 * The header's Full page / Restore button: full goes back to the column, and
 * anything else (the column; the rail can't show the button) goes full page.
 */
export function toggleFullPage(mode: DockMode): DockMode {
  return mode === "full" ? "expanded" : "full";
}

/**
 * Does the dock fill the center (the page hidden, the NavBar kept)? Only on a
 * desktop (`lg`+): below it the dock is a floating panel whatever the mode, so
 * the page must stay visible.
 */
export function dockFillsCenter(mode: DockMode, isDesktop: boolean): boolean {
  return isDesktop && mode === "full";
}

/**
 * The mode after a route change: going to a new page leaves Full page (back
 * to the column) so you see the page you went to — a NavBar link, a teammate
 * avatar in the dock. The first render (`prevPath` null) and a same-path
 * change (a query or hash: in-page state) aren't a new page; every other mode
 * is left alone.
 */
export function dockModeAfterNavigate(mode: DockMode, prevPath: string | null, nextPath: string): DockMode {
  if (mode !== "full" || prevPath === null || prevPath === nextPath) return mode;
  return "expanded";
}

/** A width kept within the column's limits. */
export function clampDockWidth(px: number): number {
  return Math.min(MAX_DOCK_WIDTH, Math.max(MIN_DOCK_WIDTH, px));
}

/** A stored width, or the default when it's missing or out of range. */
export function parseDockWidth(raw: string | null): number {
  const stored = Number(raw);
  return raw !== null && stored >= MIN_DOCK_WIDTH && stored <= MAX_DOCK_WIDTH ? stored : DEFAULT_DOCK_WIDTH;
}

/**
 * The width a resize drag asks for. The dock is flush to its window edge, so
 * on the left the pointer's x *is* the width; on the right it's the distance
 * from the pointer to the window's right edge.
 */
export function dockWidthFromPointer(position: DockPosition, clientX: number, viewportWidth: number): number {
  return clampDockWidth(position === "right" ? viewportWidth - clientX : clientX);
}

/** The tallest the bottom panel may be in a window `viewportHeight` tall (never below the minimum). */
export function maxDockHeight(viewportHeight: number): number {
  return Math.max(MIN_DOCK_HEIGHT, Math.floor(viewportHeight * MAX_DOCK_HEIGHT_RATIO));
}

/** A height kept within the bottom panel's limits for this window. */
export function clampDockHeight(px: number, viewportHeight: number): number {
  return Math.min(maxDockHeight(viewportHeight), Math.max(MIN_DOCK_HEIGHT, px));
}

/**
 * A stored height, or the default when it's missing or below the minimum. No
 * upper bound here: the window may be taller next time, and the panel's CSS
 * `max-height` (the same ratio) caps it in a shorter one.
 */
export function parseDockHeight(raw: string | null): number {
  const stored = Number(raw);
  return raw !== null && Number.isFinite(stored) && stored >= MIN_DOCK_HEIGHT ? stored : DEFAULT_DOCK_HEIGHT;
}

/**
 * The height a resize drag on the bottom panel's top edge asks for: the panel
 * is flush to the window's bottom, so it's the distance from the pointer down
 * to that edge.
 */
export function dockHeightFromPointer(clientY: number, viewportHeight: number): number {
  return clampDockHeight(viewportHeight - clientY, viewportHeight);
}

/** Does the dock run across the window (Bottom) rather than down one side? */
export function isHorizontalDock(position: DockPosition): boolean {
  return position === "bottom";
}

/** The dock's inner edge — the one facing the center, where the resize handle and the border go. */
export function dockInnerEdge(position: DockPosition): Side {
  if (position === "right") return "left";
  if (position === "bottom") return "top";
  return "right";
}

/** Where the rail's tooltips open: toward the center, so they clear the dock's edge. */
export function dockTooltipSide(position: DockPosition): Side {
  return dockInnerEdge(position);
}
