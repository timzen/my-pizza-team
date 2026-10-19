/**
 * tests/_assert.ts — the handful of `@std/assert` helpers the suites use, on top of
 * `node:assert/strict`.
 *
 * The tests were written against `@std/assert` (from JSR); keeping the same names and
 * signatures here meant the move to `node:test` changed only each file's import line.
 * Only the functions the tests actually call are implemented.
 *
 * One deliberate difference from a bare `assert.deepStrictEqual`: `assertEquals`
 * treats null-prototype objects like plain objects (as `@std/assert` does). Rows from
 * `node:sqlite` are null-prototype objects, and comparing them against an object
 * literal is the common case in the store tests.
 */

import nodeAssert from "node:assert/strict";

/** Error constructor accepted by `assertThrows` / `assertRejects`. */
type ErrorClass<E extends Error> = abstract new (...args: any[]) => E;

/**
 * Copy `value` with every null-prototype object turned into a plain object and `-0`
 * turned into `0`, so `assertEquals` matches `@std/assert`'s notion of equality.
 */
function normalize(value: unknown, seen = new Map<object, unknown>()): unknown {
  if (Object.is(value, -0)) return 0;
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (let i = 0; i < value.length; i++) {
      // Preserve holes: `[1, , 3]` and `[1, undefined, 3]` stay different.
      if (i in value) out[i] = normalize(value[i], seen);
      else out.length = i + 1;
    }
    return out;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return value;
  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const [k, v] of Object.entries(value)) out[k] = normalize(v, seen);
  return out;
}

/**
 * `msg` as node:assert's trailing argument. Node rejects an explicit `undefined`
 * message (ERR_INVALID_ARG_TYPE) instead of falling back to its generated one, so an
 * absent message must be an absent argument.
 */
const message = (msg?: string): [] | [string] => (msg === undefined ? [] : [msg]);

/** Assert that `expr` is truthy. */
export function assert(expr: unknown, msg?: string): asserts expr {
  nodeAssert.ok(expr, ...message(msg));
}

/** Assert that `expr` is falsy. */
export function assertFalse(expr: unknown, msg?: string): void {
  nodeAssert.ok(!expr, ...message(msg));
}

/** Assert deep equality (null-prototype objects compare like plain ones). */
export function assertEquals<T>(actual: unknown, expected: T, msg?: string): asserts actual is T {
  nodeAssert.deepStrictEqual(normalize(actual), normalize(expected), ...message(msg));
}

/** Assert deep inequality — the negation of `assertEquals`. */
export function assertNotEquals(actual: unknown, expected: unknown, msg?: string): void {
  nodeAssert.notDeepStrictEqual(normalize(actual), normalize(expected), ...message(msg));
}

/** Assert that `actual` is neither `null` nor `undefined`. */
export function assertExists<T>(actual: T, msg?: string): asserts actual is NonNullable<T> {
  if (actual === null || actual === undefined) {
    nodeAssert.fail(msg ?? `Expected actual: "${actual}" to not be null or undefined`);
  }
}

/** Assert that `actual` contains the substring `expected`. */
export function assertStringIncludes(actual: string, expected: string, msg?: string): void {
  if (!actual.includes(expected)) {
    nodeAssert.fail(msg ?? `Expected actual: "${actual}" to contain: "${expected}"`);
  }
}

/** Assert that `actual` matches the regular expression `expected`. */
export function assertMatch(actual: string, expected: RegExp, msg?: string): void {
  nodeAssert.match(actual, expected, ...message(msg));
}

/** Assert that `actual` and `expected` differ by at most `tolerance` (default 1e-7). */
export function assertAlmostEquals(actual: number, expected: number, tolerance = 1e-7, msg?: string): void {
  if (Object.is(actual, expected)) return;
  const delta = Math.abs(expected - actual);
  if (!(delta <= tolerance)) {
    nodeAssert.fail(msg ?? `Expected actual: "${actual}" to be close to "${expected}": delta "${delta}" is greater than "${tolerance}"`);
  }
}

/** Check a caught error against the optional class and message substring. */
function checkError<E extends Error>(err: unknown, ErrorClass?: ErrorClass<E>, msgIncludes?: string, msg?: string): E {
  if (ErrorClass && !(err instanceof ErrorClass)) {
    nodeAssert.fail(msg ?? `Expected error to be instance of "${ErrorClass.name}", but was "${(err as Error)?.constructor?.name}"`);
  }
  if (msgIncludes !== undefined) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes(msgIncludes)) {
      nodeAssert.fail(msg ?? `Expected error message to include "${msgIncludes}", but got "${message}"`);
    }
  }
  return err as E;
}

/** Assert that `fn` throws (optionally a given class whose message includes `msgIncludes`); returns the error. */
export function assertThrows<E extends Error = Error>(
  fn: () => unknown,
  ErrorClass?: ErrorClass<E>,
  msgIncludes?: string,
  msg?: string,
): E {
  try {
    fn();
  } catch (err) {
    return checkError(err, ErrorClass, msgIncludes, msg);
  }
  return nodeAssert.fail(msg ?? "Expected function to throw");
}

/** Assert that `fn` rejects (optionally a given class whose message includes `msgIncludes`); returns the error. */
export async function assertRejects<E extends Error = Error>(
  fn: () => PromiseLike<unknown>,
  ErrorClass?: ErrorClass<E>,
  msgIncludes?: string,
  msg?: string,
): Promise<E> {
  try {
    await fn();
  } catch (err) {
    return checkError(err, ErrorClass, msgIncludes, msg);
  }
  return nodeAssert.fail(msg ?? "Expected function to reject");
}
