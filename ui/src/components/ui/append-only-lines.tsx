/**
 * AppendOnlyLines — Streaming plain text as one span per line.
 *
 * For text that only ever grows at the end (the assistant's live reasoning, a
 * running tool's output): a line's index is its identity, so each new chunk
 * rewrites just the last line's text node and a selection in any earlier line
 * survives the stream. One big text node would be rewritten — and the user's
 * selection dropped — on every chunk (docs/DESIGN.md "Polling Never Disturbs
 * the Reader"). Render it inside a `whitespace-pre-wrap` element.
 */

export function AppendOnlyLines({ text }: { text: string }) {
  const lines = text.split("\n");
  // Index keys are right here: lines are only ever appended (see above).
  return lines.map((line, i) => <span key={i}>{i < lines.length - 1 ? `${line}\n` : line}</span>);
}
