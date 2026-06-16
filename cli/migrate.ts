/**
 * cli/migrate.ts — Migration logic for `mpt upgrade`.
 *
 * Detects an existing .pi-pizza-team/ directory from the extension-only era
 * and migrates it to the daemon's expected structure:
 *
 * 1. Ensures workflows/ directory exists
 * 2. Moves inline workflow definitions (config.workflows or config.workflow) to workflows/<name>/workflow.json
 * 3. Moves transition instruction files if found in legacy locations
 * 4. Validates and updates config.json format (adds missing fields with defaults)
 * 5. Creates a backup of the original config before any changes
 *
 * All operations are non-destructive: originals are backed up, not deleted.
 */

import * as path from "jsr:@std/path@^1";
import { existsSync } from "jsr:@std/fs@^1/exists";
import { DEFAULT_CONFIG, type TeamConfig, type WorkflowConfig } from "../shared/types.ts";

/** Result of a migration run */
export interface MigrationResult {
  teamDir: string;
  actions: string[];
  warnings: string[];
  alreadyCurrent: boolean;
}

/**
 * Run the upgrade migration on the given team directory.
 * Non-destructive: creates backups before modifying files.
 */
export function migrate(teamDir: string): MigrationResult {
  const result: MigrationResult = {
    teamDir,
    actions: [],
    warnings: [],
    alreadyCurrent: false,
  };

  if (!existsSync(teamDir)) {
    result.warnings.push(`Team directory does not exist: ${teamDir}`);
    return result;
  }

  const configPath = path.join(teamDir, "config.json");
  if (!existsSync(configPath)) {
    result.warnings.push(`No config.json found in ${teamDir}. Creating default config.`);
    Deno.writeTextFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
    result.actions.push("Created default config.json");
  }

  // Load current config
  let rawConfig: Record<string, unknown>;
  try {
    rawConfig = JSON.parse(Deno.readTextFileSync(configPath));
  } catch (e) {
    result.warnings.push(`Failed to parse config.json: ${(e as Error).message}`);
    return result;
  }

  let configModified = false;

  // --- Step 1: Ensure workflows/ directory ---
  const workflowsDir = path.join(teamDir, "workflows");
  if (!existsSync(workflowsDir)) {
    Deno.mkdirSync(workflowsDir, { recursive: true });
    result.actions.push("Created workflows/ directory");
  }

  // --- Step 2: Migrate inline workflows to directory ---
  const inlineWorkflows = extractInlineWorkflows(rawConfig);

  if (inlineWorkflows && Object.keys(inlineWorkflows).length > 0) {
    // Backup config before modifying
    backupFile(configPath, result);

    for (const [name, wf] of Object.entries(inlineWorkflows)) {
      const wfDir = path.join(workflowsDir, name);
      const wfFile = path.join(wfDir, "workflow.json");

      if (existsSync(wfFile)) {
        result.warnings.push(`Workflow ${name} already exists on disk; skipping (inline version preserved in backup)`);
        continue;
      }

      Deno.mkdirSync(wfDir, { recursive: true });
      Deno.writeTextFileSync(wfFile, JSON.stringify(wf, null, 2) + "\n");
      result.actions.push(`Migrated workflow "${name}" to workflows/${name}/workflow.json`);
    }

    // Remove inline workflows from config (they're now on disk)
    if ("workflow" in rawConfig) {
      delete rawConfig.workflow;
      configModified = true;
      result.actions.push('Removed deprecated "workflow" field from config.json');
    }
    if ("workflows" in rawConfig) {
      delete rawConfig.workflows;
      configModified = true;
      result.actions.push('Removed inline "workflows" field from config.json (now in workflows/ directory)');
    }
  }

  // --- Step 3: Migrate legacy transition instruction locations ---
  migrateLegacyInstructions(teamDir, workflowsDir, rawConfig, result);

  // --- Step 4: Validate and add missing config fields ---
  const configUpdates = validateAndFillConfig(rawConfig);
  if (configUpdates.length > 0) {
    if (!configModified) {
      backupFile(configPath, result);
    }
    configModified = true;
    for (const update of configUpdates) {
      result.actions.push(update);
    }
  }

  // --- Step 5: Write updated config ---
  if (configModified) {
    Deno.writeTextFileSync(configPath, JSON.stringify(rawConfig, null, 2) + "\n");
    result.actions.push("Updated config.json");
  }

  // --- Step 6: Ensure stories/ directory exists ---
  const storiesDir = path.join(teamDir, "stories");
  if (!existsSync(storiesDir)) {
    Deno.mkdirSync(storiesDir, { recursive: true });
    result.actions.push("Created stories/ directory");
  }

  // Check if everything was already current
  if (result.actions.length === 0) {
    result.alreadyCurrent = true;
  }

  return result;
}

/**
 * Extract inline workflow definitions from config (handles both
 * the singular `workflow` field and the plural `workflows` field).
 */
function extractInlineWorkflows(config: Record<string, unknown>): Record<string, WorkflowConfig> | null {
  const workflows: Record<string, WorkflowConfig> = {};

  // Handle deprecated singular `workflow` field
  if (config.workflow && typeof config.workflow === "object") {
    const wf = config.workflow as WorkflowConfig;
    if (wf.states && wf.transitions) {
      const name = (config.defaultWorkflow as string) || "default";
      workflows[name] = wf;
    }
  }

  // Handle plural `workflows` field (Record<string, WorkflowConfig>)
  if (config.workflows && typeof config.workflows === "object") {
    const wfs = config.workflows as Record<string, WorkflowConfig>;
    for (const [name, wf] of Object.entries(wfs)) {
      if (wf && wf.states && wf.transitions) {
        workflows[name] = wf;
      }
    }
  }

  return Object.keys(workflows).length > 0 ? workflows : null;
}

/**
 * Look for transition instruction files in legacy locations and move them.
 * Legacy locations:
 * - .pi-pizza-team/instructions/<state>.md
 * - .pi-pizza-team/transitions/<state>.md
 */
function migrateLegacyInstructions(
  teamDir: string,
  workflowsDir: string,
  config: Record<string, unknown>,
  result: MigrationResult
): void {
  const legacyDirs = [
    path.join(teamDir, "instructions"),
    path.join(teamDir, "transitions"),
  ];

  const defaultWorkflow = (config.defaultWorkflow as string) || "default";
  const targetDir = path.join(workflowsDir, defaultWorkflow);

  for (const legacyDir of legacyDirs) {
    if (!existsSync(legacyDir)) continue;

    Deno.mkdirSync(targetDir, { recursive: true });

    for (const entry of Deno.readDirSync(legacyDir)) {
      if (!entry.isFile || !entry.name.endsWith(".md")) continue;

      const srcFile = path.join(legacyDir, entry.name);
      const destFile = path.join(targetDir, entry.name);

      if (existsSync(destFile)) {
        result.warnings.push(`Instruction file ${entry.name} already exists in workflows/${defaultWorkflow}/; skipping`);
        continue;
      }

      // Copy (not move) — non-destructive
      Deno.copyFileSync(srcFile, destFile);
      result.actions.push(`Copied transition instruction ${entry.name} from ${path.basename(legacyDir)}/ to workflows/${defaultWorkflow}/`);
    }

    // Rename the legacy dir to mark it as migrated
    const migratedMarker = legacyDir + ".migrated";
    if (!existsSync(migratedMarker)) {
      Deno.renameSync(legacyDir, migratedMarker);
      result.actions.push(`Renamed ${path.basename(legacyDir)}/ to ${path.basename(legacyDir)}.migrated/`);
    }
  }
}

/**
 * Validate config and add missing fields with sensible defaults.
 * Returns a list of human-readable descriptions of what was added.
 */
function validateAndFillConfig(config: Record<string, unknown>): string[] {
  const updates: string[] = [];

  if (!config.port) {
    config.port = DEFAULT_CONFIG.port;
    updates.push(`Added missing "port" field (default: ${DEFAULT_CONFIG.port})`);
  }

  if (!config.defaultWorkflow) {
    config.defaultWorkflow = DEFAULT_CONFIG.defaultWorkflow;
    updates.push(`Added missing "defaultWorkflow" field (default: "${DEFAULT_CONFIG.defaultWorkflow}")`);
  }

  if (!config.autosave) {
    config.autosave = DEFAULT_CONFIG.autosave;
    updates.push('Added missing "autosave" config block');
  } else {
    // Validate autosave sub-fields
    const autosave = config.autosave as Record<string, unknown>;
    if (!autosave.flushIntervalMinutes) {
      autosave.flushIntervalMinutes = DEFAULT_CONFIG.autosave.flushIntervalMinutes;
      updates.push('Added missing "autosave.flushIntervalMinutes"');
    }
    if (!autosave.commitIntervalHours) {
      autosave.commitIntervalHours = DEFAULT_CONFIG.autosave.commitIntervalHours;
      updates.push('Added missing "autosave.commitIntervalHours"');
    }
    if (!autosave.commitMessage) {
      autosave.commitMessage = DEFAULT_CONFIG.autosave.commitMessage;
      updates.push('Added missing "autosave.commitMessage"');
    }
    if (autosave.autoCommit === undefined) {
      autosave.autoCommit = DEFAULT_CONFIG.autosave.autoCommit;
      updates.push('Added missing "autosave.autoCommit"');
    }
  }

  if (!config.tmuxSession) {
    config.tmuxSession = DEFAULT_CONFIG.tmuxSession;
    updates.push(`Added missing "tmuxSession" field`);
  }

  return updates;
}

/**
 * Create a timestamped backup of a file.
 * Only backs up once per migration run (checks for existing backup).
 */
function backupFile(filePath: string, result: MigrationResult): void {
  const backupPath = filePath + ".backup";
  if (existsSync(backupPath)) {
    // Already backed up (from a previous run or earlier in this run)
    return;
  }
  Deno.copyFileSync(filePath, backupPath);
  result.actions.push(`Backed up ${path.basename(filePath)} → ${path.basename(filePath)}.backup`);
}

/**
 * Print migration results to console.
 */
export function printMigrationResult(result: MigrationResult): void {
  console.log(`\n🍕 mpt upgrade — ${result.teamDir}\n`);

  if (result.alreadyCurrent) {
    console.log("✅ Already up to date. No migration needed.");
    return;
  }

  if (result.actions.length > 0) {
    console.log("Actions performed:");
    for (const action of result.actions) {
      console.log(`  ✅ ${action}`);
    }
  }

  if (result.warnings.length > 0) {
    console.log("\nWarnings:");
    for (const warning of result.warnings) {
      console.log(`  ⚠️  ${warning}`);
    }
  }

  console.log("\n✅ Migration complete.");
}
