/**
 * CopyId — A click-to-copy id chip (monospace) for a Thoughts note or group.
 * Copying lets you paste an id into the assistant chat to reference it
 * precisely. Stops pointer-down so it never starts a canvas drag.
 */

import { useState } from "react";
import { Check, Hash } from "lucide-react";

export function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      title={`Copy id: ${id}`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(id).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {});
      }}
      className="inline-flex items-center gap-0.5 rounded bg-background/70 px-1 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-background hover:text-foreground"
    >
      {copied ? <Check className="h-2.5 w-2.5" /> : <Hash className="h-2.5 w-2.5" />}
      {copied ? "copied" : id}
    </button>
  );
}
