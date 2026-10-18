/**
 * tests/start.test.ts — resolveTeamDir (daemon/start.ts), shared by `mpt` and
 * daemon/main.ts so both find the same team directory.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import { test } from "node:test";
import { assertEquals } from "./_assert.ts";
import { resolveTeamDir } from "../daemon/start.ts";
import * as path from "node:path";

test("TEAM_DIR may name the team directory, or its parent", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-start-test-"));
  try {
    const team = path.join(parent, ".my-pizza-team");
    // Its parent, before the team dir exists: used as given (it may be the team dir).
    assertEquals(resolveTeamDir(parent, "/elsewhere"), parent);
    fs.mkdirSync(team);
    assertEquals(resolveTeamDir(parent, "/elsewhere"), team);
    assertEquals(resolveTeamDir(team, "/elsewhere"), team);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test("unset: .my-pizza-team in the current directory", () => {
  assertEquals(resolveTeamDir(undefined, "/work/project"), path.join("/work/project", ".my-pizza-team"));
});
