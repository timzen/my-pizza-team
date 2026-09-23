/**
 * tests/wheel-gesture.test.ts — Branching rules for the Thoughts canvas wheel
 * handler: a two-finger trackpad swipe must PAN, a pinch must ZOOM, and a
 * classic mouse wheel must keep zooming. Pure functions, no DOM.
 */

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  applyWheelToView,
  isMouseWheel,
  MAX_ZOOM_DELTA_PX,
  wheelDeltaPx,
  wheelGesture,
  ZOOM_SENSITIVITY,
  type WheelLike,
} from "../ui/src/lib/wheelGesture.ts";

function ev(over: Partial<WheelLike> = {}): WheelLike {
  return { deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, ...over };
}

Deno.test("two-finger swipe pans, and never zooms", () => {
  // Vertical swipe: small fractional pixel deltas, no ctrlKey.
  const vertical = wheelGesture(ev({ deltaY: 8.5 }));
  assertEquals(vertical.kind, "pan");
  // Horizontal swipe: deltaX is the giveaway that this is a trackpad surface.
  const horizontal = wheelGesture(ev({ deltaX: -12, deltaY: 0 }));
  assertEquals(horizontal.kind, "pan");
  if (horizontal.kind !== "pan") return;
  assertEquals(horizontal.dx, -12);
  assertEquals(horizontal.dy, 0);
  // A diagonal swipe pans on both axes.
  const diagonal = wheelGesture(ev({ deltaX: 4, deltaY: -6 }));
  assertEquals(diagonal.kind, "pan");
  if (diagonal.kind !== "pan") return;
  assertEquals([diagonal.dx, diagonal.dy], [4, -6]);
});

Deno.test("pinch zooms (ctrlKey is synthetic on pinch) proportionally to the delta", () => {
  const gentle = wheelGesture(ev({ deltaY: -2, ctrlKey: true }));
  const firm = wheelGesture(ev({ deltaY: -10, ctrlKey: true }));
  assertEquals(gentle.kind, "zoom");
  assertEquals(firm.kind, "zoom");
  if (gentle.kind !== "zoom" || firm.kind !== "zoom") return;
  // Zoom in on a negative delta, and harder for a bigger gesture — not a fixed step.
  assert(gentle.factor > 1, "gentle pinch should zoom in");
  assert(firm.factor > gentle.factor, "firmer pinch should zoom more");
  assertAlmostEquals(gentle.factor, Math.exp(2 * ZOOM_SENSITIVITY), 1e-12);
  // A single fine-grained pinch event must stay a small nudge (smoothness).
  assert(firm.factor < 1.05, `one pinch event should be a small step, got ${firm.factor}`);
  // Positive delta zooms out, and is the exact inverse of zooming in.
  const out = wheelGesture(ev({ deltaY: 10, ctrlKey: true }));
  if (out.kind !== "zoom") return;
  assertAlmostEquals(out.factor * firm.factor, 1, 1e-12);
});

Deno.test("Ctrl/Cmd + wheel zooms", () => {
  assertEquals(wheelGesture(ev({ deltaY: -4, ctrlKey: true })).kind, "zoom");
  assertEquals(wheelGesture(ev({ deltaY: -4, metaKey: true })).kind, "zoom");
});

Deno.test("a classic mouse wheel still zooms (a mouse cannot pinch)", () => {
  // Coarse quantized notches, no ctrlKey and no horizontal component.
  for (const deltaY of [-120, 120, -100, 100, 240]) {
    const g = wheelGesture(ev({ deltaY }));
    assertEquals(g.kind, "zoom", `deltaY ${deltaY} should zoom`);
  }
  // Line-mode deltas come from classic wheels too.
  assertEquals(wheelGesture(ev({ deltaY: -3, deltaMode: 1 })).kind, "zoom");
  assert(isMouseWheel(ev({ deltaY: 120 })));
  assert(!isMouseWheel(ev({ deltaY: 8.5 })), "small fractional delta is a trackpad");
  assert(!isMouseWheel(ev({ deltaX: 120, deltaY: 120 })), "horizontal component means trackpad");
});

Deno.test("one mouse notch stays near a ~10% step (delta is clamped)", () => {
  const g = wheelGesture(ev({ deltaY: -120 }));
  if (g.kind !== "zoom") throw new Error("expected zoom");
  assertAlmostEquals(g.factor, Math.exp(MAX_ZOOM_DELTA_PX * ZOOM_SENSITIVITY), 1e-12);
  assert(g.factor > 1.05 && g.factor < 1.15, `one notch should be ~10%, got ${g.factor}`);
});

Deno.test("deltaMode is normalized to pixels", () => {
  assertEquals(wheelDeltaPx(ev({ deltaX: 2, deltaY: 3, deltaMode: 0 })), { dx: 2, dy: 3 });
  assertEquals(wheelDeltaPx(ev({ deltaY: 3, deltaMode: 1 })), { dx: 0, dy: 48 });
  assertEquals(wheelDeltaPx(ev({ deltaY: 1, deltaMode: 2 })), { dx: 0, dy: 800 });
});

// ─── Whole-gesture behavior (the reported bug was accumulation, not one event) ──

const LIMITS = { min: 0.3, max: 2.5 };

/** Replay a burst of wheel events through the same path the canvas uses. */
function replay(events: WheelLike[], start = { tx: 40, ty: 40, scale: 1 }, cursor = { cx: 400, cy: 300 }) {
  return events.reduce((v, e) => applyWheelToView(v, wheelGesture(e), cursor, LIMITS), start);
}

Deno.test("a swipe burst pans and leaves the scale untouched", () => {
  // ~20 events of a two-finger drag down-right, as a trackpad actually reports it.
  const burst = Array.from({ length: 20 }, () => ev({ deltaX: 3, deltaY: 6 }));
  const out = replay(burst);
  assertEquals(out.scale, 1, "swiping must never zoom");
  assertEquals(out.tx, 40 - 60);
  assertEquals(out.ty, 40 - 120);
});

Deno.test("a pinch burst zooms at a controllable rate (no runaway)", () => {
  // A deliberate pinch-out: ~25 small events, which is what one gesture emits.
  const burst = Array.from({ length: 25 }, () => ev({ deltaY: -5, ctrlKey: true }));
  const out = replay(burst);
  assert(out.scale > 1.2, `a full pinch should zoom meaningfully, got ${out.scale}`);
  assert(out.scale < 1.8, `a single pinch must not rocket, got ${out.scale}`);
  // Regression guard: the old fixed ±10% step would have compounded to 1.1^25 ≈ 10.8×
  // (hard-clamped to MAX), which is the runaway Tim reported.
  assert(out.scale < Math.pow(1.1, 25), "must be gentler than the old fixed step");
});

Deno.test("zoom keeps the world point under the cursor anchored", () => {
  const cursor = { cx: 250, cy: 175 };
  const before = { tx: 40, ty: 40, scale: 1 };
  // World point currently under the cursor.
  const wx = (cursor.cx - before.tx) / before.scale, wy = (cursor.cy - before.ty) / before.scale;
  const after = replay(Array.from({ length: 10 }, () => ev({ deltaY: -6, ctrlKey: true })), before, cursor);
  assert(after.scale > before.scale, "should have zoomed in");
  // That same world point must still project to the cursor.
  assertAlmostEquals(after.tx + wx * after.scale, cursor.cx, 1e-9);
  assertAlmostEquals(after.ty + wy * after.scale, cursor.cy, 1e-9);
});

Deno.test("scale stays clamped to MIN_SCALE/MAX_SCALE", () => {
  const inHard = replay(Array.from({ length: 400 }, () => ev({ deltaY: -40, ctrlKey: true })));
  assertEquals(inHard.scale, LIMITS.max);
  const outHard = replay(Array.from({ length: 400 }, () => ev({ deltaY: 40, ctrlKey: true })));
  assertEquals(outHard.scale, LIMITS.min);
  // Anchoring still holds at the clamp (no drift once pinned).
  const again = applyWheelToView(inHard, wheelGesture(ev({ deltaY: -40, ctrlKey: true })), { cx: 400, cy: 300 }, LIMITS);
  assertEquals(again, inHard);
});

Deno.test("mouse-wheel zoom is anchored at the cursor too", () => {
  const cursor = { cx: 120, cy: 90 };
  const before = { tx: 40, ty: 40, scale: 1 };
  const wx = (cursor.cx - before.tx) / before.scale, wy = (cursor.cy - before.ty) / before.scale;
  const after = replay([ev({ deltaY: -120 })], before, cursor);
  assert(after.scale > 1);
  assertAlmostEquals(after.tx + wx * after.scale, cursor.cx, 1e-9);
  assertAlmostEquals(after.ty + wy * after.scale, cursor.cy, 1e-9);
});
