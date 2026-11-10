/**
 * The assistant's unsent message — one draft shared by its two composers.
 *
 * Docked, the assistant is the bubble chat (`Composer`); at Full page it is the
 * terminal (`PairComposer`; lib/assistant-mode.ts `assistantView`). Switching
 * size unmounts one composer and mounts the other, so a draft kept in either
 * one's state would be lost. It lives here instead: a module-level store both
 * read and write (via hooks/useAssistantDraft), so text typed in one shows up
 * in the other, and sending from either clears it. The assistant only — a
 * teammate's watch-page composer keeps its own local draft.
 *
 * The draft is text only: neither composer takes attachments. A quoted bubble
 * (the chat's "reply to") stays the chat's own, since the terminal can't quote.
 *
 * Pure (no React, no DOM) so tests/assistant-draft-ui.test.ts can drive it.
 */

/** A draft and a way to watch it — the shape `useSyncExternalStore` wants. */
export interface DraftStore {
  /** The current unsent text. */
  get(): string;
  /** Replace the text (typing, or "" after a send / Clear). */
  set(value: string): void;
  /** Call `listener` on every change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

/** A fresh, empty draft store (the app uses the one `assistantDraft`; tests make their own). */
export function createDraftStore(): DraftStore {
  let value = "";
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      // Only notify on a real change, so an idle re-render doesn't ripple.
      if (next === value) return;
      value = next;
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

/** The assistant's draft, shared by the chat and terminal composers. */
export const assistantDraft: DraftStore = createDraftStore();

/**
 * Put the cursor after the last character of a text box — for a composer that
 * mounts holding a carried-over draft, so typing continues where it left off.
 */
export function placeCursorAtEnd(el: { value: string; setSelectionRange(start: number, end: number): void }): void {
  const end = el.value.length;
  el.setSelectionRange(end, end);
}
