/**
 * tests/migrate.test.ts — Unit tests for the mpt upgrade migration.
 *
 * Tests non-destructive migration of legacy .pi-pizza-team/ directories
 * to the daemon's expected structure.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { existsSync } from "@std/fs";
import * as path from "@std/path";
import { migrate } from "../cli/migrate.ts";

function makeTempDir(): string {
  return Deno.makeTempDirSync({ prefix: "mpt-migrate-test-" });
}

Deno.test("migrate: creates default config when none exists", () => {
  const dir = makeTempDir();
  Deno.mkdirSync(dir, { recursive: true });

  const result = migrate(dir);

  assertEquals(result.alreadyCurrent, false);
  assertEquals(existsSync(path.join(dir, "config.json")), true);
  assertEquals(existsSync(path.join(dir, "workflows")), true);
  assertEquals(existsSync(path.join(dir, "stories")), true);

  Deno.removeSync(dir, { recursive: true });
});

Deno.test("migrate: migrates inline workflows to directory", () => {
  const dir = makeTempDir();

  // Write a legacy config with inline workflows
  const legacyConfig = {
    port: 7437,
    defaultWorkflow: "standard",
    workflows: {
      standard: {
        states: ["todo", "in_progress", "review", "done"],
        transitions: {
          todo: { in_progress: "any" },
          in_progress: { review: "teammate" },
          review: { done: "lead", in_progress: "lead" },
        },
      },
    },
    tmuxSession: "test",
    autosave: {
      flushIntervalMinutes: 30,
      commitIntervalHours: 24,
      commitMessage: "test",
      autoCommit: true,
    },
  };
  Deno.writeTextFileSync(path.join(dir, "config.json"), JSON.stringify(legacyConfig));

  const result = migrate(dir);

  // Workflow should be on disk now
  const wfFile = path.join(dir, "workflows", "standard", "workflow.json");
  assertEquals(existsSync(wfFile), true);

  const wf = JSON.parse(Deno.readTextFileSync(wfFile));
  assertEquals(wf.states, ["todo", "in_progress", "review", "done"]);

  // Config should no longer have inline workflows
  const updatedConfig = JSON.parse(Deno.readTextFileSync(path.join(dir, "config.json")));
  assertEquals(updatedConfig.workflows, undefined);

  // Backup should exist
  assertEquals(existsSync(path.join(dir, "config.json.backup")), true);

  // Should have action records
  const migrationActions = result.actions.join(" ");
  assertStringIncludes(migrationActions, "Migrated workflow");
  assertStringIncludes(migrationActions, "Backed up");

  Deno.removeSync(dir, { recursive: true });
});

Deno.test("migrate: handles deprecated singular workflow field", () => {
  const dir = makeTempDir();

  const legacyConfig = {
    port: 7437,
    defaultWorkflow: "default",
    workflow: {
      states: ["todo", "doing", "done"],
      transitions: {
        todo: { doing: "any" },
        doing: { done: "teammate" },
      },
    },
    tmuxSession: "test",
    autosave: {
      flushIntervalMinutes: 30,
      commitIntervalHours: 24,
      commitMessage: "test",
      autoCommit: true,
    },
  };
  Deno.writeTextFileSync(path.join(dir, "config.json"), JSON.stringify(legacyConfig));

  const result = migrate(dir);

  // Should move to workflows/default/workflow.json
  const wfFile = path.join(dir, "workflows", "default", "workflow.json");
  assertEquals(existsSync(wfFile), true);

  // Config should have workflow field removed
  const updatedConfig = JSON.parse(Deno.readTextFileSync(path.join(dir, "config.json")));
  assertEquals(updatedConfig.workflow, undefined);

  const actions = result.actions.join(" ");
  assertStringIncludes(actions, 'deprecated "workflow"');

  Deno.removeSync(dir, { recursive: true });
});

Deno.test("migrate: adds missing config fields", () => {
  const dir = makeTempDir();

  // Minimal config missing many fields
  Deno.writeTextFileSync(path.join(dir, "config.json"), JSON.stringify({ port: 8080 }));

  const result = migrate(dir);

  const config = JSON.parse(Deno.readTextFileSync(path.join(dir, "config.json")));
  assertEquals(config.port, 8080); // preserves existing
  assertEquals(config.defaultWorkflow, "default");
  assertEquals(typeof config.autosave, "object");
  assertEquals(config.autosave.flushIntervalMinutes, 30);
  assertEquals(typeof config.tmuxSession, "string");

  const actions = result.actions.join(" ");
  assertStringIncludes(actions, "defaultWorkflow");
  assertStringIncludes(actions, "autosave");

  Deno.removeSync(dir, { recursive: true });
});

Deno.test("migrate: migrates legacy instruction files", () => {
  const dir = makeTempDir();

  // Create config
  Deno.writeTextFileSync(path.join(dir, "config.json"), JSON.stringify({
    port: 7437,
    defaultWorkflow: "default",
    tmuxSession: "test",
    autosave: { flushIntervalMinutes: 30, commitIntervalHours: 24, commitMessage: "t", autoCommit: true },
  }));

  // Create legacy instructions directory
  const instrDir = path.join(dir, "instructions");
  Deno.mkdirSync(instrDir);
  Deno.writeTextFileSync(path.join(instrDir, "in_progress.md"), "## Working\nDo the thing.");
  Deno.writeTextFileSync(path.join(instrDir, "review.md"), "## Review\nCheck the thing.");

  const result = migrate(dir);

  // Instructions should be copied to workflows/default/
  assertEquals(existsSync(path.join(dir, "workflows", "default", "in_progress.md")), true);
  assertEquals(existsSync(path.join(dir, "workflows", "default", "review.md")), true);

  // Legacy dir renamed
  assertEquals(existsSync(path.join(dir, "instructions.migrated")), true);
  assertEquals(existsSync(path.join(dir, "instructions")), false);

  const actions = result.actions.join(" ");
  assertStringIncludes(actions, "Copied transition instruction");

  Deno.removeSync(dir, { recursive: true });
});

Deno.test("migrate: already current directory reports no changes", () => {
  const dir = makeTempDir();

  // Create a fully up-to-date structure
  Deno.writeTextFileSync(path.join(dir, "config.json"), JSON.stringify({
    port: 7437,
    defaultWorkflow: "default",
    tmuxSession: "test",
    autosave: { flushIntervalMinutes: 30, commitIntervalHours: 24, commitMessage: "t", autoCommit: true },
  }));
  Deno.mkdirSync(path.join(dir, "workflows", "default"), { recursive: true });
  Deno.writeTextFileSync(path.join(dir, "workflows", "default", "workflow.json"), "{}");
  Deno.mkdirSync(path.join(dir, "stories"));

  const result = migrate(dir);

  assertEquals(result.alreadyCurrent, true);
  assertEquals(result.actions.length, 0);

  Deno.removeSync(dir, { recursive: true });
});

Deno.test("migrate: non-existent directory produces warning", () => {
  const result = migrate("/tmp/nonexistent-mpt-test-dir-" + Date.now());
  assertEquals(result.warnings.length, 1);
  assertStringIncludes(result.warnings[0]!, "does not exist");
});
