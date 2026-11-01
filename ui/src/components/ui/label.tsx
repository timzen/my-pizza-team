/**
 * label.tsx — the shadcn Label primitive: a styled <label>. Callers associate it
 * with its control (htmlFor, or by wrapping it).
 */
import * as React from "react"

import { cn } from "@/lib/utils"

function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    // eslint-disable-next-line jsx-a11y/label-has-associated-control -- a primitive: the caller passes htmlFor or the wrapped control.
    <label
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Label }
