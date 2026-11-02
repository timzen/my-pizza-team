/**
 * TourProvider — the optional guided tour of the desktop UI: a few coach marks,
 * one at a time, each pointing at an area of the shell (docs/DESIGN.md "First
 * run: a checklist, not a tour"; the words and rules are lib/tour.ts).
 *
 *   ┌ nav ─────────────┐ ← the area, outlined, the rest of the page dimmed
 *   └──────────────────┘
 *     ┌ Getting around ──────────────────┐
 *     │ The top bar changes what's in…   │
 *     │ Step 1 of 7   Skip  Back  [Next] │
 *     └──────────────────────────────────┘
 *
 * Mounted once in the desktop shell (App.tsx `DesktopShell`), so every offer —
 * the Welcome card, the Help panel, /help (components/tour/TakeTourButton) —
 * starts the same tour through `useTour().startTour()`. The phone view has no
 * provider and so no tour.
 *
 * - **Where it points.** An area is marked `data-tour="<step>"` where it's
 *   rendered (NavBar, SideDock, RootPage). Each frame the overlay looks for the
 *   steps' areas and keeps those on screen (`visibleTourSteps`), so a step whose
 *   area a feature toggle or a narrow window hides is skipped, and the outline
 *   follows its area as the page moves (a poll adding the Welcome card, a
 *   resize). Starting goes Home first: the Queue and Inbox are a stop.
 * - **Non-modal.** Each step is a Base UI Popover with `modal={false}`, anchored
 *   to the area: nothing traps focus and the page stays usable — a click
 *   elsewhere, or tabbing out, leaves the tour open. The spotlight is an outline
 *   plus a dimming shadow that ignores the pointer and is hidden from assistive
 *   tech; it moves with a short transition that `prefers-reduced-motion` stills
 *   (index.css), and scrolling to the area asks lib/motion.ts.
 * - **Keyboard and screen reader** (docs/ACCESSIBILITY.md): opening moves focus
 *   into the popup — onto Next, so Enter, Enter… walks the tour — a dialog
 *   named by the step's title and described by its text;
 *   every step is announced through the polite live region; the highlighted
 *   area gets the step's text in its `aria-describedby` (lib/tour.ts
 *   `addDescribedBy` — its own descriptions are kept and restored); Back on the
 *   first step is `aria-disabled` rather than disabled, so focus never drops to
 *   the page; Tab out of the popup goes into the highlighted area; Esc ends
 *   the tour, wherever focus is. When it ends from the popup, focus goes back
 *   to what started it (or, if that's gone, the page's heading); ended from
 *   out in the page, focus stays where it is.
 * - **Remembered per browser.** Finishing or skipping stores the time in
 *   localStorage (`TOUR_DONE_KEY`): the Welcome card stops offering it; Help
 *   always does.
 * - **Polling never disturbs it.** The per-frame check only sets state when the
 *   shown steps or the area's box actually changed.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Popover } from "@base-ui/react/popover";
import { Button } from "@/components/ui/button";
import { TourContext, type TourValue } from "@/hooks/useTour";
import { useAnnounce } from "@/hooks/useAnnounce";
import { focusTarget } from "@/hooks/useRouteFocus";
import { scrollBehavior } from "@/lib/motion";
import {
  TOUR_STEPS, addDescribedBy, markTourDone, readTourDone, removeDescribedBy, tourPositionLabel,
  tourStepAnnouncement, tourTargetSelector, visibleTourSteps, type TourStep, type TourStepId,
} from "@/lib/tour";

/** Give up (end the tour) if no step's area has appeared this long after starting. */
const START_TIMEOUT_MS = 2000;
/**
 * Start once the shown steps have held still this long: starting navigates
 * Home, and its Queue and Inbox tabs render a moment after the nav does — the
 * first step shouldn't say "1 of 6" and then "2 of 7".
 */
const SETTLE_MS = 250;
/** Room between the area and its outline. */
const SPOTLIGHT_PAD = 4;

/** Which side of its area each step's popup prefers (Base UI flips it when there's no room). */
const STEP_SIDE: Partial<Record<TourStepId, "bottom" | "right" | "top" | "left">> = { dock: "right" };

/** What Tab can land on, inside an area. */
const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The first thing Tab can reach in `area` (the area itself, if it's a control), or null. */
function firstTabbable(area: HTMLElement): HTMLElement | null {
  if (area.matches(TABBABLE)) return area;
  return [...area.querySelectorAll<HTMLElement>(TABBABLE)].find((el) => el.getClientRects().length > 0) ?? null;
}

/** The area for `id`, if it's in the page and laid out (not display:none, not in a hidden subtree). */
function findTarget(id: TourStepId): HTMLElement | null {
  const el = document.querySelector<HTMLElement>(tourTargetSelector(id));
  if (!el || el.getClientRects().length === 0 || el.closest("[hidden],[inert]")) return null;
  return el;
}

/** Provide `useTour()` to the desktop shell and draw the tour while it runs. */
export function TourProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState(false);
  // A new key per start, so a restarted tour begins again at its first step.
  const [run, setRun] = useState(0);
  const [doneAt, setDoneAt] = useState(() => readTourDone(globalThis.localStorage));
  const returnFocus = useRef<HTMLElement | null>(null);
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const startTour = useCallback(() => {
    const focused = document.activeElement;
    returnFocus.current = focused instanceof HTMLElement && focused !== document.body ? focused : null;
    // The Queue and Inbox are a stop, and they're on Home.
    if (pathname !== "/" && pathname !== "/queue") navigate("/");
    setRun((r) => r + 1);
    setActive(true);
  }, [pathname, navigate]);

  const endTour = useCallback(() => {
    // Hand focus back only if the tour had it: Esc pressed out in the page leaves it there.
    const focused = document.activeElement;
    const tourHadFocus = !focused || focused === document.body || !!focused.closest("[data-tour-popup]");
    setActive(false);
    setDoneAt(markTourDone(globalThis.localStorage, new Date()));
    // After the popup has gone: back to what started it, else the page's heading.
    requestAnimationFrame(() => {
      if (!tourHadFocus) { returnFocus.current = null; return; }
      const back = returnFocus.current;
      returnFocus.current = null;
      if (back?.isConnected && back.getClientRects().length > 0) { back.focus(); return; }
      const h1 = document.querySelector<HTMLElement>("main h1");
      if (h1) focusTarget(h1);
    });
  }, []);

  const value = useMemo<TourValue>(() => ({ active, doneAt, startTour }), [active, doneAt, startTour]);
  return (
    <TourContext value={value}>
      {children}
      {active && <TourOverlay key={run} onEnd={endTour} />}
    </TourContext>
  );
}

/** A box on screen, in viewport pixels. */
interface Box { top: number; left: number; width: number; height: number }

const sameBox = (a: Box | null, b: Box | null) =>
  a === b || (!!a && !!b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height);

/** What the per-frame check found: the steps on screen, and the current one's area. */
interface Scene {
  steps: TourStep[];
  target: HTMLElement | null;
  box: Box | null;
}

/** The tour itself: the spotlight, and the current step's popover. */
function TourOverlay({ onEnd }: { onEnd: () => void }) {
  const announce = useAnnounce();
  const [currentId, setCurrentIdState] = useState<TourStepId | null>(null);
  // The per-frame check reads the current step without restarting on every change.
  const currentIdRef = useRef<TourStepId | null>(null);
  const setCurrentId = useCallback((id: TourStepId) => { currentIdRef.current = id; setCurrentIdState(id); }, []);
  const [scene, setScene] = useState<Scene>({ steps: [], target: null, box: null });
  const titleId = useId();
  const textId = useId();
  const nextRef = useRef<HTMLButtonElement>(null);

  // Each frame: which steps have an area on screen, and where the current one is.
  // State changes only when something did, so an idle tour doesn't re-render.
  useEffect(() => {
    let frame = 0;
    const startedAt = performance.now();
    let lastIds = "";
    let stableSince = startedAt;
    const tick = () => {
      const steps = visibleTourSteps(TOUR_STEPS, (id) => findTarget(id) !== null);
      const ids = steps.map((s) => s.id).join(" ");
      if (ids !== lastIds) { lastIds = ids; stableSince = performance.now(); }
      setScene((prev) => {
        // The current step, or — if its area went away — the next one on screen.
        const id = currentIdRef.current;
        const step = steps.find((s) => s.id === id) ?? null;
        const target = step ? findTarget(step.id) : null;
        const r = target?.getBoundingClientRect();
        const box = r ? { top: r.top, left: r.left, width: r.width, height: r.height } : null;
        const sameSteps = prev.steps.length === steps.length && prev.steps.every((s, i) => s.id === steps[i]?.id);
        if (sameSteps && prev.target === target && sameBox(prev.box, box)) return prev;
        return { steps: sameSteps ? prev.steps : steps, target, box };
      });
      if (!currentIdRef.current) {
        if (steps[0] && performance.now() - stableSince >= SETTLE_MS) setCurrentId(steps[0].id);
        else if (!steps[0] && performance.now() - startedAt > START_TIMEOUT_MS) { onEnd(); return; }
      } else if (!steps.some((s) => s.id === currentIdRef.current)) {
        // The current area disappeared (a navigation, a toggle): go on to the next one there is.
        const order = TOUR_STEPS.map((s) => s.id);
        const from = order.indexOf(currentIdRef.current);
        const next = steps.find((s) => order.indexOf(s.id) > from);
        if (next) setCurrentId(next.id);
        else { onEnd(); return; }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [onEnd, setCurrentId]);

  const index = scene.steps.findIndex((s) => s.id === currentId);
  const step = index >= 0 ? scene.steps[index]! : null;
  const total = scene.steps.length;
  const isLast = index === total - 1;
  const target = step && scene.target ? scene.target : null;

  // A new step: say it, and bring its area into view.
  useEffect(() => {
    if (!step) return;
    announce(tourStepAnnouncement(step, index, total));
    findTarget(step.id)?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: scrollBehavior() });
    // Only when the step changes — not when the count of steps does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step?.id]);

  // The highlighted area is described by the step's text while it's highlighted.
  useEffect(() => {
    if (!target) return;
    target.setAttribute("aria-describedby", addDescribedBy(target.getAttribute("aria-describedby"), textId));
    return () => {
      const rest = removeDescribedBy(target.getAttribute("aria-describedby"), textId);
      if (rest) target.setAttribute("aria-describedby", rest);
      else target.removeAttribute("aria-describedby");
    };
  }, [target, textId]);

  const go = (delta: number) => {
    const next = scene.steps[index + delta];
    if (next) setCurrentId(next.id);
  };
  // Tab past the popup's last button (or Shift+Tab before its first) goes into
  // the highlighted area, not to the end of the document where the popup is
  // portalled: focus is free to leave, and lands somewhere that makes sense.
  const onPopupKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab" || !target) return;
    const buttons = [...e.currentTarget.querySelectorAll<HTMLElement>(TABBABLE)];
    const edge = e.shiftKey ? buttons[0] : buttons[buttons.length - 1];
    const into = firstTabbable(target);
    if (document.activeElement !== edge || !into) return;
    e.preventDefault();
    into.focus();
  };
  const onBack = () => {
    if (index <= 0) return;
    go(-1);
    // Back is now aria-disabled on the first step; Next is where to be.
    if (index === 1) nextRef.current?.focus();
  };

  return (
    <>
      {scene.box && (
        <div
          aria-hidden
          data-tour-spotlight=""
          className="pointer-events-none fixed z-40 rounded-lg ring-2 ring-primary ring-offset-2 ring-offset-background shadow-[0_0_0_9999px_rgb(0_0_0/0.35)] transition-[top,left,width,height] duration-200 ease-out motion-reduce:transition-none"
          style={{
            top: scene.box.top - SPOTLIGHT_PAD,
            left: scene.box.left - SPOTLIGHT_PAD,
            width: scene.box.width + SPOTLIGHT_PAD * 2,
            height: scene.box.height + SPOTLIGHT_PAD * 2,
          }}
        />
      )}
      {step && target && (
        <Popover.Root
          open
          modal={false}
          onOpenChange={(open, details) => {
            // Only Esc ends it: a click elsewhere or focus moving out leaves it up (non-modal).
            if (!open && details.reason === "escape-key") onEnd();
          }}
        >
          <Popover.Portal>
            <Popover.Positioner
              anchor={target}
              side={STEP_SIDE[step.id] ?? "bottom"}
              align="start"
              sideOffset={12}
              collisionPadding={8}
              className="isolate z-50"
            >
              <Popover.Popup
                data-tour-popup={step.id}
                initialFocus={nextRef}
                finalFocus={false}
                aria-labelledby={titleId}
                aria-describedby={textId}
                onKeyDown={onPopupKeyDown}
                className="flex max-h-(--available-height) w-[min(22rem,calc(100vw-1rem))] flex-col gap-2 overflow-y-auto rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Popover.Title id={titleId} className="text-base font-semibold">{step.title}</Popover.Title>
                <Popover.Description id={textId} className="text-sm text-muted-foreground">{step.text}</Popover.Description>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <span className="mr-auto text-xs text-muted-foreground">{tourPositionLabel(index, total)}</span>
                  {!isLast && <Button variant="ghost" size="sm" onClick={onEnd}>Skip tour</Button>}
                  <Button variant="outline" size="sm" aria-disabled={index === 0 || undefined} className="aria-disabled:opacity-50" onClick={onBack}>
                    Back
                  </Button>
                  <Button ref={nextRef} size="sm" onClick={() => (isLast ? onEnd() : go(1))}>
                    {isLast ? "Done" : "Next"}
                  </Button>
                </div>
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      )}
    </>
  );
}
