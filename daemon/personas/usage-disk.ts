/**
 * daemon/personas/usage-disk.ts — The "Used by" inputs read straight from a team
 * directory, for code that doesn't hold a Store.
 *
 * The daemon computes a persona's "Used by" from its in-memory view
 * (`Store.getPersonaUsage`). `mpt plugins remove` (cli/plugins.ts) needs the same
 * answer from the CLI, which only has the files: it warns that removing a
 * package leaves references to its personas to fall back to built-ins
 * (docs/DESIGN.md "'Used by' and delete protection"). Both feed the one scan,
 * `personaUsage` (daemon/personas/resolve.ts), so they can't disagree about what
 * counts as a reference.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { TeamConfig, WorkflowConfig } from "../../shared/types.ts";
import { listWorkDefs } from "../store/workdefs.ts";
import { validateWorkflow } from "../workflow-engine.ts";
import type { PersonaUsageInput } from "./resolve.ts";

/** Per-mirror persona overrides: every source kv's `persona:<defId>` key (`sources/<id>.json`). */
export function listMirrorPersonaOverrides(teamDir: string): PersonaUsageInput["mirrorOverrides"] {
  const dir = path.join(teamDir, "sources");
  if (!fs.existsSync(dir)) return [];
  const out: PersonaUsageInput["mirrorOverrides"] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as Record<string, unknown>;
      for (const [key, value] of Object.entries(data)) {
        if (key.startsWith("persona:") && typeof value === "string" && value) {
          out.push({ workDefId: key.slice("persona:".length), source: name.slice(0, -5), persona: value });
        }
      }
    } catch { /* a malformed kv file has no overrides we can read */ }
  }
  return out;
}

/** The team's workflows as on disk (`workflows/<name>/workflow.json`); malformed ones are skipped. */
function readWorkflows(teamDir: string): Record<string, WorkflowConfig> {
  const dir = path.join(teamDir, "workflows");
  const out: Record<string, WorkflowConfig> = {};
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const wf = JSON.parse(fs.readFileSync(path.join(dir, entry.name, "workflow.json"), "utf8")) as WorkflowConfig;
      if (validateWorkflow(wf) === null) out[entry.name] = wf;
    } catch { /* missing or malformed: no references */ }
  }
  return out;
}

/**
 * Everything `personaUsage` scans, read from `teamDir`: workflows, the given
 * config (config.json as written), WorkDef frontmatter, and mirror overrides.
 */
export function readPersonaUsageInput(teamDir: string, config: Pick<TeamConfig, "triage" | "assistant" | "sourcePersonas">): PersonaUsageInput {
  return {
    workflows: readWorkflows(teamDir),
    config,
    workDefs: listWorkDefs(teamDir),
    mirrorOverrides: listMirrorPersonaOverrides(teamDir),
  };
}
