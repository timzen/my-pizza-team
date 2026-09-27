/**
 * daemon/spawner.ts — the daemon realizes spawn and dismiss itself.
 *
 * The second half of DESIGN.md "The Daemon Is the Supervisor" section's supervisor inversion. Until now the *leader* turned a
 * `spawn` directive into a tmux window, which meant adding a harness required
 * shipping extension code, and meant nothing could spawn while no leader was
 * connected. With the daemon doing it, a harness is a config entry and a teammate
 * needs no in-process code at all (Tier 0, DESIGN.md "Harness Tiers, and Why Not MCP").
 *
 * **The leader path is kept as a fallback, deliberately.** The daemon can only drive
 * tmux if it can reach it, and that is not guaranteed: started by `mpt start` it
 * inherits the user's environment, but under launchd/systemd it may have no `tmux` on
 * PATH and may see a different tmux server than the interactive one. So the daemon
 * probes once at startup; if it cannot spawn, directives stay `pending` and the
 * leader realizes them exactly as before. `mpt doctor` reports which path is live, so
 * this is a visible fact rather than spawns mysteriously not happening.
 */

import {
  DEFAULT_HARNESS,
  DEFAULT_HARNESS_TEMPLATES,
  isExperimentalHarness,
  type HarnessTemplates,
  type TeamConfig,
} from "../shared/types.ts";
import {
  killWindow,
  listWindows,
  realTmux,
  renderTemplate,
  sendControl,
  spawnWindow,
  type TmuxExec,
  tmuxUnavailableReason,
  unresolvedPlaceholders,
} from "./tmux.ts";

/** Why the daemon can't realize spawns, when it can't. */
export type SpawnCapability =
  | { canSpawn: true }
  | { canSpawn: false; reason: string; fix: string };

/**
 * Can this daemon process drive tmux?
 *
 * Checked once at startup rather than per spawn: the answer is a property of how the
 * daemon was launched, and re-probing on every attempt would turn one clear startup
 * message into repeated noise.
 */
export function probeSpawnCapability(config: TeamConfig, exec: TmuxExec = realTmux): SpawnCapability {
  const reason = tmuxUnavailableReason(exec);
  if (reason === "not-installed") {
    return {
      canSpawn: false,
      reason: "tmux is not on this process's PATH",
      fix: "install tmux, or start the daemon from a shell that has it (a leader will spawn teammates meanwhile)",
    };
  }
  if (reason === "not-permitted") {
    return {
      canSpawn: false,
      reason: "this process is not permitted to run tmux",
      fix: "run the compiled binary, or grant --allow-run",
    };
  }

  const harness = config.defaultHarness ?? DEFAULT_HARNESS;
  if (isExperimentalHarness(harness) && !config.experimental?.harnesses) {
    return {
      canSpawn: false,
      reason: `the default harness "${harness}" is experimental`,
      fix: `set "experimental": { "harnesses": true } in the team's config.json, or defaultHarness back to "pi"`,
    };
  }
  if (!resolveTemplates(config)[harness]?.teammate) {
    return {
      canSpawn: false,
      reason: `no teammate command configured for harness "${harness}"`,
      fix: `set harnesses.${harness}.teammate in the team's config.json`,
    };
  }
  return { canSpawn: true };
}

/** The built-in templates, with config's entries overriding them harness by harness. */
export function resolveTemplates(config: TeamConfig): Record<string, HarnessTemplates> {
  return { ...DEFAULT_HARNESS_TEMPLATES, ...config.harnesses };
}

/** A directive as the spawner needs to see it. */
export interface SpawnableDirective {
  id: string;
  action: string;
  memberId?: string;
  params: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/** What the spawner needs from the store, named so it can be faked in tests. */
export interface SpawnerStore {
  getLeaderDirectives(): SpawnableDirective[];
  updateLeaderDirective(id: string, status: string, error?: string): boolean;
  getMembers(): Array<{ name: string; status: string }>;
}

export interface RealizeDeps {
  config: TeamConfig;
  daemonUrl: string;
  /** Where a spawn lands when the directive names no cwd. */
  fallbackCwd: string;
  /** How to run this mpt, for templates using `{mpt}` (daemon/self.ts). */
  mpt?: string[];
  exec?: TmuxExec;
}

/**
 * Realize every pending directive the daemon can handle.
 *
 * `spawn` and `dismiss` are tmux work and become the daemon's. `reset-session` is
 * *left alone*: it types `/new` into an agent's window, which is harness-specific
 * behaviour (Pi's command), and the leader already does it correctly. Moving it here
 * would mean the daemon knowing each harness's slash commands — the coupling DESIGN.md "The Daemon Is the Supervisor"
 * removes, reintroduced.
 *
 * Returns what happened, for logging and tests.
 */
export function realizePending(
  store: SpawnerStore,
  deps: RealizeDeps,
): { realized: string[]; failed: Array<{ id: string; error: string }> } {
  const exec = deps.exec ?? realTmux;
  const realized: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  for (const directive of store.getLeaderDirectives()) {
    if (directive.action !== "spawn" && directive.action !== "dismiss") continue;
    try {
      if (directive.action === "spawn") realizeSpawn(directive, deps, exec, store);
      else realizeDismiss(directive, deps, exec);
      store.updateLeaderDirective(directive.id, "done");
      realized.push(directive.id);
    } catch (e) {
      // Marked failed rather than left pending: a directive retried forever would
      // spawn nothing and say nothing, which is the failure mode this replaces.
      const error = (e as Error).message;
      store.updateLeaderDirective(directive.id, "failed", error);
      failed.push({ id: directive.id, error });
    }
  }

  return { realized, failed };
}

function realizeSpawn(
  directive: SpawnableDirective,
  deps: RealizeDeps,
  exec: TmuxExec,
  store: SpawnerStore,
): void {
  const name = typeof directive.params.name === "string" ? directive.params.name : "";
  if (!name) throw new Error("spawn directive has no name (the daemon assigns one)");

  const cwd = typeof directive.params.cwd === "string" && directive.params.cwd
    ? directive.params.cwd
    : deps.fallbackCwd;

  // A cwd that doesn't exist would leave the agent in the shell's default directory,
  // silently working on the wrong thing — worth refusing.
  try {
    if (!Deno.statSync(cwd).isDirectory) throw new Error("not a directory");
  } catch {
    throw new Error(`spawn cwd ${cwd} is not a directory`);
  }

  // An online member already owns this name: nothing to do. Guards a retry that
  // arrives after the agent registered.
  if (store.getMembers().some((m) => m.name === name && m.status !== "offline")) return;

  const harness = typeof directive.params.harness === "string" && directive.params.harness
    ? directive.params.harness
    : deps.config.defaultHarness ?? DEFAULT_HARNESS;
  if (isExperimentalHarness(harness) && !deps.config.experimental?.harnesses) {
    throw new Error(`the "${harness}" harness is experimental — set experimental.harnesses: true in config.json`);
  }
  const template = resolveTemplates(deps.config)[harness]?.teammate;
  if (!template) throw new Error(`no teammate command configured for harness "${harness}"`);

  const session = deps.config.tmuxSession || "mpt";
  const command = renderTemplate(template, { mpt: deps.mpt, name, url: deps.daemonUrl, cwd, session, window: name });
  const unresolved = unresolvedPlaceholders(command);
  if (unresolved.length > 0) {
    throw new Error(`harness "${harness}" template has unknown placeholders: ${unresolved.join(", ")}`);
  }

  spawnWindow({ session, window: name, cwd, command }, exec);
}

function realizeDismiss(directive: SpawnableDirective, deps: RealizeDeps, exec: TmuxExec): void {
  const name = typeof directive.params.name === "string" && directive.params.name
    ? directive.params.name
    : (directive.metadata?.tmuxWindow as string | undefined) ?? "";
  if (!name) throw new Error("dismiss directive names no window");

  const session = (directive.metadata?.tmuxSession as string | undefined) || deps.config.tmuxSession || "mpt";
  if (!listWindows(session, exec).includes(name)) return; // already gone

  // Interrupt first so the agent can exit cleanly; the window is killed on the next
  // pass if it is still there. Killing immediately would cut off a final flush.
  sendControl(session, name, "C-c", exec);
  killWindow(session, name, exec);
}
