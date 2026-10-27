/**
 * DisconnectSourceDialog — "Turn off <source> and archive its N items?": the
 * confirm for switching off an external Work Source that still holds mirrored
 * items (docs/DESIGN.md "Feature Toggles" — disconnect). Confirming calls
 * `POST /api/work-sources/:id/disconnect`, which archives (never deletes) the
 * mirrors, cancels their queued runs, lets in-progress work finish, and
 * switches the source off — at once, not on a Save.
 *
 * The one copy of this control: the Config page's Sources tab
 * (components/sources/SourcesTab.tsx) is where external sources are switched.
 */

import { useState } from "react";
import { apiPost } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** The source being disconnected, or null when the dialog is closed. */
export interface DisconnectTarget {
  sourceId: string;
  feature: string;
  label: string;
  /** What gets archived ("3 items"). */
  description: string;
}

export function DisconnectSourceDialog({ target, onClose, onDisconnected }: {
  target: DisconnectTarget | null;
  onClose: () => void;
  /** It's off and archived (the daemon saved the toggle). */
  onDisconnected: (target: DisconnectTarget) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const disconnect = async () => {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost<{ success: boolean; error?: string }>(`/api/work-sources/${encodeURIComponent(target.sourceId)}/disconnect`, {});
      if (res.success) onDisconnected(target);
      else setError(res.error || "Disconnect failed");
    } catch (e) {
      setError("Network error: " + (e as Error).message);
    }
    setBusy(false);
  };

  const close = () => { if (!busy) { setError(null); onClose(); } };

  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Turn off {target?.label}?</DialogTitle>
          <DialogDescription>
            This stops syncing {target?.label} and archives {target?.description} mirrored from it — nothing
            is deleted, and their threads stay. Queued runs are canceled; anything a teammate is working on now
            finishes. Turn it back on later and sync brings the items back. Applies immediately.
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={busy}>Cancel</Button>
          <Button variant="destructive" onClick={disconnect} disabled={busy}>
            {busy ? "Turning off..." : `Turn off and archive ${target?.description ?? ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
