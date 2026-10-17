/**
 * tests/story-collapse.test.ts — The Board's per-story collapse preference
 * (ui/src/lib/storyCollapse.ts): stories are expanded unless explicitly
 * collapsed, the choice round-trips per story, Expand/Collapse all writes every
 * given story, and broken storage never throws.
 */

import { assertEquals } from "@std/assert";
import {
  readStoryCollapsed,
  storyCollapseKey,
  writeAllStoriesCollapsed,
  writeStoryCollapsed,
} from "../ui/src/lib/storyCollapse.ts";

/** An in-memory Storage slice. */
function memStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

Deno.test("stories are expanded by default", () => {
  assertEquals(readStoryCollapsed(memStorage(), "s1"), false);
  assertEquals(readStoryCollapsed(undefined, "s1"), false);
  assertEquals(readStoryCollapsed(memStorage({ [storyCollapseKey("s1")]: "garbage" }), "s1"), false);
});

Deno.test("collapse round-trips per story", () => {
  const s = memStorage();
  writeStoryCollapsed(s, "s1", true);
  assertEquals(readStoryCollapsed(s, "s1"), true);
  assertEquals(readStoryCollapsed(s, "s2"), false);
  writeStoryCollapsed(s, "s1", false);
  assertEquals(readStoryCollapsed(s, "s1"), false);
});

Deno.test("collapse/expand all writes every given story and returns the map", () => {
  const s = memStorage();
  writeStoryCollapsed(s, "other", true);
  assertEquals(writeAllStoriesCollapsed(s, ["a", "b"], true), { a: true, b: true });
  assertEquals(readStoryCollapsed(s, "a"), true);
  assertEquals(readStoryCollapsed(s, "b"), true);
  assertEquals(writeAllStoriesCollapsed(s, ["a", "b"], false), { a: false, b: false });
  assertEquals(readStoryCollapsed(s, "a"), false);
  assertEquals(readStoryCollapsed(s, "other"), true); // not visible ⇒ untouched
});

Deno.test("blocked storage falls back to expanded and never throws", () => {
  const blocked = {
    getItem: () => { throw new Error("SecurityError"); },
    setItem: () => { throw new Error("SecurityError"); },
  };
  assertEquals(readStoryCollapsed(blocked, "s1"), false);
  writeStoryCollapsed(blocked, "s1", true);
  assertEquals(writeAllStoriesCollapsed(blocked, ["s1"], true), { s1: true });
});
