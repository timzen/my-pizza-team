/**
 * daemon/leader-start.ts — start the leader (the assistant) in its terminal window.
 *
 * The one place that turns "start the assistant" into a window in the team's
 * terminal (tmux, or herdr — `TeamConfig.terminal`, daemon/terminal/): the harness's
 * `leader` template, rendered for the fixed `LEADER_WINDOW` in the project directory
 * (the team directory's parent), with the agent env file's variables. Two callers:
 * `POST /api/assistant/start` (the web UI's Start button, run by the daemon, which is
 * the only component that drives the terminal — docs/DESIGN.md "The Daemon Is the
 * Supervisor") and `mpt lead`, which adds its own messages and the attach on top.
 *
 * Starting is idempotent: an existing leader window is reported as
 * `already-running`, never duplicated — two leaders would both answer the chat
 * (docs/DESIGN.md "One Agent to Talk To"). Starting the leader is also what starts
 * the team, since the pool waits for it (docs/DESIGN.md "The team starts when its
 * leader does").
 *
 * Only *start*: there is deliberately no stop or restart here.
 */

import * as path from "node:path";
import { agentEnvWarning, loadAgentEnv } from "../shared/env-file.ts";
import { DEFAULT_HARNESS, LEADER_WINDOW, resolveTerminal, type TeamConfig, type TerminalKind } from "../shared/types.ts";
import { resolveTemplates, terminalChoiceCapability, type SpawnCapability } from "./spawner.ts";
import { getTerminalBackend } from "./terminal/index.ts";
import { renderTemplate, type TemplateVars, unresolvedPlaceholders } from "./terminal/template.ts";
import type { TmuxExec } from "./terminal/tmux.ts";
import type { HerdrExec, HerdrLaunch } from "./terminal/herdr.ts";

/** Whether the assistant can be started from here; when not, why and how to fix it. */
export type AssistantStartability =
  | { ok: true }
  | { ok: false; reason: string; fix: string };

/**
 * Where a started (or already running) leader is: its container and window labels,
 * the terminal it is in, and the command a user runs to see it
 * (`TerminalBackend.attachCommand`: `tmux attach -t mpt:leader`, `herdr`, …).
 */
interface LeaderWhere {
  session: string;
  window: string;
  /** The directory the leader runs in (the project directory). */
  cwd: string;
  terminal: TerminalKind;
  attach: string;
}

/** What a start attempt did. */
export type LeaderStartResult =
  | (LeaderWhere & {
    status: "started";
    /** Why the agent env file wasn't applied (the leader started without it), or null. */
    envWarning: string | null;
    /** The agent env file that was applied, or null when none is configured or it was unusable. */
    envPath: string | null;
    /** How many variables the agent env file gave the window (0 when not applied). */
    envKeys: number;
  })
  | (LeaderWhere & { status: "already-running" })
  | { status: "error"; code: LeaderStartErrorCode; reason: string; fix: string };

/**
 * Which check a start failed, so `mpt lead` can word its own messages while the
 * UI shows `reason` and `fix` as they are.
 */
export type LeaderStartErrorCode =
  | "terminal-unavailable" | "tmux-unavailable" | "no-template" | "unresolved-placeholders" | "tmux-failed";

/** What starting the leader needs, named so tests can inject a fake tmux. */
export interface LeaderStartDeps {
  /** The team's live config (harnesses, defaultHarness, tmuxSession, agentEnvFile). */
  config: TeamConfig;
  /** The team directory; the leader runs in its parent (the project directory). */
  teamDir: string;
  /** The daemon's URL, for the template's `{url}`. */
  daemonUrl: string;
  /** How to run this mpt, for a template using `{mpt}` (daemon/self.ts). */
  mpt?: string[];
  exec?: TmuxExec;
  /** A fake herdr for tests (and how it starts a server), like `exec` for tmux. */
  herdrExec?: HerdrExec;
  herdrLaunch?: HerdrLaunch;
  /**
   * Can this process drive the configured terminal? Named for history: the daemon
   * passes `Store.getTerminalCapability()` (tmux's startup probe, or herdr's probe).
   * Absent = reachable; `mpt lead` checks the backend itself.
   */
  tmux?: SpawnCapability;
  /**
   * Is a leader already connected to the daemon? Then it is `already-running`
   * whatever tmux shows — it may have been started by hand, in another session —
   * since a second one would also answer the chat. Absent = only the window counts.
   */
  leaderOnline?: boolean;
}

/** The team's container (tmux session, herdr workspace) the windows live in. */
export function leaderSession(config: TeamConfig): string {
  return config.tmuxSession || "mpt";
}

/** The project directory the leader runs in: the team directory's parent. */
export function leaderCwd(teamDir: string): string {
  return path.dirname(teamDir);
}

/**
 * Can the assistant be started, as far as can be told without starting it? The
 * configured terminal must be one mpt knows (`terminalChoiceCapability`) and
 * this process able to drive it (`tmux`: the configured terminal's capability), the default harness must have a `leader` template, and the
 * template must have no unknown placeholders. Cheap and side-effect free, so the
 * daemon reports it on every `/health` and `/api/teammate-pool` read, which is how
 * the UI decides between a Start button and the reason it can't offer one.
 */
export function assistantStartability(config: TeamConfig, tmux: SpawnCapability = { canSpawn: true }): AssistantStartability {
  const checked = checkTemplate(config, tmux, {
    // Placeholder values: only *which* placeholders are left unfilled matters here.
    name: LEADER_WINDOW, url: "http://localhost", cwd: "/", terminal: resolveTerminal(config),
    session: leaderSession(config), window: LEADER_WINDOW, mpt: ["mpt"],
  });
  return "command" in checked ? { ok: true } : { ok: false, reason: checked.reason, fix: checked.fix };
}

/**
 * Start the leader in `<tmuxSession>:leader` (a tmux window, or a herdr tab in the
 * workspace of that name), in the project directory — or report that it is already
 * running (its window exists with its agent, or `deps.leaderOnline`). Never throws:
 * the terminal unreachable, no leader template, an unknown placeholder, or the
 * terminal refusing the window are all `status: "error"` with a reason and a fix.
 * Either success says where it is and how to attach (`LeaderWhere`).
 *
 * The agent env file is re-read now and given to the window the same way the
 * spawner gives it to teammates (tmux `-e`, herdr `--env`; never typed into the shell). A bad file
 * doesn't stop the leader: it starts without it, and `envWarning` says why.
 */
export function startLeader(deps: LeaderStartDeps): LeaderStartResult {
  const terminal = getTerminalBackend(deps.config, { tmuxExec: deps.exec, herdrExec: deps.herdrExec, herdrLaunch: deps.herdrLaunch });
  const session = leaderSession(deps.config);
  const cwd = leaderCwd(deps.teamDir);
  const where: LeaderWhere = {
    session, window: LEADER_WINDOW, cwd, terminal: terminal.kind,
    attach: terminal.attachCommand(terminal.windowRef(session, LEADER_WINDOW)),
  };
  if (deps.leaderOnline) return { status: "already-running", ...where };
  const checked = checkTemplate(deps.config, deps.tmux ?? { canSpawn: true }, {
    name: LEADER_WINDOW, url: deps.daemonUrl, cwd, terminal: terminal.kind, session, window: LEADER_WINDOW, mpt: deps.mpt,
  });
  if (!("command" in checked)) return { status: "error", ...checked };

  try {
    // One call, idempotent by label: an existing leader window is `created: false`,
    // and nothing is typed into it. Deliberately not ensureContainer + listWindows
    // first: openWindow reuses a freshly created session's initial window instead of
    // leaving it stranded beside ours (it can only tell the session is fresh if it
    // creates it), and under herdr a tab a server restart restored *without* its
    // process isn't a running leader — openWindow runs the command into it
    // (docs/herdr.md "Restart: a label is not a live agent").
    const env = loadAgentEnv(deps.config, deps.teamDir);
    const envWarning = agentEnvWarning(env);
    const opened = terminal.openWindow({ session, window: LEADER_WINDOW, cwd, command: checked.command, env: env.vars });
    if (!opened.created) return { status: "already-running", ...where };
    return {
      status: "started",
      ...where,
      envWarning,
      envPath: envWarning ? null : env.path,
      envKeys: envWarning ? 0 : env.keys.length,
    };
  } catch (e) {
    return {
      status: "error",
      code: "tmux-failed",
      reason: `${terminal.displayName} could not open ${session}:${LEADER_WINDOW}: ${(e as Error).message}`,
      fix: `run \`mpt doctor\` to check ${terminal.displayName} and the daemon's ${terminal.displayName} server`,
    };
  }
}

/**
 * The checks both `assistantStartability` and `startLeader` make, in order: the
 * configured terminal known, this process able to drive it (`tmux` — despite the name, the
 * configured terminal's capability: tmux's startup probe or herdr's), a leader template for
 * the default harness, no unknown placeholders.
 * Returns the rendered command, or the first failure's reason and fix.
 *
 * Templates are the built-ins overridden harness by harness (`resolveTemplates`),
 * the same resolution the spawner uses, so a config that only sets
 * `harnesses.kiro` still leads with Pi's built-in leader template.
 */
function checkTemplate(
  config: TeamConfig,
  tmux: SpawnCapability,
  vars: TemplateVars,
): { command: string } | { code: LeaderStartErrorCode; reason: string; fix: string } {
  const terminal = terminalChoiceCapability(config);
  if (!terminal.canSpawn) return { code: "terminal-unavailable", reason: terminal.reason, fix: terminal.fix };
  if (!tmux.canSpawn) return { code: "tmux-unavailable", reason: tmux.reason, fix: tmux.fix };
  const harness = config.defaultHarness || DEFAULT_HARNESS;
  const template = resolveTemplates(config)[harness]?.leader;
  if (!template) {
    return {
      code: "no-template",
      reason: `no assistant command configured for harness "${harness}" (the assistant needs an in-process adapter; only some harnesses can run it)`,
      fix: `set harnesses.${harness}.leader in the team's config.json, or set the default harness back to Pi`,
    };
  }
  const command = renderTemplate(template, vars);
  const unresolved = unresolvedPlaceholders(command);
  if (unresolved.length > 0) {
    return {
      code: "unresolved-placeholders",
      reason: `the assistant's command template (harnesses.${harness}.leader) has unknown placeholders: ${unresolved.join(", ")}`,
      fix: `check harnesses.${harness}.leader in the team's config.json`,
    };
  }
  return { command };
}
