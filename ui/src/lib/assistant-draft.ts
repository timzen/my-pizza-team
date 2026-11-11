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
 * Also here: the pair composer's draft-or-local choice (`composerSource`) and
 * its React key (`pairComposerKey`), so each composer has one source of text.
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

/** A draft held outside a composer, `[text, setText]` (the assistant's shared one). */
export type ComposerDraft = [string, (value: string) => void];

/**
 * Which `[text, setText]` a `PairComposer` uses: the `draft` it was handed,
 * else its own `local` state. The choice is of the whole pair — never of the
 * text — so an emptied draft ("") stays the draft, and `local` (possibly stale)
 * can't show through.
 */
export function composerSource(draft: ComposerDraft | undefined, local: ComposerDraft): ComposerDraft {
  return draft ?? local;
}

/**
 * The React `key` for a `PairComposer`, so each mounted composer has exactly
 * one source for its text for its whole life.
 *
 * Its text is either the assistant's shared draft (`shared`) or its own local
 * state. A composer instance must never switch between the two, nor be reused
 * for another agent: React keeps a component's state when only its props
 * change, so going from one teammate's page to another's (`/teammates/a` →
 * `/teammates/b` renders the same tree) would keep the text — and the error —
 * typed for `a`, and send it to `b`. A key that names both the agent and the
 * source makes any such change a fresh composer, starting empty (or, shared,
 * from the assistant's draft).
 */
export function pairComposerKey(memberId: string, shared: boolean): string {
  return `${shared ? "shared" : "local"}:${memberId}`;
}

/**
 * Put the cursor after the last character of a text box — for a composer that
 * mounts holding a carried-over draft, so typing continues where it left off.
 */
export function placeCursorAtEnd(el: { value: string; setSelectionRange(start: number, end: number): void }): void {
  const end = el.value.length;
  el.setSelectionRange(end, end);
}
