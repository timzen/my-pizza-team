/**
 * daemon/spawner.ts — the daemon realizes spawn and dismiss itself.
 *
 * The second half of DESIGN.md "The Daemon Is the Supervisor" section's supervisor inversion. Until now the *leader* turned a
 * `spawn` directive into a tmux window, which meant adding a harness required
 * shipping extension code, and meant nothing could spawn while no leader was
 * connected. With the daemon doing it, a harness is a config entry and a teammate
 * needs no in-process code at all (Tier 0, DESIGN.md "Harness Tiers, and Why Not MCP").
 *
 * **The daemon is the only realizer.** There used to be a fallback: when the daemon
 * couldn't reach tmux (under launchd/systemd it may have no `tmux` on PATH, or see a
 * different tmux server), directives stayed `pending` and the leader realized them
 * with its own copy of the tmux code. That kept two places touching the terminal
 * multiplexer. Now a spawn the daemon can't realize is marked `failed` with the
 * capability's reason and fix — shown in the Team tab like any failed spawn — and a
 * dismiss's window close is failed the same way (the tombstone still makes the agent
 * exit). `mpt doctor` reports the capability, and the tmux server the daemon talks to,
 * so "nothing spawns" is always a visible, fixable fact (docs/DESIGN.md "The Daemon
 * Is the Supervisor").
 */

import * as fs from "node:fs";
import { agentEnvWarning, loadAgentEnv } from "../shared/env-file.ts";
import {
  DEFAULT_HARNESS,
  DEFAULT_HARNESS_TEMPLATES,
  isExperimentalHarness,
  isTerminalKind,
  LEADER_WINDOW,
  resolveTerminal,
  TERMINAL_METADATA_KEYS,
  type HarnessTemplates,
  type TeamConfig,
  type TerminalKind,
} from "../shared/types.ts";
import {
  createTerminalBackend,
  terminalOptions,
  type TerminalBackend,
  type TerminalBackendOptions,
  type TerminalStatus,
} from "./terminal/index.ts";
import type { HerdrExec, HerdrLaunch } from "./terminal/herdr.ts";
import { renderTemplate, unresolvedPlaceholders } from "./terminal/template.ts";
import { realTmux, type TmuxExec } from "./terminal/tmux.ts";

/** Why the daemon can't realize spawns, when it can't. */
export type SpawnCapability =
  | { canSpawn: true }
  | { canSpawn: false; reason: string; fix: string };

/**
 * Can this daemon process realize a spawn under `config`?
 *
 * The full answer: whether the config names a known terminal
 * (`terminalChoiceCapability`), whether this process can drive it
 * (`probeTerminalCapability` — tmux reachable, or herdr installed, new enough and
 * compatible), and a spawnable default harness (`harnessCapability`).
 */
export function probeSpawnCapability(
  config: TeamConfig,
  exec: TmuxExec = realTmux,
  opts: TerminalBackendOptions = {},
): SpawnCapability {
  const choice = terminalChoiceCapability(config);
  if (!choice.canSpawn) return choice;
  const backend = createTerminalBackend(resolveTerminal(config), terminalOptions(config, { tmuxExec: exec, ...opts }));
  const terminal = probeTerminalCapability(backend);
  return terminal.canSpawn ? harnessCapability(config) : terminal;
}

/**
 * Can this daemon process drive tmux?
 *
 * Checked once at startup rather than per spawn: the answer is a property of how the
 * daemon was launched, and re-probing on every attempt would turn one clear startup
 * message into repeated noise.
 */
export function probeTmuxCapability(exec: TmuxExec = realTmux): SpawnCapability {
  return probeTerminalCapability(createTerminalBackend("tmux", { tmuxExec: exec }));
}

/**
 * Can this daemon process drive `backend`? Its own reason and fix when it can't
 * (`TerminalBackend.unavailable`), so the message names the backend in use.
 */
export function probeTerminalCapability(backend: TerminalBackend): SpawnCapability {
  const unavailable = backend.unavailable();
  return unavailable ? { canSpawn: false, ...unavailable } : { canSpawn: true };
}

/**
 * Does the config name a terminal this version of mpt knows?
 *
 * A property of config, like `harnessCapability`, so re-checked on every use: the
 * Config page switches `terminal` live. Refuses an unknown value (a hand-edited
 * config.json) — never silently falling back to tmux, which would open windows
 * somewhere the user didn't choose. Whether the named backend can actually run here
 * is `probeTerminalCapability`'s question (cached per kind by
 * `cachedTerminalCapability`).
 */
export function terminalChoiceCapability(config: Partial<Pick<TeamConfig, "terminal">>): SpawnCapability {
  const configured: unknown = config.terminal;
  if (configured !== undefined && configured !== null && configured !== "" && !isTerminalKind(configured)) {
    return {
      canSpawn: false,
      reason: `the team's terminal ${JSON.stringify(configured)} is not one mpt knows (tmux, herdr)`,
      fix: 'set Terminal in Config → General, or "terminal" in the team\'s config.json, to "tmux"',
    };
  }
  return { canSpawn: true };
}

/** How long a non-tmux backend's capability probe is reused (`cachedTerminalCapability`). */
export const TERMINAL_PROBE_TTL_MS = 5_000;

/**
 * A capability probe for the configured terminal, cached for `ttlMs` per (kind,
 * herdr session).
 *
 * tmux is probed once at startup (`probeTmuxCapability`); herdr can't be, because
 * the Config page switches `terminal` live and herdr can be installed, upgraded or
 * its server restarted while the daemon runs. But the spawn capability is read on
 * every `/health`, team snapshot and pool pass, and each herdr probe is two process
 * spawns — so the answer is kept for a few seconds. `make` builds the backend
 * (tests: a fake exec).
 */
export function cachedTerminalCapability(
  ttlMs = TERMINAL_PROBE_TTL_MS,
  make: (config: Partial<TeamConfig>) => TerminalBackend = (config) =>
    createTerminalBackend(resolveTerminal(config), terminalOptions(config)),
  now: () => number = Date.now,
): (config: Partial<TeamConfig>) => SpawnCapability {
  const cache = new Map<string, { at: number; capability: SpawnCapability }>();
  return (config) => {
    const key = `${resolveTerminal(config)}\u0000${config.herdrSession ?? ""}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.capability;
    const capability = probeTerminalCapability(make(config));
    cache.set(key, { at: now(), capability });
    return capability;
  };
}

/**
 * The configured terminal's `TerminalStatus` (daemon/terminal/backend.ts), cached
 * for `ttlMs` per (kind, herdr session) like `cachedTerminalCapability`:
 * `/health` reports it on every read, and herdr's answer is several process spawns.
 * For a non-tmux backend only: tmux's is taken once at startup (daemon/start.ts).
 */
export function cachedTerminalStatus(
  ttlMs = TERMINAL_PROBE_TTL_MS,
  make: (config: Partial<TeamConfig>) => TerminalBackend = (config) =>
    createTerminalBackend(resolveTerminal(config), terminalOptions(config)),
  now: () => number = Date.now,
): (config: Partial<TeamConfig>) => TerminalStatus {
  const cache = new Map<string, { at: number; status: TerminalStatus }>();
  return (config) => {
    const key = `${resolveTerminal(config)}\u0000${config.herdrSession ?? ""}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.status;
    const status = make(config).describe();
    cache.set(key, { at: now(), status });
    return status;
  };
}

/**
 * Does the config name a default harness the daemon may spawn?
 *
 * Unlike tmux reachability this is a property of config, which `PUT /api/config`
 * changes live (Config → Teammates), so it is re-checked on every use (the Store's
 * `getSpawnCapability`) rather than only at startup — otherwise a team started with
 * an inconsistent config would stay unable to spawn until a restart even after it
 * was fixed.
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

/**
 * The parameters a dismiss directive carries; built by `dismissParams`. Stored with
 * the directive, so `realizeDismiss` also reads the pre-herdr shape (`tmuxSession`,
 * no `terminal`) a directive queued by an older daemon has.
 */
export interface DismissParams {
  [key: string]: unknown;
  memberId: string;
  /** The window to close (the member's window metadata, else its name). */
  name: string;
  /** The backend the window was started under — not the current config. */
  terminal: TerminalKind;
  /** The container the window is in. */
  terminalSession: string;
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
  config: Pick<TeamConfig, "tmuxSession" | "terminal">,
  now = Date.now(),
): DismissParams | null {
  const { terminal, session, window } = memberTerminal(member, config);
  if (!window || window === LEADER_WINDOW) return null;
  return { memberId: member.id, name: window, terminal, terminalSession: session, deadline: now + DISMISS_WAIT_MS };
}

/** Where a member's window is: which backend, which container, which window (and the backend's ID hint). */
export interface MemberTerminal {
  terminal: TerminalKind;
  session: string;
  window: string;
  /** The backend's own ID for the window, when the agent reported one. A hint; never used to find it. */
  handle?: string;
}

/** A non-empty string metadata value, else undefined. */
function metaString(meta: Record<string, unknown>, key: string): string | undefined {
  const v = meta[key];
  return typeof v === "string" && v ? v : undefined;
}

/**
 * The backend, container and window a member lives in, from its registration
 * metadata (the values spawn put in its command, reported back verbatim — the
 * harness never reads them; only the daemon does). shared/types.ts
 * `TERMINAL_METADATA_KEYS` names the keys.
 *
 *   - **window / session:** `terminalWindow`/`terminalSession`, else the pre-herdr
 *     `tmuxWindow`/`tmuxSession`, else the member's name in the configured
 *     container (spawned windows are named after the teammate).
 *   - **terminal:** the reported `terminal`; else tmux when the agent reported only
 *     the pre-herdr keys (everything before `terminal` was tmux); else the
 *     configured terminal. Deliberately *not* simply the current config: switching
 *     the team's terminal must not send a dismiss or focus to the wrong backend.
 */
export function memberTerminal(
  member: { name: string; metadata?: Record<string, unknown> },
  config: Pick<TeamConfig, "tmuxSession" | "terminal">,
): MemberTerminal {
  const meta = member.metadata ?? {};
  const K = TERMINAL_METADATA_KEYS;
  const window = metaString(meta, K.window) ?? metaString(meta, K.legacyWindow) ?? member.name;
  const session = metaString(meta, K.session) ?? metaString(meta, K.legacySession) ?? (config.tmuxSession || "mpt");
  const reported = meta[K.terminal];
  const legacy = metaString(meta, K.legacyWindow) !== undefined || metaString(meta, K.legacySession) !== undefined;
  const terminal: TerminalKind = isTerminalKind(reported) ? reported : legacy ? "tmux" : resolveTerminal(config);
  const handle = metaString(meta, K.handle);
  return { terminal, session, window, ...(handle ? { handle } : {}) };
}

/**
 * The backend kind recorded for each agent that is online under a terminal other
 * than the configured one — the windows a `terminal` switch leaves where they are.
 * Reported on `/health` and `GET /api/config` so the Config page and `mpt doctor`
 * can warn that the switch applies to new windows only. The leader counts too: it
 * keeps running where it was started.
 */
export function agentsOnOtherTerminal(
  members: Array<{ name: string; status: string; metadata?: Record<string, unknown> }>,
  config: Pick<TeamConfig, "tmuxSession" | "terminal">,
): Array<{ name: string; terminal: TerminalKind }> {
  const configured = resolveTerminal(config);
  return members
    .filter((m) => m.status !== "offline")
    .map((m) => ({ name: m.name, terminal: memberTerminal(m, config).terminal }))
    .filter((m) => m.terminal !== configured);
}

/**
 * Bring a member's window to the front of its container (`/ppt-hop`,
 * POST /api/agents/:id/focus), in the backend it was started under
 * (`memberTerminal`). The daemon does it because it is the only thing that touches
 * the terminal (docs/DESIGN.md "The Daemon Is the Supervisor"); the leader just
 * asks. Returns an error message when the window can't be selected (no such window,
 * a name the backend can't take, or the backend unreachable), else null.
 */
export function focusMember(
  member: { name: string; metadata?: Record<string, unknown> },
  config: Pick<TeamConfig, "tmuxSession" | "terminal" | "herdrSession">,
  exec: TmuxExec = realTmux,
  opts: TerminalBackendOptions = {},
): string | null {
  const { terminal: kind, session, window } = memberTerminal(member, config);
  const terminal = createTerminalBackend(kind, terminalOptions(config, { tmuxExec: exec, ...opts }));
  try {
    if (terminal.focusWindow(terminal.windowRef(session, window))) return null;
  } catch (e) {
    return (e as Error).message; // assertSafeName, or a backend that can't be used
  }
  return `no ${terminal.displayName} window ${session}:${window}`;
}

/**
 * Is a dismiss directive ready to act on — its agent has exited, or its deadline has
 * passed? A directive without a member or deadline (one asked for directly) always is.
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
  /**
   * The team directory, which a relative `agentEnvFile` is resolved against.
   * Absent = relative paths resolve against this process's cwd.
   */
  teamDir?: string;
  /** How to run this mpt, for templates using `{mpt}` (daemon/self.ts). */
  mpt?: string[];
  /** A fake tmux for tests; backends are `createTerminalBackend(kind, { tmuxExec })`. */
  exec?: TmuxExec;
  /** A fake herdr for tests (and how it starts a server), like `exec` for tmux. */
  herdrExec?: HerdrExec;
  herdrLaunch?: HerdrLaunch;
  /** Clock, injectable for tests. */
  now?: () => number;
  /** Dismiss interrupts in flight; injectable so tests don't share module state. */
  interrupts?: Map<string, number>;
  /**
   * Can this process reach tmux (`probeTmuxCapability`, probed once at startup)?
   * When it can't, every pending spawn and every dismiss of a tmux window is failed
   * with the reason and fix rather than left for anyone else. Absent = reachable.
   * A spawn also needs the configured terminal to be usable
   * (`terminalChoiceCapability`, checked per pass since config changes live).
   */
  tmux?: SpawnCapability;
}

/** A capability failure as one line for a directive's `error`: the reason, then the fix. */
export function capabilityError(capability: SpawnCapability): string | null {
  return capability.canSpawn ? null : `${capability.reason} — fix: ${capability.fix}`;
}

/**
 * Realize every pending directive the daemon can handle.
 *
 * `spawn` and `dismiss` are tmux work and are the daemon's alone: when tmux is
 * unreachable (`deps.tmux`) they are failed with its reason and fix, never left
 * pending — nothing else will realize them. A teammate reset isn't tmux work at
 * all: it is a `new-session` the teammate realizes itself. Any other action is
 * *left alone* — in particular nothing here types a harness's slash commands
 * into a window, which would mean the daemon knowing each harness's commands
 * (the coupling DESIGN.md "The Daemon Is the Supervisor" removes).
 *
 * Returns what happened, for logging and tests.
 */
export function realizePending(
  store: SpawnerStore,
  deps: RealizeDeps,
): { realized: string[]; failed: Array<{ id: string; error: string }>; warnings: string[] } {
  // New windows open in the configured terminal; a dismissed window closes in the
  // one it was started under (`dismissTerminal`), so each kind gets its own backend.
  const backends = new Map<TerminalKind, TerminalBackend>();
  const backendFor = (kind: TerminalKind): TerminalBackend => {
    let backend = backends.get(kind);
    if (!backend) {
      const opts = terminalOptions(deps.config, { tmuxExec: deps.exec, herdrExec: deps.herdrExec, herdrLaunch: deps.herdrLaunch });
      backends.set(kind, backend = createTerminalBackend(kind, opts));
    }
    return backend;
  };
  const realized: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  const warnings: string[] = [];

  const tmuxUnreachable = capabilityError(deps.tmux ?? { canSpawn: true });
  // Why a backend can't be used: tmux's startup probe, else the backend's own answer
  // (herdr: not installed, too old, an incompatible server), probed once per pass
  // and never re-probing tmux per directive.
  const probed = new Map<TerminalKind, string | null>();
  const unusable = (kind: TerminalKind): string | null => {
    if (kind === "tmux") return tmuxUnreachable;
    if (!probed.has(kind)) probed.set(kind, capabilityError(probeTerminalCapability(backendFor(kind))));
    return probed.get(kind)!;
  };

  for (const directive of store.getLeaderDirectives()) {
    if (directive.action !== "spawn" && directive.action !== "dismiss") continue;
    try {
      if (directive.action === "spawn") {
        const blocked = capabilityError(terminalChoiceCapability(deps.config)) ?? unusable(resolveTerminal(deps.config));
        if (blocked) throw new Error(`could not spawn: ${blocked}`);
        const warning = realizeSpawn(directive, deps, backendFor(resolveTerminal(deps.config)), store);
        if (warning) warnings.push(`spawn ${directive.id}: ${warning}`);
      } else {
        const kind = dismissTerminal(directive, deps.config);
        const blocked = unusable(kind);
        // A dismissed agent still exits (its tombstone answers its next heartbeat);
        // only closing its window needs the terminal, so that is what fails.
        if (blocked) throw new Error(`could not close the dismissed agent's window (the agent still exits): ${blocked}`);
        if (realizeDismiss(directive, deps, backendFor(kind), store) === "pending") continue;
      }
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

  return { realized, failed, warnings };
}

/**
 * Open one spawn directive's window. Returns a warning when the window opened
 * without the agent env file it should have had (missing/invalid file — never a
 * reason to fail the spawn), else null. Throws when the spawn itself can't happen.
 */
function realizeSpawn(
  directive: SpawnableDirective,
  deps: RealizeDeps,
  terminal: TerminalBackend,
  store: SpawnerStore,
): string | null {
  const name = typeof directive.params.name === "string" ? directive.params.name : "";
  if (!name) throw new Error("spawn directive has no name (the daemon assigns one)");

  const cwd = typeof directive.params.cwd === "string" && directive.params.cwd
    ? directive.params.cwd
    : deps.fallbackCwd;

  // A cwd that doesn't exist would leave the agent in the shell's default directory,
  // silently working on the wrong thing — worth refusing.
  try {
    if (!fs.statSync(cwd).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`spawn cwd ${cwd} is not a directory`);
  }

  // An online member already owns this name: nothing to do. Guards a retry that
  // arrives after the agent registered.
  if (store.getMembers().some((m) => m.name === name && m.status !== "offline")) return null;

  const harness = typeof directive.params.harness === "string" && directive.params.harness
    ? directive.params.harness
    : deps.config.defaultHarness ?? DEFAULT_HARNESS;
  if (isExperimentalHarness(harness) && !deps.config.experimental?.harnesses) {
    throw new Error(`the "${harness}" harness is experimental — turn on Experimental harnesses in Config → Teammates`);
  }
  const template = resolveTemplates(deps.config)[harness]?.teammate;
  if (!template) throw new Error(`no teammate command configured for harness "${harness}"`);

  const session = deps.config.tmuxSession || "mpt";
  const command = renderTemplate(template, {
    mpt: deps.mpt, name, url: deps.daemonUrl, cwd, terminal: terminal.kind, session, window: name,
  });
  const unresolved = unresolvedPlaceholders(command);
  if (unresolved.length > 0) {
    throw new Error(`harness "${harness}" template has unknown placeholders: ${unresolved.join(", ")}`);
  }

  // Re-read on every spawn, so an edit to the file reaches the next teammate with no
  // daemon or tmux-server restart (docs/DESIGN.md "The Agent Environment Is a File").
  const env = loadAgentEnv(deps.config, deps.teamDir ?? process.cwd());
  terminal.openWindow({ session, window: name, cwd, command, env: env.vars });
  return agentEnvWarning(env);
}

/**
 * The backend a dismiss directive's window was started under: the `terminal` its
 * params recorded (`dismissParams`), else the agent's metadata (`memberTerminal`
 * rules: a pre-herdr directive or agent is tmux), else the configured terminal for a
 * directive that names neither.
 */
export function dismissTerminal(
  directive: Pick<SpawnableDirective, "params" | "metadata">,
  config: Pick<TeamConfig, "tmuxSession" | "terminal">,
): TerminalKind {
  if (isTerminalKind(directive.params.terminal)) return directive.params.terminal;
  if (typeof directive.params.tmuxSession === "string" && directive.params.tmuxSession) return "tmux";
  return memberTerminal({ name: "", metadata: directive.metadata }, config).terminal;
}

/**
 * Close a dismissed agent's window, over several passes, in the backend it was
 * started under (`dismissTerminal`).
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
  terminal: TerminalBackend,
  store: SpawnerStore,
): "done" | "pending" {
  const interrupts = deps.interrupts ?? defaultInterrupts;
  const now = deps.now?.() ?? Date.now();
  const params = directive.params;
  const meta = directive.metadata ?? {};
  const K = TERMINAL_METADATA_KEYS;
  // The params dismissParams wrote (current, then pre-herdr names), else the agent's metadata.
  const name = metaString(params, "name") ?? metaString(meta, K.window) ?? metaString(meta, K.legacyWindow) ?? "";
  if (!name) throw new Error("dismiss directive names no window");
  if (name === LEADER_WINDOW) throw new Error("refusing to close the assistant's window");

  const session = metaString(params, "terminalSession") ?? metaString(params, K.legacySession) ??
    metaString(meta, K.session) ?? metaString(meta, K.legacySession) ?? (deps.config.tmuxSession || "mpt");
  if (!terminal.listWindows(session).includes(name)) {
    interrupts.delete(directive.id);
    return "done"; // already gone (the user closed it, or its server isn't running)
  }

  const interruptedAt = interrupts.get(directive.id);
  if (interruptedAt === undefined) {
    if (!dismissReady(directive, store, now)) return "pending";
    terminal.sendControl(terminal.windowRef(session, name), "C-c");
    interrupts.set(directive.id, now);
    return "pending";
  }
  if (now - interruptedAt < DISMISS_KILL_DELAY_MS) return "pending";

  terminal.closeWindow(terminal.windowRef(session, name));
  interrupts.delete(directive.id);
  return "done";
}
