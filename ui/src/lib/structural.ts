/**
 * structural — Structural equality and structural sharing for polled JSON.
 *
 * A poll answers with a brand-new object every time, even when nothing changed.
 * Handing that straight to React re-renders every consumer, and any subtree
 * whose identity matters (a `useMemo` dependency, a "seed the draft from this
 * data" marker, a `memo` child) treats it as new. `shareStructure` keeps the
 * previous reference for every part of the answer that is structurally equal,
 * so an unchanged poll returns the *same* object (React skips the update) and a
 * changed one only replaces the parts that differ (docs/DESIGN.md "Polling Never
 * Disturbs the Reader").
 *
 * JSON values only (what `res.json()` and SSE frames give): plain objects,
 * arrays, strings, numbers, booleans, null. Anything else is compared by
 * identity.
 */

/** A plain object (`{}` or null-prototype), not an array, Date, Map, … */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Deep equality for JSON values: same shape, same keys, same primitives. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonEqual(a[k], b[k]));
  }
  return false;
}

/**
 * `next`, reusing `prev`'s references wherever the two are structurally equal.
 * Returns `prev` itself when nothing changed. Arrays are matched by position;
 * objects by key.
 */
export function shareStructure<T>(prev: unknown, next: T): T {
  if (Object.is(prev, next)) return prev as T;
  if (Array.isArray(prev) && Array.isArray(next)) {
    const out = next.map((v, i) => (i < prev.length ? shareStructure(prev[i], v) : v));
    const same = out.length === prev.length && out.every((v, i) => v === prev[i]);
    return (same ? prev : out) as T;
  }
  if (isPlainObject(prev) && isPlainObject(next)) {
    const out: Record<string, unknown> = {};
    let same = Object.keys(prev).length === Object.keys(next).length;
    for (const k of Object.keys(next)) {
      const has = Object.prototype.hasOwnProperty.call(prev, k);
      out[k] = has ? shareStructure(prev[k], next[k]) : next[k];
      if (!has || out[k] !== prev[k]) same = false;
    }
    return (same ? prev : out) as T;
  }
  return next;
}
