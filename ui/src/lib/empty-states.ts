/**
 * empty-states.ts — What an empty list says, and when a list *is* empty
 * (docs/DESIGN.md "An Empty Screen Teaches").
 *
 * An empty screen is where a new user lands first, so it explains what goes
 * there and offers the next step — a one-sentence explanation, the real action
 * (open the create form, focus the chat, spawn a teammate), and "Learn more"
 * opening the guide section in the dock's Help panel. The copy lives here, not
 * in each page, so tests/empty-states-ui.test.ts can hold every explanation to
 * one sentence, check every "Learn more" lands on a real guide heading, and
 * check every entry is rendered somewhere. components/ui/empty-state.tsx renders
 * it (`<EmptyState kind="board" …>`).
 *
 * **Empty is not "no matches".** A list filtered or searched down to nothing
 * says "Nothing matches the filters." and offers to clear them — it must never
 * read like the truly-empty explanation, which would tell a user with fifty
 * stories to create their first. `listView` makes that call (and keeps both
 * off screen until the list's first answer, so a loading page never flashes
 * "nothing here"). `spawnState` is the Team tab's: can a teammate be started
 * right now, and if not, why (the daemon's spawn capability, the leader, the
 * readiness probe).
 *
 * Dependency-free (only lib/help's types), so it's unit-tested directly.
 */

import type { HelpTopic } from "./help.ts";

/** One list's empty state: a short title, one sentence on what goes there, and where to read more. */
export interface EmptyStateCopy {
  /** A few words, no period ("No stories yet"). `{label}` is replaced (see `emptyStateCopy`). */
  title: string;
  /** One sentence, ending in a period: what this list holds and how it gets filled. */
  text: string;
  /** Where "Learn more" opens the guide (lib/help.ts `helpPath` terms). */
  learnMore: { topic: HelpTopic; anchor?: string };
}

/** The line a list filtered or searched down to nothing shows instead of its empty state. */
export const NO_MATCHES_TEXT = "Nothing matches the filters.";

/**
 * Every list's empty state. Keep `text` to one sentence (the test caps it): the
 * guide section behind "Learn more" is where the detail goes.
 */
export const EMPTY_STATES = {
  inbox: {
    title: "Nothing has finished yet",
    text: "When a teammate finishes a run, its outcome lands here for you to review.",
    learnMore: { topic: "tasks-and-runs", anchor: "the-inbox" },
  },
  inboxZero: {
    title: "Inbox zero",
    text: "You've reviewed every finished run; new outcomes show up here as teammates finish them.",
    learnMore: { topic: "tasks-and-runs", anchor: "the-inbox" },
  },
  queue: {
    title: "Nothing in flight",
    text: "Work waiting for a teammate, or being worked on right now, shows up here until it finishes.",
    learnMore: { topic: "tasks-and-runs", anchor: "the-queue" },
  },
  board: {
    title: "No stories yet",
    text: "A story is a larger piece of work split into tasks that run in order, one at a time.",
    learnMore: { topic: "stories-and-workflows", anchor: "the-board" },
  },
  tasks: {
    title: "No tasks yet",
    text: "A standalone task is one-off work you define once and run whenever you like.",
    learnMore: { topic: "tasks-and-runs", anchor: "standalone-tasks-and-scheduled-jobs" },
  },
  schedule: {
    title: "No scheduled jobs yet",
    text: "A scheduled job runs on a cron schedule: the daemon queues a fresh run each time it fires.",
    learnMore: { topic: "tasks-and-runs", anchor: "standalone-tasks-and-scheduled-jobs" },
  },
  pending: {
    title: "Nothing pending",
    text: "Work saved as pending waits here, handed out to nobody, until you review it and activate it.",
    learnMore: { topic: "tasks-and-runs", anchor: "pending-write-first-run-when-its-right" },
  },
  archived: {
    title: "Nothing archived",
    text: "Archiving a story, task or job retires it here, out of the way but kept for reference.",
    learnMore: { topic: "tasks-and-runs", anchor: "the-work-tabs" },
  },
  thoughts: {
    title: "No notes yet",
    text: "Thoughts are your sticky notes: jot an idea down now, and turn it into work when it's ready.",
    learnMore: { topic: "thoughts-and-triage", anchor: "canvas" },
  },
  thoughtsList: {
    title: "No notes yet",
    text: "Thoughts are your sticky notes: jot an idea down now, and turn it into work when it's ready.",
    learnMore: { topic: "thoughts-and-triage", anchor: "list" },
  },
  source: {
    title: "Nothing mirrored from {label} yet",
    text: "Each sync pulls {label}'s work in as read-only items, and each new revision runs once.",
    learnMore: { topic: "sources", anchor: "a-sources-tab" },
  },
  team: {
    title: "No teammates online",
    text: "Teammates are the agents that pick up work; the leader, the assistant you chat with, starts them.",
    learnMore: { topic: "teammates", anchor: "team-size-how-teammates-get-created" },
  },
  usage: {
    title: "No usage recorded yet",
    text: "Every teammate run, assistant chat and pairing session is counted here, in tokens and cost.",
    learnMore: { topic: "teammates", anchor: "usage-what-the-team-costs" },
  },
  personas: {
    title: "No team personas yet",
    text: "A persona of your own sets how a teammate works; until you write one, the built-in ones below are used.",
    learnMore: { topic: "personas", anchor: "the-library" },
  },
  storyTasks: {
    title: "No tasks in this story yet",
    text: "Add the story's tasks in the order they should run: each starts once the one before it is done.",
    learnMore: { topic: "stories-and-workflows", anchor: "managing-tasks" },
  },
} as const satisfies Record<string, EmptyStateCopy>;

/** One list's key in EMPTY_STATES. */
export type EmptyStateKey = keyof typeof EMPTY_STATES;

/** A list's empty-state copy, with `{label}` (a source's name) filled in. */
export function emptyStateCopy(key: EmptyStateKey, vars: { label?: string } = {}): EmptyStateCopy {
  const copy: EmptyStateCopy = EMPTY_STATES[key];
  const fill = (s: string) => s.replaceAll("{label}", vars.label ?? "this source");
  return { ...copy, title: fill(copy.title), text: fill(copy.text) };
}

/** What a list should show: nothing yet (still loading), its empty state, "no matches", or its rows. */
export type ListView = "loading" | "empty" | "no-matches" | "list";

/**
 * Which of the four a list is in. `total` is how many it holds before any
 * filter or search, `shown` how many survive them; `loaded` is false until its
 * first answer (so neither message flashes while it loads).
 */
export function listView(opts: { loaded: boolean; total: number; shown: number }): ListView {
  if (!opts.loaded) return "loading";
  if (opts.total === 0) return "empty";
  return opts.shown === 0 ? "no-matches" : "list";
}

/** What `/health` reports that bears on starting a teammate (both optional: an older daemon may omit them). */
export interface SpawnHealth {
  /** Can the daemon start a teammate's tmux window (daemon/spawner.ts)? It is the only thing that does. */
  spawning?: { canSpawn: boolean; reason?: string; fix?: string };
  /** The readiness probe's last failure, or null while the team is ready. */
  notReady?: { ready: boolean; reason?: string } | null;
}

/** Can "Spawn a teammate" do anything right now, and what should the Team tab say about it? */
export interface SpawnState {
  /** A spawn request would be realized: the daemon can start it. */
  canSpawn: boolean;
  /** Why it can't (only when `canSpawn` is false), in words. */
  blockedReason?: string;
  /** The readiness probe is failing: a teammate can start, but no work is handed out until it passes. */
  notReadyReason?: string;
}

/**
 * Whether a spawn would happen, from `/health`. The daemon is the only thing that
 * realizes a spawn (docs/DESIGN.md "The Daemon Is the Supervisor"): when it can't
 * reach tmux, or the harness isn't spawnable, a request would only fail, so the
 * button is disabled with the daemon's reason and fix. A one-off spawn doesn't
 * need a leader. Before `/health` answers, nothing claims the daemon can't. A
 * failing readiness probe doesn't stop a spawn; it's reported so the user isn't
 * surprised that the new teammate gets no work.
 */
export function spawnState(health: SpawnHealth | null | undefined): SpawnState {
  const daemon = health?.spawning;
  const notReadyReason = health?.notReady && health.notReady.ready === false
    ? (health.notReady.reason || "the readiness probe is failing")
    : undefined;
  const ready = notReadyReason ? { notReadyReason } : {};
  if (!daemon || daemon.canSpawn) return { canSpawn: true, ...ready };
  const why = [daemon.reason, daemon.fix].filter(Boolean).join("; ");
  return {
    canSpawn: false,
    blockedReason: `The daemon can't start a teammate${why ? ` (${why})` : ""}.`,
    ...ready,
  };
}

/** The command that starts the leader, shown by Start the assistant's "Or from a terminal" (components/assistant/StartAssistant). */
export const LEADER_COMMAND = "mpt lead";
