/**
 * list-keys — Stable React keys for polled lists whose rows have no id.
 *
 * An index key ties a row's DOM to its *position*: when a poll inserts a row
 * above (a newest-first list, a new triage round), every row below gets its
 * neighbour's content rewritten in place, which also wipes a text selection
 * inside it. Comments, triage rounds, and decisions are append-only records
 * without ids, but their author + timestamp identify them; `uniqueKeys` turns
 * such a natural key into a unique one (a rare exact duplicate gets `#2`, `#3`,
 * … in order), so each row keeps its DOM across polls (docs/DESIGN.md "Polling
 * Never Disturbs the Reader").
 */

/** One unique, content-derived key per item, in the items' order. */
export function uniqueKeys<T>(items: readonly T[], keyOf: (item: T) => string): string[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = keyOf(item);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  });
}

/**
 * `uniqueKeys` assigned in the items' own (chronological) order, looked up per
 * item — for a list rendered re-sorted (newest first), so a duplicate's `#n`
 * doesn't shift when a newer one lands.
 */
export function keyLookup<T extends object>(items: readonly T[], keyOf: (item: T) => string): (item: T) => string {
  const keys = uniqueKeys(items, keyOf);
  const byItem = new Map<T, string>(items.map((item, i) => [item, keys[i]!]));
  return (item) => byItem.get(item) ?? keyOf(item);
}

/** The natural key of a thread entry (comment, analysis, decision): who and when. */
export function threadEntryKey(entry: { from: string; at: string }): string {
  return `${entry.at}|${entry.from}`;
}
