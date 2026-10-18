/**
 * cli/node-choice.ts — Make sure a Node is saved for mpt, asking the user when needed.
 *
 * One function, `ensureNodeConfigured`, shared by `mpt setup`, `mpt install` and
 * `mpt upgrade`: each of them writes something that outlives this shell (a service
 * file, a global npm install), so each must know which Node will run mpt later.
 * The setting itself, its overrides and the checks live in shared/runtime-config.ts.
 *
 * The rules (story "Saved Node location"):
 *   - A valid saved/overridden Node is used as is (a `--node`/`MPT_NODE` override
 *     that differs from the file is saved, so the choice sticks).
 *   - Nothing saved: suggest `process.execPath` (or a stable spelling of it), let the
 *     user accept or type a path, validate, save.
 *   - No terminal, or `--yes`: take the override/suggestion without asking, say
 *     what was chosen, save it.
 *   - A saved Node that no longer works: ask again; with no terminal, fail clearly
 *     rather than write a service that cannot start.
 */

import * as readline from "node:readline/promises";
import {
  checkNode,
  configuredNode,
  describeNodeSource,
  pinnedNodeWarning,
  type NodeCheck,
  type NodeSource,
  readRuntimeConfig,
  runtimeConfigPath,
  saveConfiguredNode,
  stableNodeAlternative,
  suggestedNode,
} from "../shared/runtime-config.ts";

/** The Node mpt will run with, as settled by `ensureNodeConfigured`. */
export interface SettledNode {
  path: string;
  version: string;
  source: NodeSource;
}

export interface EnsureNodeOptions {
  /** Whether a terminal is available to prompt in (callers pass `process.stdin.isTTY`). */
  interactive: boolean;
  /** `--yes`: never prompt, take the override or current Node. */
  assumeYes?: boolean;
}

/** Injectable side effects, so tests can drive the flow without a terminal or real Node binaries. */
export interface EnsureNodeDeps {
  file: string;
  env: NodeJS.ProcessEnv;
  execPath: string;
  check: (node: string) => NodeCheck;
  ask: (question: string) => Promise<string>;
  log: (line: string) => void;
  now: () => Date;
  /** The stable-path candidates for suggestions/warnings (shared/runtime-config.ts STABLE_NODE_PATHS). */
  candidates?: string[];
}

/** Thrown when no usable Node can be settled on (the caller prints it and exits non-zero). */
export class NodeConfigError extends Error {}

/** Ask on the terminal. One readline per question, so nothing keeps stdin open afterwards. */
async function askOnTerminal(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

function defaultDeps(): EnsureNodeDeps {
  return {
    file: runtimeConfigPath(),
    env: process.env,
    execPath: process.execPath,
    check: checkNode,
    ask: askOnTerminal,
    log: (line) => console.log(line),
    now: () => new Date(),
  };
}

/**
 * Settle which Node runs mpt, prompting or saving as needed (see the module comment).
 * Resolves to the chosen Node; rejects with NodeConfigError when there is none.
 */
export async function ensureNodeConfigured(
  opts: EnsureNodeOptions,
  overrides: Partial<EnsureNodeDeps> = {},
): Promise<SettledNode> {
  const d = { ...defaultDeps(), ...overrides };
  const prompt = opts.interactive && !opts.assumeYes;
  const current = configuredNode({ env: d.env, file: d.file });
  const saved = readRuntimeConfig(d.file).node;
  const warnPinned = (node: string) => {
    const w = pinnedNodeWarning(node, stableNodeAlternative(d.candidates, d.check), d.env["HOME"]);
    if (w) d.log(`⚠️  ${w}`);
  };
  const save = (node: string) => {
    saveConfiguredNode(node, d.file, d.now());
    d.log(`   Saved to ${d.file}`);
  };

  if (current) {
    const result = d.check(current.path);
    if (result.ok) {
      if (current.source !== "file" && current.path !== saved) {
        d.log(`Using Node ${result.version} at ${current.path} (from ${describeNodeSource(current.source, d.file)}).`);
        save(current.path);
      }
      warnPinned(current.path);
      return { path: current.path, version: result.version, source: current.source };
    }
    // An explicit override that doesn't work is a typo to fix, not something to paper over.
    if (current.source !== "file") {
      throw new NodeConfigError(`${describeNodeSource(current.source, d.file)}: ${result.problem}`);
    }
    d.log(`⚠️  The saved Node no longer works: ${result.problem}`);
    if (!prompt && !opts.assumeYes) {
      throw new NodeConfigError(
        `The saved Node in ${d.file} no longer works (${result.problem}). ` +
          `Rerun in a terminal to choose another, or pass --node <path> (or --yes to use ${d.execPath}).`,
      );
    }
  }

  const suggestion = suggestedNode(d.execPath, { candidates: d.candidates, check: d.check, home: d.env["HOME"], pathVar: d.env["PATH"] ?? "" });
  if (!prompt) {
    const result = d.check(suggestion);
    if (!result.ok) throw new NodeConfigError(`Cannot use ${suggestion}: ${result.problem}. Pass --node <path>.`);
    d.log(`Using Node ${result.version} at ${suggestion} to run mpt.`);
    save(suggestion);
    warnPinned(suggestion);
    return { path: suggestion, version: result.version, source: "file" };
  }

  d.log("Which Node should run mpt (the service, teammates and upgrades use it)?");
  for (;;) {
    const answer = (await d.ask(`Node path [${suggestion}]: `)).trim();
    const choice = answer || suggestion;
    const result = d.check(choice);
    if (!result.ok) {
      d.log(`❌ ${result.problem}`);
      continue;
    }
    d.log(`Using Node ${result.version} at ${choice}.`);
    save(choice);
    warnPinned(choice);
    return { path: choice, version: result.version, source: "file" };
  }
}

/** `ensureNodeConfigured` for a CLI command: options from argv/stdin, and a clean exit on failure. */
export async function ensureNodeForCommand(args: string[]): Promise<SettledNode> {
  try {
    return await ensureNodeConfigured({
      interactive: Boolean(process.stdin.isTTY),
      assumeYes: args.includes("--yes") || args.includes("-y"),
    });
  } catch (e) {
    if (e instanceof NodeConfigError) {
      console.error(`❌ ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}
