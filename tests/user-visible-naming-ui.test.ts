/**
 * tests/user-visible-naming-ui.test.ts — no text the web UI shows says "leader".
 *
 * To the user the agent they chat with is the **assistant**; "leader" is an internal
 * name (the member name, the tmux window `LEADER_WINDOW`, `--ppt-lead`, the
 * `/api/leader/*` routes, `leaderPresent`, the `leader` harness template). The rename
 * touched dozens of strings across the UI, so this keeps the word from creeping back:
 * it parses every ui/src .ts/.tsx file with the TypeScript compiler (so comments and
 * code identifiers are never mistaken for copy) and checks every string literal,
 * template-literal chunk and JSX text that reads like prose.
 *
 * What's exempt, and why:
 *   - strings with no whitespace — ids, keys, role values, route paths, CSS classes
 *     (`"leader"`, `"leaderOnline"`, `"/api/leader/directives"`); prose has spaces;
 *   - import paths and type-position literals (never rendered);
 *   - the internal names a user can legitimately be shown verbatim (a config key, the
 *     tmux window `<session>:leader`), listed in `INTERNAL_NAMES`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { assertEquals } from "./_assert.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UI_SRC = path.join(ROOT, "ui/src");

/** Internal names that may appear in copy as-is; removed before the check. */
const INTERNAL_NAMES: RegExp[] = [
  /harnesses\.[\w${}]+\.leader\b/g, // the config key for the assistant's command template
  /:leader\b/g, // the tmux window, `<session>:leader`
  /\/api\/leader\//g, // a route path quoted in help text
];

/** Every .ts/.tsx file under ui/src, relative to it. */
function sourceFiles(dir = UI_SRC): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts") ? [path.relative(UI_SRC, p)] : [];
  });
}

/** Whether a literal is in a position that's never shown: an import/export path or a type. */
function neverRendered(node: ts.Node): boolean {
  const parent = node.parent;
  return ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isLiteralTypeNode(parent)
    || ts.isExternalModuleReference(parent);
}

/** The prose-like text in one file (string literals, template chunks, JSX text), with its line. */
function proseIn(file: string): Array<{ line: number; text: string }> {
  const src = fs.readFileSync(path.join(UI_SRC, file), "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Array<{ line: number; text: string }> = [];
  const visit = (node: ts.Node): void => {
    let text: string | null = null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!neverRendered(node)) text = node.text;
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      text = node.text;
    } else if (ts.isJsxText(node)) {
      text = node.text;
    }
    if (text !== null && /\s/.test(text.trim())) {
      out.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Whether a piece of copy says "leader" once the allowed internal names are removed. */
function saysLeader(text: string): boolean {
  const stripped = INTERNAL_NAMES.reduce((t, re) => t.replace(re, ""), text);
  return /leader/i.test(stripped);
}

test("saysLeader: catches copy, spares the internal names users may see", () => {
  assertEquals(saysLeader("No leader online to answer"), true);
  assertEquals(saysLeader("Start the Leader"), true);
  assertEquals(saysLeader("No assistant online to answer"), false);
  assertEquals(saysLeader("check harnesses.pi.leader in config.json"), false);
  assertEquals(saysLeader("Opened mpt:leader"), false);
});

test("the scan reads JSX text and template chunks, not comments or identifiers", () => {
  const tmp = path.join(UI_SRC, "__naming_probe__.tsx");
  fs.writeFileSync(tmp, [
    "// a leader comment",
    "const leaderPresent = true;",
    "const role = \"leader\";",
    "const t = `the leader is ${leaderPresent ? \"up\" : \"down\"}`;",
    "export const X = () => <p>No leader here</p>;",
  ].join("\n"));
  try {
    const hits = proseIn("__naming_probe__.tsx").filter((p) => saysLeader(p.text)).map((p) => p.line);
    assertEquals(hits, [4, 5]);
  } finally {
    fs.rmSync(tmp);
  }
});

test("no user-visible UI text says \"leader\" (it's the assistant)", () => {
  const files = sourceFiles();
  assertEquals(files.length > 50, true, `found the UI sources (${files.length})`);
  const offenders = files.flatMap((f) =>
    proseIn(f).filter((p) => saysLeader(p.text)).map((p) => `${f}:${p.line}: ${JSON.stringify(p.text.trim())}`)
  );
  assertEquals(offenders, [], `say "assistant" in user-visible text:\n${offenders.join("\n")}`);
});
