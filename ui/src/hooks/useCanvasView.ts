/**
 * useCanvasView — The Thoughts canvas's viewport: the pan/zoom transform, the
 * viewport element and its tracked size, world ⇄ screen conversion, native
 * wheel handling (swipe pans, pinch zooms at the cursor), and button zoom
 * around the viewport's center.
 *
 * Split out of ThoughtsPage so the page keeps the notes, groups, and gestures
 * while the camera lives here. The transform math is pure in lib/wheelGesture
 * and lib/thoughtLayout (`zoomAround`).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { applyWheelToView, wheelGesture } from "@/lib/wheelGesture";
import { zoomAround, type CanvasView } from "@/lib/thoughtLayout";

const MIN_SCALE = 0.3;
const MAX_SCALE = 2.5;
/** The view the canvas opens at, and Reset view / ⌘0 return to. */
const HOME_VIEW: CanvasView = { tx: 40, ty: 40, scale: 1 };

/** What the canvas needs from its viewport. */
export interface CanvasViewState {
  view: CanvasView;
  setView: Dispatch<SetStateAction<CanvasView>>;
  /** Attach to the canvas viewport element. */
  viewportRef: RefObject<HTMLDivElement | null>;
  /** The viewport's size (px), as state so render code can use it. */
  vpSize: { w: number; h: number };
  /** A screen-space drag delta in world units. */
  screenToWorldDelta: (dx: number, dy: number) => { dx: number; dy: number };
  /** Absolute world coords under a screen (client) point. */
  screenToWorld: (clientX: number, clientY: number) => { wx: number; wy: number };
  /** Zoom by a factor around the viewport's center (stable identity). */
  zoomBy: (factor: number) => void;
  /** Back to the opening view. */
  resetView: () => void;
}

/**
 * The canvas camera. `mode` is the page's current view: the viewport element
 * only exists on the canvas, so the resize observer and the wheel listener
 * rebind whenever it changes (the canvas remounts after the list view).
 */
export function useCanvasView(mode: string): CanvasViewState {
  const [view, setView] = useState<CanvasView>(HOME_VIEW);
  const viewportRef = useRef<HTMLDivElement>(null);
  // The viewport's size, as state: render code (the minimap's viewport box)
  // must not read the ref during render, and a ResizeObserver also keeps it
  // right when the window or docks resize without the view changing.
  const [vpSize, setVpSize] = useState({ w: 800, h: 600 });
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setVpSize({ w: entry.contentRect.width, h: entry.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [mode]); // the canvas viewport only exists in canvas mode

  // ─── World ⇄ screen ────────────────────────────────────────────────
  const screenToWorldDelta = useCallback((dx: number, dy: number) => ({ dx: dx / view.scale, dy: dy / view.scale }), [view.scale]);
  // Absolute world coords under a screen point (for marquee hit-testing).
  const screenToWorld = useCallback((clientX: number, clientY: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const ox = rect ? clientX - rect.left : clientX;
    const oy = rect ? clientY - rect.top : clientY;
    return { wx: (ox - view.tx) / view.scale, wy: (oy - view.ty) / view.scale };
  }, [view]);

  // ─── Wheel: swipe pans, pinch zooms (anchored at cursor) ───────────
  // Bound natively rather than via React's `onWheel` because React registers
  // wheel listeners as passive, where preventDefault() is a no-op — without it
  // a trackpad pinch zooms the whole browser page instead of the canvas.
  // Gesture classification and the transform math live in lib/wheelGesture
  // (pure, unit-tested in tests/wheel-gesture.test.ts).
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const g = wheelGesture(e);
      const rect = el.getBoundingClientRect();
      const cursor = { cx: e.clientX - rect.left, cy: e.clientY - rect.top };
      setView((v) => applyWheelToView(v, g, cursor, { min: MIN_SCALE, max: MAX_SCALE }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [mode]); // rebind when the canvas remounts after the list view

  // Button zoom: anchor on the viewport center so the view stays put.
  // useCallback so the page's keydown effect doesn't re-subscribe on every render.
  const zoomBy = useCallback((factor: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const cx = rect ? rect.width / 2 : 0, cy = rect ? rect.height / 2 : 0;
    setView((v) => zoomAround(v, factor, cx, cy, { min: MIN_SCALE, max: MAX_SCALE }));
  }, []);

  const resetView = useCallback(() => setView({ ...HOME_VIEW }), []);

  return { view, setView, viewportRef, vpSize, screenToWorldDelta, screenToWorld, zoomBy, resetView };
}
