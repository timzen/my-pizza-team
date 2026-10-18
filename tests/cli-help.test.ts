/**
 * tests/cli-help.test.ts — `mpt --help` lists every command `mpt` dispatches.
 *
 * The help's Commands list had fallen behind the dispatcher: `setup`, `doctor`, and
 * `lead` — the first three commands a new user runs — appeared only under Examples.
 * This derives the dispatched commands from cli/main.ts's own `switch`, so adding a
 * command without documenting it fails here.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { assert } from "./_assert.ts";

const MAIN = new URL("../cli/main.ts", import.meta.url);

/** Commands in main()'s dispatch switch, minus internal and help/version aliases. */
function dispatchedCommands(): string[] {
  const src = fs.readFileSync(MAIN, "utf8");
  const i = src.indexOf("const command = args[0];");
  assert(i >= 0, "found main()'s dispatcher");
  const sw = src.slice(i, src.indexOf("\n  }\n", i));
  const cases = [...sw.matchAll(/case "([^"]+)":/g)].map((m) => m[1]!);
  return cases.filter((c) => !c.startsWith("-") && c !== "help" && !c.endsWith("-internal"));
}

/** `mpt --help`'s stdout, from the CLI run as its own process. */
function runHelp(): string {
  return execFileSync(process.execPath, [fileURLToPath(MAIN), "--help"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

test("every dispatched command is listed under Commands in --help", () => {
  const commands = dispatchedCommands();
  assert(commands.length >= 10, `parsed the dispatcher (${commands.join(", ")})`);

  const help = runHelp();
  const section = help.slice(help.indexOf("Commands:"), help.indexOf("Environment:"));
  for (const c of commands) {
    assert(new RegExp(`^  ${c}\\b`, "m").test(section), `"${c}" is missing from --help's Commands list`);
  }
});

test("--help documents HOST alongside TEAM_DIR and PORT", () => {
  const env = runHelp().split("Environment:")[1] ?? "";
  for (const v of ["TEAM_DIR", "PORT", "HOST"]) assert(env.includes(v), `${v} is documented`);
});
