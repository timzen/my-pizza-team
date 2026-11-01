/**
 * tests/util.test.ts — The tiny shared helpers (shared/util.ts).
 *
 * Covers: `isPlainObject` accepts objects (including null-prototype ones) and
 * rejects null, arrays and primitives; `errorMessage` returns an Error's message
 * and stringifies anything else.
 */

import { test } from "node:test";
import { assertEquals } from "./_assert.ts";
import { errorMessage, isPlainObject } from "../shared/util.ts";

test("isPlainObject accepts objects and rejects null, arrays and primitives", () => {
  assertEquals(isPlainObject({}), true);
  assertEquals(isPlainObject({ a: 1 }), true);
  assertEquals(isPlainObject(Object.create(null)), true);
  assertEquals(isPlainObject(null), false);
  assertEquals(isPlainObject(undefined), false);
  assertEquals(isPlainObject([]), false);
  assertEquals(isPlainObject("x"), false);
  assertEquals(isPlainObject(1), false);
});

test("errorMessage returns an Error's message and stringifies anything else", () => {
  assertEquals(errorMessage(new Error("boom")), "boom");
  assertEquals(errorMessage(new TypeError("bad type")), "bad type");
  assertEquals(errorMessage("plain string"), "plain string");
  assertEquals(errorMessage(42), "42");
  assertEquals(errorMessage(undefined), "undefined");
});
