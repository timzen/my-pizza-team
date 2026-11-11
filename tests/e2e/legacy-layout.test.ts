/**
 * tests/e2e/legacy-layout.test.ts — the daemon refuses a pre-0.36.0 team layout.
 *
 * Ported from mpt-demo-team's run-e2e.sh ("A pre-0.36.0 layout is refused").
 * tests/fixtures/demo/team-legacy is a team in the old layout (docs/DESIGN.md
 * "Upgrading from before 0.36.0"): a story's `paused` flag, a backlog/ story file,
 * a `draft: true` WorkDef and triage.md — plus a nested archived/<id>/story.json
 * leftover that must not count. `node daemon/main.ts` must exit non-zero with the
 * "install 0.36.x first" message naming every finding (and not the leftover), and
 * leave the team's files — and the port — as they were.
 *
 * (tests/e2e/cli-lifecycle.test.ts covers the same refusal through `mpt start` and
 * `mpt doctor` for an `archived/<id>.json` file.)
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "../_assert.ts";
import { sandbox } from "./_sandbox.ts";
import { demoTeam } from "./_demo.ts";

const DAEMON_MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "daemon", "main.ts");

/** Every file under `dir` with a hash of its contents, sorted. */
function snapshot(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name))
    .map((f) => `${path.relative(dir, f)} ${createHash("sha256").update(fs.readFileSync(f)).digest("hex")}`)
    .sort();
}

test("the daemon refuses the pre-0.36.0 demo layout, names every finding, and writes nothing", async () => {
  await using sb = await sandbox("legacy-layout");
  demoTeam(sb, { legacy: true });
  const before = snapshot(sb.teamDir);

  // The daemon from source, as run-e2e.sh ran it. It must exit by itself; the
  // deadline only turns a hang into a clear failure.
  const child = spawn(process.execPath, [DAEMON_MAIN], { env: sb.env, cwd: sb.projectDir, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => output += d);
  child.stderr.setEncoding("utf8").on("data", (d: string) => output += d);
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const code = await new Promise<number | null>((resolve) => child.once("close", (c) => resolve(c)));
  clearTimeout(timer);

  assert(code !== null && code !== 0, `the daemon started on the pre-0.36.0 layout (exit ${code}):\n${output}`);
  for (const expected of [
    "This team was last run on a version older than 0.36.0",
    "npm i -g my-pizza-team@0.36",
    "stories/add-user-auth.json",
    "backlog/polish-ui-theme.json",
    "tasks/add-user-auth-1/workdef.md",
    "triage.md",
  ]) assertStringIncludes(output, expected);
  assertEquals(output.includes("archived/old-story"), false, `the nested leftover was reported:\n${output}`);
  assertEquals(snapshot(sb.teamDir), before, "the refused start changed the team's files");
  const listening = await fetch(`http://127.0.0.1:${sb.port}/health`).then(() => true, () => false);
  assertEquals(listening, false, "something answers on the daemon's port after the refusal");
});
