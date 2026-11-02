/**
 * confirm-dialog.tsx — The app's "are you sure?": an accessible replacement for
 * `window.confirm()` (docs/ACCESSIBILITY.md "Focus is always visible and never
 * lost").
 *
 * The browser's confirm is unstyled, blocks the page, can't say which button
 * is the dangerous one, and some browsers let a user suppress it for the page.
 * This is a Base UI AlertDialog: `role="alertdialog"`, named by its title and
 * described by its text, focus trapped inside and starting on **Cancel** (the
 * safe choice — Enter on a stray keypress never deletes), Esc cancels, and on
 * close focus goes back to whatever had it before — the button that asked —
 * or, when that's gone (the row was deleted), Base UI's default.
 *
 * It's a hook that returns the dialog element and an async `confirm`, not a
 * global provider, so the dialog renders where it's used — inside another
 * dialog (the big editor's Discard) it nests, and focus stays trapped in the
 * right one:
 *
 * ```tsx
 * const [confirmDialog, confirm] = useConfirm();
 * const remove = async () => {
 *   if (!(await confirm({ title: "Delete this note?", description: "This can't be undone.", confirmLabel: "Delete", destructive: true }))) return;
 *   …
 * };
 * return <>{confirmDialog}…</>;
 * ```
 */

import { useCallback, useRef, useState, type ReactNode } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Button } from "@/components/ui/button";

/** What a confirm asks. A bare string is the title. */
export interface ConfirmOptions {
  /** The question, e.g. "Delete task "x"?" — the dialog's name. */
  title: string;
  /** What happens if you go ahead, when the title doesn't say it. */
  description?: ReactNode;
  /** The go-ahead button's label (default "OK"); name the action: "Delete", "Archive". */
  confirmLabel?: string;
  /** The back-out button's label (default "Cancel"). */
  cancelLabel?: string;
  /** Style the go-ahead button as destructive (it deletes or discards something). */
  destructive?: boolean;
}

/** Ask, and resolve true for the go-ahead, false for Cancel / Esc / a click outside. */
export type Confirm = (options: ConfirmOptions | string) => Promise<boolean>;

interface Pending {
  options: ConfirmOptions;
  resolve: (ok: boolean) => void;
}

/** The confirm dialog (render it) and the function that opens it. See the file comment. */
export function useConfirm(): [ReactNode, Confirm] {
  const [pending, setPending] = useState<Pending | null>(null);
  const [open, setOpen] = useState(false);
  // Who had focus when we asked: focus goes back there on close.
  const returnTo = useRef<HTMLElement | null>(null);

  const confirm = useCallback<Confirm>((options) => new Promise<boolean>((resolve) => {
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPending((prev) => {
      prev?.resolve(false); // a second ask replaces the first, which counts as a "no"
      return { options: typeof options === "string" ? { title: options } : options, resolve };
    });
    setOpen(true);
  }), []);

  // A promise settles once, so a late second call (Esc after the button) is harmless.
  // `pending` stays set while closing, so the text doesn't vanish mid-animation.
  const settle = (ok: boolean) => {
    pending?.resolve(ok);
    setOpen(false);
  };

  const o = pending?.options;
  const dialog = (
    <AlertDialog.Root open={open} onOpenChange={(next) => { if (!next) settle(false); }}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-[70] bg-black/20 duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <AlertDialog.Popup
          finalFocus={() => (returnTo.current?.isConnected ? returnTo.current : true)}
          className="fixed top-1/2 left-1/2 z-[70] grid w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 gap-3 rounded-xl bg-popover p-4 text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/10 duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
        >
          <AlertDialog.Title className="text-base font-medium leading-snug">{o?.title}</AlertDialog.Title>
          {o?.description && (
            <AlertDialog.Description className="text-sm text-muted-foreground">{o.description}</AlertDialog.Description>
          )}
          <div className="mt-1 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            {/* First in the DOM, so it takes the initial focus: the safe choice. */}
            <AlertDialog.Close render={<Button variant="outline" />}>{o?.cancelLabel ?? "Cancel"}</AlertDialog.Close>
            <Button variant={o?.destructive ? "destructive" : "default"} onClick={() => settle(true)}>
              {o?.confirmLabel ?? "OK"}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
  return [dialog, confirm];
}
