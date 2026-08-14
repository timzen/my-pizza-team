// Bubble splitting: turn one assistant message into iMessage-style chat bubbles
//
// Chat v2 mirrors the assistant's *own prose* into the daemon chat instead of
// making it call a `send_message` tool for every bubble (see
// my-pizza-team/docs/ASSISTANT_CHAT_V2.md §5.2). That means the harness decides
// where one bubble ends and the next begins.
//
// The rule: split on blank lines, because that is what the chat framing prompt
// asks the model for and what it does naturally. Two things make it safe:
//
//   - Never split inside a fenced code block or a list. A blank line inside a
//     fence is content; a blank line between list items is cosmetic. Splitting
//     either would shred the markdown.
//   - Merge runt paragraphs into their neighbour, so a stray "Sure —" or a
//     trailing "Thanks!" doesn't become its own bubble. Questions are exempt:
//     the framing prompt asks for the question in its own final paragraph, and
//     that is exactly the bubble the user replies to.

/** Paragraphs shorter than this (single-line only) are merged into a neighbour. */
const RUNT_LENGTH = 25;

/**
 * Split one assistant message into chat bubbles.
 *
 * Returns an empty array for whitespace-only input (nothing to mirror).
 */
export function splitIntoBubbles(text: string): string[] {
  const normalized = (text || "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const blocks = splitBlocks(normalized);
  return mergeRunts(blocks);
}

/**
 * Split into paragraph blocks on blank lines, treating fenced code blocks and
 * contiguous list runs as atomic.
 */
function splitBlocks(text: string): string[] {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    const block = current.join("\n").trim();
    if (block) blocks.push(block);
    current = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);

    if (fence) {
      current.push(line);
      // Closing fence must use the same marker family as the opening one.
      if (fenceMatch && fenceMatch[1]!.startsWith(fence[0]!)) fence = null;
      continue;
    }

    if (fenceMatch) {
      fence = fenceMatch[1]!;
      current.push(line);
      continue;
    }

    if (line.trim() === "") {
      // A blank line between two list items is cosmetic ("loose" list) — keep
      // the list together rather than exploding it into one bubble per item.
      if (isListLine(lines[i - 1]) && isListLine(nextNonBlank(lines, i))) {
        current.push(line);
        continue;
      }
      flush();
      continue;
    }

    current.push(line);
  }
  flush();
  return blocks;
}

/** True for markdown bullet/numbered list items (and their indented continuations). */
function isListLine(line: string | undefined): boolean {
  if (line === undefined) return false;
  return /^\s*([-*+]|\d+[.)])\s+/.test(line);
}

/** The next line with content at or after `from`, skipping blanks. */
function nextNonBlank(lines: string[], from: number): string | undefined {
  for (let i = from + 1; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() !== "") return lines[i];
  }
  return undefined;
}

/** A short single-line paragraph that isn't a question to the user. */
function isRuntBlock(block: string): boolean {
  return block.length < RUNT_LENGTH && !block.includes("\n") && !block.trimEnd().endsWith("?");
}

/**
 * Fold very short paragraphs into a neighbour: back into the previous bubble
 * when there is one, otherwise forward into the next.
 */
function mergeRunts(blocks: string[]): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    const isRunt = isRuntBlock(block);
    if (isRunt && out.length > 0) {
      out[out.length - 1] = `${out[out.length - 1]}\n\n${block}`;
      continue;
    }
    if (isRunt && out.length === 0) {
      out.push(block);
      continue;
    }
    // A runt that opened the message gets absorbed by the paragraph after it.
    const prev = out[out.length - 1];
    if (out.length === 1 && prev !== undefined && isRuntBlock(prev)) {
      out[out.length - 1] = `${prev}\n\n${block}`;
      continue;
    }
    out.push(block);
  }
  return out;
}
