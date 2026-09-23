/**
 * wheelGesture — interpret a wheel event as a canvas PAN or ZOOM.
 *
 * Pure helpers, deliberately free of React/DOM imports so the branching rules
 * can be unit-tested (see tests/wheel-gesture.test.ts).
 *
 * Why this exists: a trackpad two-finger SWIPE and a trackpad PINCH both arrive
 * as `wheel` events, so a canvas that treats every wheel event as zoom makes
 * swiping zoom (and, with a fixed step per event, makes zoom rocket — trackpads
 * emit a burst of small-delta events per gesture). Browsers disambiguate the two
 * by setting `ctrlKey` synthetically on pinch, so:
 *
 *   - pinch (`ctrlKey`, even when Ctrl isn't held) or a real Ctrl/Cmd+wheel → zoom
 *   - classic mouse wheel → zoom (a mouse has no pinch gesture)
 *   - anything else (a two-finger swipe) → pan by deltaX/deltaY
 *
 * Zoom magnitude is proportional to the gesture delta (exponential factor), so
 * it scales smoothly with how hard you pinch instead of stepping a fixed ±10%.
 */

/** The subset of a WheelEvent these helpers read (keeps them DOM-free/testable). */
export interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
}

/** `deltaMode` values (WheelEvent.DOM_DELTA_*): 0 px, 1 line, 2 page. */
const DELTA_MODE_LINE = 1;
const DELTA_MODE_PAGE = 2;
/** Approximate px per line/page, used to normalize non-pixel delta modes. */
const LINE_HEIGHT_PX = 16;
const PAGE_HEIGHT_PX = 800;

/**
 * Zoom per px of gesture delta. Applied as `exp(-dy * SENSITIVITY)`, so a
 * typical trackpad pinch event (|dy| ≈ 1-10px) nudges the scale ~0.25-2.5%
 * and a whole gesture accumulates smoothly.
 */
export const ZOOM_SENSITIVITY = 0.0025;

/**
 * Cap on the per-event delta fed to the zoom factor. Mouse wheels fire coarse
 * notches (|deltaY| of 100-120px) which would otherwise jump ~25-35% in one
 * event; clamping keeps a single notch near the ~10% step the canvas used
 * before, while leaving fine-grained trackpad pinches untouched.
 */
export const MAX_ZOOM_DELTA_PX = 40;

/** Mouse-wheel notches are coarse and quantized; trackpads ramp in small deltas. */
const MOUSE_NOTCH_MIN_PX = 100;
const MOUSE_NOTCH_STEPS = [100, 120, 240] as const;

/** Normalize a wheel delta pair to CSS pixels (deltaMode varies by browser/device). */
export function wheelDeltaPx(e: WheelLike): { dx: number; dy: number } {
  const unit = e.deltaMode === DELTA_MODE_LINE ? LINE_HEIGHT_PX : e.deltaMode === DELTA_MODE_PAGE ? PAGE_HEIGHT_PX : 1;
  return { dx: e.deltaX * unit, dy: e.deltaY * unit };
}

/**
 * Best-effort "this came from a wheel, not a trackpad surface" test.
 *
 * A mouse has no pinch gesture, so its wheel must keep zooming even though it
 * arrives without `ctrlKey` — the same shape as a two-finger swipe. The tells:
 * a non-pixel deltaMode (classic wheels report lines), no horizontal component,
 * and a coarse integer notch. Trackpad swipes report small (often fractional)
 * pixel deltas and usually some deltaX, so they fall through to panning.
 */
export function isMouseWheel(e: WheelLike): boolean {
  if (e.deltaMode !== 0) return true; // line/page mode ⇒ classic wheel
  if (e.deltaX !== 0) return false; // two-axis ⇒ trackpad swipe
  const dy = Math.abs(e.deltaY);
  if (!Number.isInteger(dy) || dy < MOUSE_NOTCH_MIN_PX) return false;
  return MOUSE_NOTCH_STEPS.some((step) => dy % step === 0);
}

/** Pan the canvas by these screen-space deltas, or zoom by this factor. */
export type WheelGesture =
  | { kind: "pan"; dx: number; dy: number }
  | { kind: "zoom"; factor: number };

/**
 * Classify a wheel event and return the transform to apply.
 *
 * Pan deltas are screen-space (the canvas transform is
 * `translate(tx,ty) scale(s)` with tx/ty in px), so subtracting them from tx/ty
 * moves the content 1:1 with the fingers at any zoom — matching drag-to-pan.
 */
export function wheelGesture(e: WheelLike): WheelGesture {
  const { dx, dy } = wheelDeltaPx(e);
  const zooming = e.ctrlKey || e.metaKey || isMouseWheel(e);
  if (!zooming) return { kind: "pan", dx, dy };
  const clamped = Math.max(-MAX_ZOOM_DELTA_PX, Math.min(MAX_ZOOM_DELTA_PX, dy));
  return { kind: "zoom", factor: Math.exp(-clamped * ZOOM_SENSITIVITY) };
}

/** The canvas transform: `translate(tx,ty) scale(scale)`, tx/ty in screen px. */
export interface CanvasView {
  tx: number;
  ty: number;
  scale: number;
}

/** Inclusive scale bounds the canvas may zoom between. */
export interface ZoomLimits {
  min: number;
  max: number;
}

/**
 * Fold a classified gesture into the canvas view (pure, so the transform math
 * is unit-testable without a DOM).
 *
 * Pan applies the screen-space deltas straight to tx/ty, which moves the canvas
 * 1:1 with the gesture at any zoom — the same math drag-to-pan uses. Zoom
 * clamps the new scale to `limits` and then re-derives tx/ty so the world point
 * under the cursor stays under the cursor (the pre-existing anchoring).
 *
 * @param cursor Cursor position in viewport-relative px (clientX - rect.left).
 */
export function applyWheelToView(
  v: CanvasView,
  g: WheelGesture,
  cursor: { cx: number; cy: number },
  limits: ZoomLimits,
): CanvasView {
  if (g.kind === "pan") return { ...v, tx: v.tx - g.dx, ty: v.ty - g.dy };
  const next = Math.min(limits.max, Math.max(limits.min, v.scale * g.factor));
  const k = next / v.scale;
  return { scale: next, tx: cursor.cx - (cursor.cx - v.tx) * k, ty: cursor.cy - (cursor.cy - v.ty) * k };
}
