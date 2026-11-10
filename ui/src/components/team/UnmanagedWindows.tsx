/**
 * UnmanagedWindows — The Team tab's "Unmanaged windows" section: windows in the
 * team's terminal container (tmux session / herdr workspace) that aren't a
 * registered teammate, the leader, or a spawn still starting up — a tab a
 * terminal's own session restore relaunched, say, or one the user opened.
 *
 * Shown only when there are any. Each row says whether an agent appears to be
 * running in it and has a **Close** button (asks first: closing a window ends
 * whatever runs in it). Nothing closes them automatically — the user may have
 * opened that tab on purpose (docs/DESIGN.md "Unmanaged Windows Are Shown, Never
 * Reaped"). Backed by the pool's `unmanagedWindows` (GET /api/teammate-pool) and
 * POST /api/unmanaged-windows/close.
 */

import { useId, useState } from "react";
import { SquareTerminal } from "lucide-react";
import type { UnmanagedWindow } from "@shared/types";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useAnnounce } from "@/hooks/useAnnounce";

/** What runs in the window, in words: an agent-looking process, an idle shell, or unknown. */
function windowActivityLabel(w: Pick<UnmanagedWindow, "running" | "command">): string {
  if (w.running === true) return w.command ? `Running: ${w.command}` : "A process is running";
  if (w.running === false) return "Idle shell (no agent running)";
  return "Not known what's running";
}

export function UnmanagedWindows({
  windows,
  onClose,
}: {
  windows: UnmanagedWindow[];
  /** Close one; resolves to the error, or null when it closed. */
  onClose: (window: string) => Promise<string | null>;
}) {
  const [confirmDialog, confirm] = useConfirm();
  const announce = useAnnounce();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const headingId = useId();

  if (windows.length === 0) return null;

  const close = async (w: UnmanagedWindow) => {
    const ok = await confirm({
      title: `Close window "${w.window}"?`,
      description: "This ends whatever is running in it. It isn't a registered teammate, so MPT won't replace it.",
      confirmLabel: "Close window",
      destructive: true,
    });
    if (!ok) return;
    setBusy(w.window);
    setError(null);
    try {
      const err = await onClose(w.window);
      if (err) {
        setError(err);
        announce(err, "assertive");
      } else {
        announce(`Closed window ${w.window}`);
      }
    } catch {
      const msg = `Couldn't close window ${w.window}`;
      setError(msg);
      announce(msg, "assertive");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="pb-1" aria-labelledby={headingId}>
      {confirmDialog}
      {/* A label like the panel's other section titles ("Pending spawns"), not a heading: the dock has none. */}
      <p id={headingId} className="px-1 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Unmanaged windows ({windows.length})
      </p>
      <p className="px-1 pb-1.5 text-[11px] text-muted-foreground">
        In the team's terminal but not registered teammates. They count toward the agents running on this machine,
        not toward MPT's teammates. MPT never closes them on its own.
      </p>
      {error && <p role="alert" className="px-1 pb-1.5 text-[11px] text-destructive">{error}</p>}
      <ul className="space-y-1.5">
        {windows.map((w) => (
          <li key={`${w.session}:${w.window}`} className="rounded-md border border-dashed border-border p-2.5">
            <div className="flex items-center gap-2">
              <SquareTerminal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="flex-1 truncate font-mono text-sm" title={`${w.session}:${w.window} (${w.terminal})`}>{w.window}</span>
              <Button
                size="xs"
                variant="outline"
                onClick={() => void close(w)}
                disabled={busy === w.window}
                aria-label={`Close window ${w.window}`}
              >
                {busy === w.window ? "Closing…" : "Close"}
              </Button>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {windowActivityLabel(w)} · not a registered teammate
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
