/**
 * form-error.tsx — A form's error line, announced (docs/ACCESSIBILITY.md "Live
 * announcements"): the red text sighted users see, plus the same text spoken
 * at once through the app-wide announcer's assertive region — an error is the
 * one thing worth interrupting for.
 *
 * Give it an `id` and point the field it's about at it, so the field says why
 * it's wrong when focused:
 *
 * ```tsx
 * <Input aria-invalid={!!error || undefined} aria-describedby={error ? "title-error" : undefined} … />
 * <FormError id="title-error">{error}</FormError>
 * ```
 *
 * Renders nothing while there's no error. Spoken when the message appears or
 * changes — not on every render, and not again for a poll that re-renders the
 * form (docs/DESIGN.md "Polling Never Disturbs the Reader").
 */

import { useEffect } from "react";
import { useAnnounce } from "@/hooks/useAnnounce";
import { cn } from "@/lib/utils";

interface FormErrorProps {
  /** The error, or nothing (renders nothing). */
  children: string | null | undefined;
  /** For the field's `aria-describedby`. */
  id?: string;
  /** Size and spacing (default `text-sm`); the color is always the destructive text. */
  className?: string;
}

export function FormError({ children, id, className }: FormErrorProps) {
  const announce = useAnnounce();
  const message = children?.trim() || "";
  useEffect(() => {
    if (message) announce(message, "assertive");
  }, [message, announce]);
  if (!message) return null;
  return <p id={id} className={cn("text-sm text-destructive", className)}>{message}</p>;
}
