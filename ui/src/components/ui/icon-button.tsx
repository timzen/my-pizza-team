/**
 * icon-button.tsx — Icon-only controls that can't be written without a name.
 *
 * An icon tells a sighted mouse user what a control does at best; it tells a
 * screen reader nothing. `IconButton` and `IconLink` require a `label`, which
 * becomes both the control's `aria-label` and its Tooltip (hover and keyboard
 * focus — components/ui/tooltip.tsx). A longer `hint` may replace the tooltip
 * text; then the label stays the name and the hint is announced as the
 * description. Their icon children are decorative (lucide renders
 * `aria-hidden` by default).
 *
 * The lint (ui/eslint.config.js) rejects `<Button size="icon…">` outside these
 * helpers, so an unlabelled icon button fails the gates
 * (docs/ACCESSIBILITY.md "Rules for new UI code").
 */

import * as React from "react"
import { Link, type LinkProps } from "react-router-dom"

import { Button } from "@/components/ui/button"
import { Tooltip } from "@/components/ui/tooltip"

type TooltipPlacement = { side?: "top" | "bottom" | "left" | "right" }

type IconButtonProps = Omit<React.ComponentProps<typeof Button>, "aria-label" | "title"> &
  TooltipPlacement & {
    /** What the control does, in a few words: its accessible name and (without `hint`) its tooltip. */
    label: string
    /** A longer tooltip, announced as the description; the `label` stays the name. */
    hint?: React.ReactNode
  }

/**
 * A `Button` that shows only an icon (default: ghost, `size="icon"`), named by
 * `label` and hinted by a Tooltip. Use this for every icon-only Button.
 */
function IconButton({ label, hint, side, variant = "ghost", size = "icon", ...props }: IconButtonProps) {
  return (
    <Tooltip content={hint ?? label} describe={hint !== undefined && hint !== label} side={side}>
      <Button variant={variant} size={size} {...props} aria-label={label} />
    </Tooltip>
  )
}

type IconLinkProps = Omit<LinkProps, "aria-label" | "title"> &
  TooltipPlacement & {
    /** Where the link goes, in a few words: its accessible name and (without `hint`) its tooltip. */
    label: string
    /** A longer tooltip, announced as the description; the `label` stays the name. */
    hint?: React.ReactNode
  }

/**
 * A router `Link` that shows only an icon, named by `label` and hinted by a
 * Tooltip. Style it with `className` as you would the Link.
 */
function IconLink({ label, hint, side, ...props }: IconLinkProps) {
  return (
    <Tooltip content={hint ?? label} describe={hint !== undefined && hint !== label} side={side}>
      <Link {...props} aria-label={label} />
    </Tooltip>
  )
}

export { IconButton, IconLink }
