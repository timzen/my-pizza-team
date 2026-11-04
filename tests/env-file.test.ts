/**
 * tests/env-file.test.ts — the agent env file (`agentEnvFile`, shared/env-file.ts).
 *
 * The file's syntax is systemd's EnvironmentFile= so `mpt install` can point the
 * unit at the same file, and the parser must agree with it on what a line means:
 * comments, blanks, optional quotes, '=' inside values, no shell expansion. Two
 * properties matter more than the happy path: a bad file is a *reported* condition
 * (line numbers, never a crash) and never leaks a value into a message.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "./_assert.ts";
import { agentEnvWarning, loadAgentEnv, parseEnvFile, resolveEnvFilePath } from "../shared/env-file.ts";

// ─── Parsing ─────────────────────────────────────────────────────────

test("KEY=value lines parse; comments and blank lines are skipped", () => {
  const { vars, errors } = parseEnvFile([
    "# a comment",
    "; also a comment (systemd)",
    "",
    "   ",
    "OUTLOOK_MCP_ENABLE_WRITES=true",
    "  ACCOUNT = 123456789012  ",
    "EMPTY=",
  ].join("\n"));
  assertEquals(errors, []);
  assertEquals(vars, { OUTLOOK_MCP_ENABLE_WRITES: "true", ACCOUNT: "123456789012", EMPTY: "" });
});

test("surrounding quotes are removed and keep their inner whitespace", () => {
  const { vars, errors } = parseEnvFile(`A="hello world"\nB='  spaced  '\nC="it's"\nD=''\nF=mid"dle"`);
  assertEquals(errors, []);
  // Only a quote that opens the value is special; F's are part of it.
  assertEquals(vars.F, `mid"dle"`);
  assertEquals(vars.A, "hello world");
  assertEquals(vars.B, "  spaced  ");
  assertEquals(vars.C, "it's");
  assertEquals(vars.D, "");
});

test("only the first '=' splits: the rest belongs to the value", () => {
  const { vars, errors } = parseEnvFile("URL=https://x.test/?a=1&b=2\nB64=YWJj==");
  assertEquals(errors, []);
  assertEquals(vars, { URL: "https://x.test/?a=1&b=2", B64: "YWJj==" });
});

test("nothing is shell-expanded, and an inline '#' is part of the value", () => {
  const { vars } = parseEnvFile("P=$HOME/bin:$(whoami)\nH=a # not a comment");
  assertEquals(vars, { P: "$HOME/bin:$(whoami)", H: "a # not a comment" });
});

test("CRLF line endings don't end up in values", () => {
  assertEquals(parseEnvFile("A=1\r\nB=2\r\n").vars, { A: "1", B: "2" });
});

test("a repeated key: the last one wins", () => {
  assertEquals(parseEnvFile("A=1\nA=2").vars, { A: "2" });
});

test("invalid lines are reported with their 1-based line numbers", () => {
  const { vars, errors } = parseEnvFile([
    "GOOD=1",       // 1
    "no equals",    // 2
    "1BAD=x",       // 3
    "export X=1",   // 4
    "has-dash=1",   // 5
    "=nokey",       // 6
    `Q="open`,      // 7
    "ALSO_GOOD=2",  // 8
  ].join("\n"));
  assertEquals(errors.map((e) => e.line), [2, 3, 4, 5, 6, 7]);
  assertStringIncludes(errors[0]!.message, "no '=' found");
  assertStringIncludes(errors[2]!.message, "drop the 'export'");
  assertStringIncludes(errors[5]!.message, "unterminated double quote");
  // Valid lines still count (for doctor's key count).
  assertEquals(vars, { GOOD: "1", ALSO_GOOD: "2" });
});

test("an error never quotes a value", () => {
  const { errors } = parseEnvFile(`SECRET="hunter2`);
  assertEquals(errors.length, 1);
  assertEquals(errors[0]!.message.includes("hunter2"), false);
});

// ─── Locating ────────────────────────────────────────────────────────

test("~ expands to home; relative paths resolve against the team dir", () => {
  assertEquals(resolveEnvFilePath("~/.config/mpt/env", "/team/.my-pizza-team", "/home/u"), "/home/u/.config/mpt/env");
  assertEquals(resolveEnvFilePath("~", "/t", "/home/u"), "/home/u");
  assertEquals(resolveEnvFilePath("agent.env", "/team/.my-pizza-team", "/home/u"), "/team/.my-pizza-team/agent.env");
  assertEquals(resolveEnvFilePath("../env", "/team/.my-pizza-team", "/home/u"), "/team/env");
  assertEquals(resolveEnvFilePath("/etc/mpt.env", "/t", "/home/u"), "/etc/mpt.env");
});

// ─── Loading ─────────────────────────────────────────────────────────

function withDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-envfile-"));
  try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("unset: nothing to pass and nothing to say", () => {
  for (const agentEnvFile of [undefined, "", "   "]) {
    const env = loadAgentEnv({ agentEnvFile }, "/t");
    assertEquals(env, { path: null, vars: {}, keys: [], problem: null });
    assertEquals(agentEnvWarning(env), null);
  }
});

test("a good file loads its variables", () => {
  withDir((dir) => {
    fs.writeFileSync(path.join(dir, "agent.env"), "# x\nA=1\nB='two'\n");
    const env = loadAgentEnv({ agentEnvFile: "agent.env" }, dir);
    assertEquals(env.path, path.join(dir, "agent.env"));
    assertEquals(env.vars, { A: "1", B: "two" });
    assertEquals(env.keys, ["A", "B"]);
    assertEquals(env.problem, null);
  });
});

test("a missing file is a reported problem, not a crash", () => {
  withDir((dir) => {
    const env = loadAgentEnv({ agentEnvFile: "nope.env" }, dir);
    assertEquals(env.vars, {});
    assertStringIncludes(env.problem!, "does not exist");
    assertStringIncludes(agentEnvWarning(env)!, "agentEnvFile not applied");
  });
});

test("a directory instead of a file is a reported problem", () => {
  withDir((dir) => {
    const env = loadAgentEnv({ agentEnvFile: dir }, dir);
    assertStringIncludes(env.problem!, "is a directory");
  });
});

test("an invalid file is all-or-nothing: no variables, line numbers in the problem, no values", () => {
  withDir((dir) => {
    fs.writeFileSync(path.join(dir, "e"), "TOKEN=s3cr3t\nbad line\nexport Y=hunter2\n");
    const env = loadAgentEnv({ agentEnvFile: "e" }, dir);
    assertEquals(env.vars, {}, "a half-applied file would be worse than none");
    assertEquals(env.keys, ["TOKEN"]);
    assertStringIncludes(env.problem!, "2 invalid line(s)");
    assertStringIncludes(env.problem!, "line 2");
    assertStringIncludes(env.problem!, "line 3");
    assertEquals(env.problem!.includes("s3cr3t") || env.problem!.includes("hunter2"), false);
  });
});

test("many invalid lines are summarised, not all listed", () => {
  withDir((dir) => {
    fs.writeFileSync(path.join(dir, "e"), Array.from({ length: 6 }, () => "bad").join("\n"));
    assertStringIncludes(loadAgentEnv({ agentEnvFile: "e" }, dir).problem!, "(and 3 more)");
  });
});

test("edits apply on the next load (it's re-read, not cached)", () => {
  withDir((dir) => {
    const file = path.join(dir, "e");
    fs.writeFileSync(file, "A=1\n");
    assertEquals(loadAgentEnv({ agentEnvFile: file }, dir).vars, { A: "1" });
    fs.writeFileSync(file, "A=2\nB=3\n");
    assertEquals(loadAgentEnv({ agentEnvFile: file }, dir).vars, { A: "2", B: "3" });
  });
});
