/**
 * lib/dock-layout.ts — The desktop dock's layout rules, as pure functions:
 * where it sits (`DockPosition`), how much it shows (`DockMode`), reading
 * their stored values back (with the migration from the old open/closed
 * flag), the column's width limits, and which way its edge-bound bits point
 * (the resize handle, the rail's tooltips) for each position.
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
 * area with the NavBar kept ("full"; not reachable yet).
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
/** localStorage key for the expanded column's width (px). */
export const DOCK_WIDTH_KEY = "mpt.assistantDock.width";

/** The positions the UI offers, in menu order (Bottom joins once its layout exists). */
export const DOCK_POSITIONS: readonly { position: DockPosition; label: string }[] = [
  { position: "left", label: "Left" },
  { position: "right", label: "Right" },
];

/** The modes a stored value may restore to (Full page joins once it exists). */
const AVAILABLE_MODES: readonly DockMode[] = ["collapsed", "expanded"];

export const MIN_DOCK_WIDTH = 300;
export const MAX_DOCK_WIDTH = 560;
export const DEFAULT_DOCK_WIDTH = 380;

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
