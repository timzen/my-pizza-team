// Behavioral tests for bubble splitting
// Run with: node --experimental-strip-types tests/bubbles.test.mjs
//
// This is the one piece of chat v2 where the harness makes an editorial decision
// (where one bubble ends and the next begins), so it is tested for real behavior
// rather than by source inspection. See src/bubbles.ts.

import * as assert from "node:assert";
import { splitIntoBubbles } from "../src/bubbles.ts";

let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${label}: ${e.message}`);
    failed++;
  }
}

console.log("splitIntoBubbles:");

test("empty or whitespace-only text produces no bubbles", () => {
  assert.deepStrictEqual(splitIntoBubbles(""), []);
  assert.deepStrictEqual(splitIntoBubbles("   \n\n  "), []);
  assert.deepStrictEqual(splitIntoBubbles(undefined), []);
});

test("one paragraph is one bubble", () => {
  assert.deepStrictEqual(
    splitIntoBubbles("Two stories are blocked on review right now."),
    ["Two stories are blocked on review right now."],
  );
});

test("blank lines separate bubbles", () => {
  assert.deepStrictEqual(
    splitIntoBubbles("Here is the first substantial point.\n\nAnd here is the second one, also substantial."),
    ["Here is the first substantial point.", "And here is the second one, also substantial."],
  );
});

test("windows line endings and extra blank lines are normalized", () => {
  assert.deepStrictEqual(
    splitIntoBubbles("First paragraph of the reply.\r\n\r\n\r\nSecond paragraph of the reply."),
    ["First paragraph of the reply.", "Second paragraph of the reply."],
  );
});

test("never splits inside a fenced code block", () => {
  const bubbles = splitIntoBubbles(
    "Here is the fix you asked about:\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nThat should do it for the parser.",
  );
  assert.strictEqual(bubbles.length, 3);
  assert.ok(bubbles[1].includes("const a = 1;\n\nconst b = 2;"), "code block was split");
  assert.strictEqual(bubbles[2], "That should do it for the parser.");
});

test("tilde fences are respected too", () => {
  const bubbles = splitIntoBubbles("~~~\nline one\n\nline two\n~~~");
  assert.strictEqual(bubbles.length, 1);
});

test("keeps a loose list together instead of one bubble per item", () => {
  const bubbles = splitIntoBubbles(
    "These stories are blocked:\n\n- auth-refresh is waiting on review\n\n- billing-sync is waiting on deploy\n\nWant me to nudge the reviewers?",
  );
  assert.strictEqual(bubbles.length, 3);
  assert.ok(bubbles[1].includes("auth-refresh") && bubbles[1].includes("billing-sync"), "list was split");
  assert.strictEqual(bubbles[2], "Want me to nudge the reviewers?");
});

test("numbered lists count as lists", () => {
  const bubbles = splitIntoBubbles("Plan:\n\n1. Ship the daemon\n\n2. Ship the UI");
  assert.strictEqual(bubbles.length, 1);
});

test("a runt paragraph is merged into its neighbour", () => {
  // "On it." alone would be a silly bubble; it rides along with the next one.
  assert.deepStrictEqual(
    splitIntoBubbles("On it.\n\nTwo stories are blocked on review right now."),
    ["On it.\n\nTwo stories are blocked on review right now."],
  );
});

test("a trailing runt is merged backwards", () => {
  const bubbles = splitIntoBubbles("I re-queued the failing work item for you.\n\nDone!");
  assert.strictEqual(bubbles.length, 1);
  assert.ok(bubbles[0].endsWith("Done!"));
});

test("substantial short paragraphs still get their own bubbles", () => {
  const bubbles = splitIntoBubbles(
    "auth-refresh is blocked on review.\n\nbilling-sync is blocked on deploy.\n\nWant me to nudge them?",
  );
  assert.strictEqual(bubbles.length, 3);
});

test("a short question keeps its own bubble (it is what the user replies to)", () => {
  const bubbles = splitIntoBubbles("I re-queued the failing work item.\n\nAnything else?");
  assert.deepStrictEqual(bubbles, ["I re-queued the failing work item.", "Anything else?"]);
});

test("markdown inside a bubble is preserved verbatim", () => {
  const bubbles = splitIntoBubbles("**auth-refresh** is blocked on `review` — see [the story](http://x/y).");
  assert.strictEqual(bubbles[0], "**auth-refresh** is blocked on `review` — see [the story](http://x/y).");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
