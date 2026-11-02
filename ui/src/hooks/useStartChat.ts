/**
 * useStartChat — "Ask the assistant": bring up the chat with the cursor in its
 * message box, from anywhere in either shell. The action an empty screen offers
 * when the natural next step is to describe the work in words
 * (components/ui/empty-state; docs/DESIGN.md "An Empty Screen Teaches").
 *
 *  - **Desktop** — the side dock opens on its Assistant tab (SideDockProvider
 *    `focusChat`); the center page stays where it is.
 *  - **Phone** (`/m`, no dock) — it switches to the Chat tab, marking the
 *    navigation keep-focus so the route-focus hook doesn't pull focus back to
 *    the tab's heading (lib/route-focus.ts), then focuses the box.
 *
 * The chat's body is found by its `data-chat-pane` mark (components/assistant/
 * AssistantPane), the visible one — the phone keeps every tab mounted, the dock
 * keeps hidden tabs mounted — and its first enabled text box gets focus: the
 * chat's composer, or the terminal view's. With no box (reading an ended
 * session) the pane itself is focused, so focus still lands in the chat.
 */

import { useCallback, useContext } from "react";
import { useNavigate } from "react-router-dom";
import { SideDockContext } from "@/hooks/useSideDock";
import { focusTarget } from "@/hooks/useRouteFocus";
import { MOBILE_TAB_PATHS } from "@/lib/mobile";
import { keepFocusState } from "@/lib/route-focus";

/** The attribute that marks the assistant's chat body (either view). */
export const CHAT_PANE_ATTR = "data-chat-pane";

/** How many animation frames to wait for the chat to render (a dock opening, a tab switching). */
const MAX_FRAMES = 20;

/**
 * Focus the visible chat's message box once it's on screen: tried each frame
 * for a few frames, since the dock or tab showing it renders after the click.
 */
export function focusChatComposer(): void {
  const attempt = (framesLeft: number) => {
    const pane = Array.from(document.querySelectorAll<HTMLElement>(`[${CHAT_PANE_ATTR}]`))
      .find((el) => el.getClientRects().length > 0);
    const box = pane?.querySelector<HTMLElement>("textarea:not([disabled])");
    if (box) { box.focus(); return; }
    if (framesLeft > 0) { requestAnimationFrame(() => attempt(framesLeft - 1)); return; }
    if (pane) focusTarget(pane);
  };
  requestAnimationFrame(() => attempt(MAX_FRAMES));
}

/** A callback that opens the chat (dock tab or phone tab) and focuses its message box. */
export function useStartChat(): () => void {
  const dock = useContext(SideDockContext);
  const navigate = useNavigate();
  return useCallback(() => {
    if (dock) { dock.focusChat(); return; }
    navigate(MOBILE_TAB_PATHS.chat, { state: keepFocusState() });
    focusChatComposer();
  }, [dock, navigate]);
}
