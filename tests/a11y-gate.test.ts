/**
 * tests/a11y-gate.test.ts — the accessibility scan's pass/fail rule (tests/a11y/_gate.ts).
 *
 * The scan itself needs a browser and runs separately (`npm run test:a11y`); the
 * rule deciding what fails it is pure and is checked here, in the fast suite.
 */

import { test } from "node:test";
import { assertEquals, assertStringIncludes, assertThrows } from "./_assert.ts";
import { type Finding, gate, isFailing, parseAllowlist, reportTable } from "./a11y/_gate.ts";

const f = (route: string, rule: string, impact: Finding["impact"]): Finding => ({ route, rule, impact, nodes: 1, help: `${rule} help` });

test("only serious and critical findings fail", () => {
  assertEquals(isFailing(f("/", "a", "critical")), true);
  assertEquals(isFailing(f("/", "a", "serious")), true);
  assertEquals(isFailing(f("/", "a", "moderate")), false);
  assertEquals(isFailing(f("/", "a", "minor")), false);
  assertEquals(isFailing(f("/", "a", null)), false);
});

test("the allowlist excuses a failing finding by route and rule — not the same rule elsewhere", () => {
  const r = gate(
    [f("/", "button-name", "critical"), f("/help", "button-name", "critical"), f("/", "region", "moderate")],
    [{ route: "/", rule: "button-name", task: "t2" }],
  );
  assertEquals(r.allowed.map((x) => x.route), ["/"]);
  assertEquals(r.unexpected.map((x) => x.route), ["/help"]);
  assertEquals(r.stale, []);
});

test("an entry nothing matches any more is stale, so the list only shrinks", () => {
  const r = gate([f("/", "region", "moderate")], [{ route: "/", rule: "button-name", task: "t2" }]);
  assertEquals(r.stale.map((e) => e.rule), ["button-name"]);
  // A moderate finding doesn't keep an entry alive: entries only cover failing findings.
  assertEquals(r.unexpected, []);
});

test("staleness only counts the routes actually scanned", () => {
  const allow = [{ route: "/", rule: "a", task: "t" }, { route: "/help", rule: "a", task: "t" }];
  assertEquals(gate([], allow, ["/help"]).stale.map((e) => e.route), ["/help"]);
});

test("parseAllowlist reads entries and rejects a malformed one", () => {
  assertEquals(parseAllowlist({ "//": "comment", entries: [] }), []);
  assertEquals(parseAllowlist({ entries: [{ route: "/", rule: "r", task: "t", note: "n" }] }), [{ route: "/", rule: "r", task: "t", note: "n" }]);
  assertThrows(() => parseAllowlist({}));
  assertThrows(() => parseAllowlist({ entries: [{ route: "/", rule: "r" }] }));
});

test("reportTable lists the most severe first and escapes pipes", () => {
  const table = reportTable([f("/", "minor-rule", "minor"), { ...f("/", "crit", "critical"), help: "a | b" }]);
  const lines = table.split("\n");
  assertStringIncludes(lines[2]!, "crit");
  assertStringIncludes(lines[2]!, "a \\| b");
  assertStringIncludes(lines[3]!, "minor-rule");
});
