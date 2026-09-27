/**
 * tests/start.test.ts — resolveTeamDir (daemon/start.ts), shared by `mpt` and
 * daemon/main.ts so both find the same team directory.
 */

import { assertEquals } from "@std/assert";
import { resolveTeamDir } from "../daemon/start.ts";
import * as path from "@std/path";

Deno.test("TEAM_DIR may name the team directory, or its parent", () => {
  const parent = Deno.makeTempDirSync({ prefix: "mpt-start-test-" });
  try {
    const team = path.join(parent, ".my-pizza-team");
    // Its parent, before the team dir exists: used as given (it may be the team dir).
    assertEquals(resolveTeamDir(parent, "/elsewhere"), parent);
    Deno.mkdirSync(team);
    assertEquals(resolveTeamDir(parent, "/elsewhere"), team);
    assertEquals(resolveTeamDir(team, "/elsewhere"), team);
  } finally { Deno.removeSync(parent, { recursive: true }); }
});

Deno.test("unset: .my-pizza-team in the current directory", () => {
  assertEquals(resolveTeamDir(undefined, "/work/project"), path.join("/work/project", ".my-pizza-team"));
});
