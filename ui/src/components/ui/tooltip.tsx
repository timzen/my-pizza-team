/**
 * tooltip.tsx — The UI's one hint component, on Base UI's Tooltip.
 *
 * A hint opens on pointer hover **and** on keyboard focus, closes with Esc (and
 * stays open while the pointer is over it — WCAG 1.4.13), and is wired to its
 * trigger with `aria-describedby` so a screen reader announces it too. It
 * replaces `title=`, which is mouse-only, never shows on focus, and is read
 * inconsistently (docs/ACCESSIBILITY.md "Rules for new UI code").
 *
 * - `<TooltipProvider>` (mounted once, in main.tsx) shares the open delay, so
 *   moving from one hinted control to the next opens the next instantly.
 * - `<Tooltip content={…}>` wraps exactly one element: the trigger. The trigger
 *   should be focusable (a button, a link, an input); on a non-interactive
 *   element pass `focusable` so a keyboard can reach the hint — sparingly, as
 *   each one is a tab stop.
 * - `describe={false}` when the hint only repeats the trigger's accessible name
 *   (an icon button whose `aria-label` is its tooltip): announcing it twice is
 *   noise. `IconButton` / `IconLink` (icon-button.tsx) set it for you.
 *
 * The description is a hidden copy of the hint, portalled to `<body>`, rather
 * than the popup itself: the popup only exists while open, and a
 * `aria-describedby` pointing at nothing describes nothing.
 */

import * as React from "react"
import { createPortal } from "react-dom"
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"

import { cn } from "@/lib/utils"

/** Wait this long (ms) on hover before a hint opens; focus waits the same. */
const OPEN_DELAY_MS = 400

/**
 * Share one open delay across the app's tooltips (mount once, at the root), so
 * sweeping across a row of icon buttons doesn't wait on each one.
 */
function TooltipProvider({ children, delay = OPEN_DELAY_MS }: { children: React.ReactNode; delay?: number }) {
  return (
    <TooltipPrimitive.Provider delay={delay} closeDelay={0}>
      {children}
    </TooltipPrimitive.Provider>
  )
}

type TooltipProps = {
  /** The hint. Empty (null, undefined, "" or false) renders the trigger alone. */
  content: React.ReactNode
  /** The trigger: one element that accepts a ref and props (a Button, a Link, a span…). */
  children: React.ReactElement
  side?: "top" | "bottom" | "left" | "right"
  align?: "start" | "center" | "end"
  /** Announce the hint as the trigger's description (default). Off when it repeats the name. */
  describe?: boolean
  /** Make a non-interactive trigger focusable (tabIndex 0) so the hint opens from the keyboard. */
  focusable?: boolean
  className?: string
}

/**
 * Show `content` beside `children` on hover and focus; Esc closes it. See the
 * file comment for when to pass `describe={false}` or `focusable`.
 */
function Tooltip({ content, children, side = "top", align = "center", describe = true, focusable = false, className }: TooltipProps) {
  const id = React.useId()
  if (content === null || content === undefined || content === "" || content === false) return children
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger
        render={children}
        aria-describedby={describe ? id : undefined}
        tabIndex={focusable ? 0 : undefined}
      />
      {describe && typeof document !== "undefined" &&
        createPortal(<span id={id} hidden>{content}</span>, document.body)}
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side={side} align={align} sideOffset={6} className="isolate z-50">
          <TooltipPrimitive.Popup
            data-slot="tooltip"
            className={cn(
              "max-w-xs rounded-md bg-foreground px-2 py-1 text-xs leading-snug text-background shadow-md break-words",
              "origin-(--transform-origin) transition-opacity duration-100 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none",
              className
            )}
          >
            {content}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}

export { Tooltip, TooltipProvider }
