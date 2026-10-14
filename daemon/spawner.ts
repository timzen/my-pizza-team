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
  LEADER_WINDOW,
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
 * The full answer: tmux reachability (`probeTmuxCapability`) and then whether the
 * config names a spawnable default harness (`harnessCapability`).
 */
export function probeSpawnCapability(config: TeamConfig, exec: TmuxExec = realTmux): SpawnCapability {
  const tmux = probeTmuxCapability(exec);
  return tmux.canSpawn ? harnessCapability(config) : tmux;
}

/**
 * Can this daemon process drive tmux?
 *
 * Checked once at startup rather than per spawn: the answer is a property of how the
 * daemon was launched, and re-probing on every attempt would turn one clear startup
 * message into repeated noise.
 */
export function probeTmuxCapability(exec: TmuxExec = realTmux): SpawnCapability {
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
  return { canSpawn: true };
}

/**
 * Does the config name a default harness the daemon may spawn?
 *
 * Unlike tmux reachability this is a property of config, which `PUT /api/config`
 * changes live (Config → Teammates), so the daemon re-checks it every spawn pass
 * rather than only at startup — otherwise a team started with an inconsistent
 * config would stay leader-driven until a restart even after it was fixed.
 */
export function harnessCapability(config: TeamConfig): SpawnCapability {
  const harness = config.defaultHarness ?? DEFAULT_HARNESS;
  if (isExperimentalHarness(harness) && !config.experimental?.harnesses) {
    return {
      canSpawn: false,
      reason: `the default harness "${harness}" is experimental`,
      fix: `turn on Experimental harnesses (or set the default harness back to Pi) in Config → Teammates, or edit experimental.harnesses / defaultHarness in the team's config.json`,
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
  /** Has a dismissed agent exited (deregistered, or heard `dismissed`)? See Store.dismissedAgentExited. */
  dismissedAgentExited(memberId: string): boolean;
}

/**
 * How long a UI dismiss waits for the agent to exit by itself before its window is
 * interrupted anyway. Two realize passes (C-c, then kill) follow, so the window is
 * gone within ~30s of the dismiss even if the agent never answers.
 */
export const DISMISS_WAIT_MS = 25_000;

/** Minimum gap between a dismiss's C-c and its kill-window, so a final flush lands. */
export const DISMISS_KILL_DELAY_MS = 1_500;

/**
 * Windows interrupted (C-c sent) and awaiting their kill, by directive id → when.
 * In-memory: a daemon restart forgets it, and the next pass simply interrupts again.
 */
const defaultInterrupts = new Map<string, number>();

/** The parameters a dismiss directive carries; built by `dismissParams`. */
export interface DismissParams {
  [key: string]: unknown;
  memberId: string;
  /** The tmux window to close (the member's `tmuxWindow` metadata, else its name). */
  name: string;
  tmuxSession: string;
  /** Epoch ms after which the window is closed even if the agent hasn't exited. */
  deadline: number;
}

/**
 * The window a dismissed member lives in, from its registration metadata, falling
 * back to its name and the configured session (spawned windows are named after the
 * teammate). Null for the leader, whose window is never closed by a dismiss.
 */
export function dismissParams(
  member: { id: string; name: string; metadata?: Record<string, unknown> },
  config: Pick<TeamConfig, "tmuxSession">,
  now = Date.now(),
): DismissParams | null {
  const meta = member.metadata ?? {};
  const window = typeof meta.tmuxWindow === "string" && meta.tmuxWindow ? meta.tmuxWindow : member.name;
  const session = typeof meta.tmuxSession === "string" && meta.tmuxSession
    ? meta.tmuxSession
    : config.tmuxSession || "mpt";
  if (!window || window === LEADER_WINDOW) return null;
  return { memberId: member.id, name: window, tmuxSession: session, deadline: now + DISMISS_WAIT_MS };
}

/**
 * Is a dismiss directive ready to act on — its agent has exited, or its deadline has
 * passed? A directive without a member or deadline (one asked for directly) always is.
 * Shared with the leader-directives route, which holds dismissals back from a
 * leader-realized fallback until the same moment.
 */
export function dismissReady(
  directive: Pick<SpawnableDirective, "params">,
  store: Pick<SpawnerStore, "dismissedAgentExited">,
  now = Date.now(),
): boolean {
  const memberId = typeof directive.params.memberId === "string" ? directive.params.memberId : "";
  const deadline = typeof directive.params.deadline === "number" ? directive.params.deadline : 0;
  if (!memberId || !deadline) return true;
  return now >= deadline || store.dismissedAgentExited(memberId);
}

export interface RealizeDeps {
  config: TeamConfig;
  daemonUrl: string;
  /** Where a spawn lands when the directive names no cwd. */
  fallbackCwd: string;
  /** How to run this mpt, for templates using `{mpt}` (daemon/self.ts). */
  mpt?: string[];
  exec?: TmuxExec;
  /** Clock, injectable for tests. */
  now?: () => number;
  /** Dismiss interrupts in flight; injectable so tests don't share module state. */
  interrupts?: Map<string, number>;
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
      else if (realizeDismiss(directive, deps, exec, store) === "pending") continue;
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
    throw new Error(`the "${harness}" harness is experimental — turn on Experimental harnesses in Config → Teammates`);
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

/**
 * Close a dismissed agent's tmux window, over several passes.
 *
 * Spawn types the harness command into the window's shell, so when a dismissed
 * harness exits by itself the shell is left behind; this is what closes it. Each
 * pass does at most one step, and returns "pending" until the last:
 *
 *   1. wait until the agent has exited (or the deadline passes) — `dismissReady`;
 *   2. send C-c, so anything still running can exit cleanly;
 *   3. on a later pass, at least DISMISS_KILL_DELAY_MS on, kill the window.
 *
 * Never on the same pass as the C-c: killing immediately would cut off a final
 * flush. The leader's window is never killed, and a window already gone is done.
 */
function realizeDismiss(
  directive: SpawnableDirective,
  deps: RealizeDeps,
  exec: TmuxExec,
  store: SpawnerStore,
): "done" | "pending" {
  const interrupts = deps.interrupts ?? defaultInterrupts;
  const now = deps.now?.() ?? Date.now();
  const name = typeof directive.params.name === "string" && directive.params.name
    ? directive.params.name
    : (directive.metadata?.tmuxWindow as string | undefined) ?? "";
  if (!name) throw new Error("dismiss directive names no window");
  if (name === LEADER_WINDOW) throw new Error("refusing to close the leader's window");

  const session = (typeof directive.params.tmuxSession === "string" && directive.params.tmuxSession) ||
    (directive.metadata?.tmuxSession as string | undefined) || deps.config.tmuxSession || "mpt";
  if (!listWindows(session, exec).includes(name)) {
    interrupts.delete(directive.id);
    return "done"; // already gone (the user closed it, or tmux isn't running)
  }

  const interruptedAt = interrupts.get(directive.id);
  if (interruptedAt === undefined) {
    if (!dismissReady(directive, store, now)) return "pending";
    sendControl(session, name, "C-c", exec);
    interrupts.set(directive.id, now);
    return "pending";
  }
  if (now - interruptedAt < DISMISS_KILL_DELAY_MS) return "pending";

  killWindow(session, name, exec);
  interrupts.delete(directive.id);
  return "done";
}
