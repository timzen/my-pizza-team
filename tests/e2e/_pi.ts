/**
 * tests/e2e/_pi.ts — start commands for a real Pi on the scripted, model-free provider.
 *
 * The sandbox's `pi` on PATH is a version stub (_sandbox.ts), so these commands run
 * the Pi the extension is developed against — harnesses/pi's dev dependency — by
 * absolute path, with two extensions loaded explicitly: the real MPT extension
 * (harnesses/pi/src/index.ts, exactly as `mpt setup` would install it) and
 * tests/fixtures/pi-scripted-provider.ts, whose `mpt-mock/scripted` model answers
 * every turn from a JSON script instead of an LLM.
 *
 * They are drop-in `harnesses.pi` templates (TeamConfig.harnesses): the same flags
 * as DEFAULT_HARNESS_TEMPLATES, so the daemon fills `{url}`, `{name}` and the
 * terminal placeholders as usual. The script, the request log, and Pi's
 * no-network switches travel as environment assignments in front of the command,
 * since the window's shell doesn't inherit the test's environment.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_HARNESS_TEMPLATES, type HarnessTemplates } from "../../shared/types.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The Pi CLI of harnesses/pi's dev dependency (the version TESTED_PI_VERSION names). */
export const PI_CLI = path.join(REPO, "harnesses", "pi", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
/** The MPT extension's entry point, from source. */
export const MPT_EXTENSION = path.join(REPO, "harnesses", "pi", "src", "index.ts");
export const SCRIPTED_PROVIDER = path.join(REPO, "tests", "fixtures", "pi-scripted-provider.ts");

/** Can these commands run? Tests skip only when harnesses/pi's dependencies aren't installed. */
export function hasPi(): boolean {
  return fs.existsSync(PI_CLI);
}

/** Single-quote for /bin/sh. */
const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export interface ScriptedPiOptions {
  /** The script file (tests/fixtures/pi-scripted-provider.ts documents the format). */
  script: string;
  /** Where every request the provider gets is appended, one JSON line each. */
  log: string;
}

/** The command prefix: environment, then Pi with both extensions and the mock model. */
function piCommand(opts: ScriptedPiOptions): string {
  const env = [
    `MPT_E2E_SCRIPT=${q(opts.script)}`,
    `MPT_E2E_LOG=${q(opts.log)}`,
    // Pi's own background requests (catalog refresh, version check, telemetry).
    "PI_OFFLINE=1",
    "PI_SKIP_VERSION_CHECK=1",
    "PI_TELEMETRY=0",
  ].join(" ");
  return `${env} ${q(process.execPath)} ${q(PI_CLI)} -e ${q(MPT_EXTENSION)} -e ${q(SCRIPTED_PROVIDER)} --provider mpt-mock --model scripted`;
}

/**
 * `harnesses.pi` templates running the scripted Pi: the built-in templates' flags
 * (everything after their leading `pi`), behind `piCommand`.
 */
export function scriptedPiHarness(opts: ScriptedPiOptions): HarnessTemplates {
  const builtin = DEFAULT_HARNESS_TEMPLATES["pi"]!;
  const flags = (template: string) => template.replace(/^pi\s+/, "");
  return {
    teammate: `${piCommand(opts)} ${flags(builtin.teammate)}`,
    leader: `${piCommand(opts)} ${flags(builtin.leader!)}`,
  };
}

/** One request the provider logged (see pi-scripted-provider.ts "Request log"). */
export interface LoggedRequest {
  role: "leader" | "teammate" | "default";
  pid: number;
  rule: string;
  turn: number;
  systemPrompt: string;
  tools: string[];
  messages: Array<{ role: string; text: string }>;
}

/** Every request logged so far (none if the log doesn't exist yet). */
export function readRequestLog(file: string): LoggedRequest[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as LoggedRequest);
}
