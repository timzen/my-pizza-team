/**
 * field-help.ts — The one-line hints under the create/edit forms' fields, and
 * the cron preview beside a schedule (docs/DESIGN.md "Help Comes to You").
 *
 * Every non-obvious field — workflow, persona, directory, pending, the order
 * a story's tasks run in, cron, acceptance criteria, team size, and the
 * settings around them — says what it does right where you fill it in. The
 * copy lives here, not in each form, so the same field reads the same
 * everywhere and tests/field-help-ui.test.ts can hold it to "one short line"
 * and check that every "Learn more" lands on a real guide heading.
 * components/ui/field-hint.tsx renders a hint; the field points at it with
 * `aria-describedby` (`describedBy` joins it with an error's id).
 *
 * `describeCron` is the human-readable reading of a 5-field cron ("Every
 * weekday at 9:00") for the schedule form's preview and the Schedule list.
 * Dependency-free (only lib/help's types), so it's unit-tested directly.
 */

import type { HelpTopic } from "./help.ts";

/** One field's hint: a short sentence, and optionally the guide section that says more. */
export interface FieldHelp {
  /** One line, ending in a period: what the field does, not how to fill it in. */
  text: string;
  /** Where its "Learn more" opens the dock's Help panel (lib/help.ts `helpPath` terms). */
  learnMore?: { topic: HelpTopic; anchor?: string };
}

const PENDING_ANCHOR = "pending-write-first-run-when-its-right";

/**
 * Every hint, by field. Keep each to one short line (the test caps it): the
 * guide section behind "Learn more" is where the detail goes.
 */
export const FIELD_HELP = {
  // ─── Work: tasks, jobs, stories ───
  workflow: {
    text: "What happens after a teammate finishes each task: the review, commit or CR steps it goes through.",
    learnMore: { topic: "stories-and-workflows", anchor: "workflows" },
  },
  persona: {
    text: "How the teammate works: its role, voice and checklists. Optional; project knowledge belongs in the directory's AGENTS.md.",
    learnMore: { topic: "personas", anchor: "where-you-pick-one" },
  },
  scheduledPersona: {
    text: "How the teammate works on every run: its role, voice and checklists. Optional.",
    learnMore: { topic: "personas", anchor: "where-you-pick-one" },
  },
  directory: {
    text: "Where the work happens: the teammate works in this folder and reads its AGENTS.md. One teammate per directory at a time.",
    learnMore: { topic: "teammates", anchor: "one-teammate-per-directory" },
  },
  pending: {
    text: "Saved, but nothing runs until you activate it.",
    learnMore: { topic: "tasks-and-runs", anchor: PENDING_ANCHOR },
  },
  storyPending: {
    text: "Saved, but none of its tasks are handed out until you activate the story.",
    learnMore: { topic: "stories-and-workflows", anchor: "pending-stories" },
  },
  enqueueNow: {
    text: "Queue a run as soon as it's created. Off saves it to run later from its page.",
    learnMore: { topic: "tasks-and-runs", anchor: "standalone-tasks-and-scheduled-jobs" },
  },
  storyId: {
    text: "A short, unique name for the story's URL and the CLI, such as checkout-redesign.",
  },
  storyTasks: {
    text: "A story's tasks run in order, one at a time: each waits for the one before it.",
    learnMore: { topic: "stories-and-workflows", anchor: "managing-tasks" },
  },
  taskOrder: {
    text: "Added at the end of the story: it starts once the tasks before it are done.",
    learnMore: { topic: "stories-and-workflows", anchor: "managing-tasks" },
  },
  acceptanceCriteria: {
    text: "How you'll know it's done, one check per line. MUST, SHOULD and MAY make each one testable.",
    learnMore: { topic: "tasks-and-runs", anchor: "standalone-tasks-and-scheduled-jobs" },
  },
  cron: {
    text: "When it runs: minute hour day-of-month month day-of-week, with * for any. Times are the daemon's local time.",
    learnMore: { topic: "tasks-and-runs", anchor: "standalone-tasks-and-scheduled-jobs" },
  },

  // ─── Teammates ───
  teamSize: {
    text: "How many teammates the daemon keeps online, spawning replacements. Lowering it never dismisses anyone.",
    learnMore: { topic: "teammates", anchor: "team-size-how-teammates-get-created" },
  },
  minTeammates: {
    text: "Teammates the daemon keeps online, spawning replacements. Blank is half of Max Teammates; 0 spawns none.",
    learnMore: { topic: "teammates", anchor: "team-size-how-teammates-get-created" },
  },
  maxTeammates: {
    text: "The most teammates that may be online at once.",
  },
  spawnDirectory: {
    text: "Where this teammate lives: it picks up work homed there first. Blank uses the assistant's directory.",
    learnMore: { topic: "teammates", anchor: "one-teammate-per-directory" },
  },
  harness: {
    text: "Which agent program runs the teammate. Pi is the default; the others are experimental.",
    learnMore: { topic: "teammates", anchor: "experimental-kiro-and-claude-code-teammates" },
  },
  defaultHarness: {
    text: "Used for spawns that don't pick one, including the teammates the daemon keeps online.",
    learnMore: { topic: "teammates", anchor: "experimental-kiro-and-claude-code-teammates" },
  },
  exclusiveDirectories: {
    text: "While work runs in a directory, other work for it waits, so two teammates never edit one checkout.",
    learnMore: { topic: "teammates", anchor: "one-teammate-per-directory" },
  },
  nameNouns: {
    text: "Nouns for generated teammate names (adjective-noun). Empty uses the built-in list.",
  },

  // ─── Config → General ───
  defaultWorkflow: {
    text: "The workflow a new story starts with unless you pick another.",
    learnMore: { topic: "stories-and-workflows", anchor: "workflows" },
  },
  tmuxSession: {
    text: "The tmux session the teammates' windows open in.",
  },
  readinessProbe: {
    text: "A command run each heartbeat; while it exits non-zero, scheduled work is held.",
    learnMore: { topic: "configuration", anchor: "readiness-probe" },
  },
  agentEnvFile: {
    text: "A KEY=value file whose variables every new agent window gets, re-read at each spawn.",
    learnMore: { topic: "configuration", anchor: "agent-environment-file" },
  },

  // ─── Config → Triage ───
  triageEnabled: {
    text: "A teammate reads each note you've changed and proposes work for it.",
    learnMore: { topic: "thoughts-and-triage", anchor: "auto-triage-notes-that-become-work" },
  },
  triageInterval: {
    text: "How often changed notes are looked for. Takes effect when the daemon restarts.",
  },
  triageQuiet: {
    text: "How long a note is left alone after your last edit, so a half-written thought isn't read.",
  },
  triagePersona: {
    text: "What every note-triage run is told before the note itself.",
    learnMore: { topic: "personas", anchor: "where-you-pick-one" },
  },

  // ─── Config → Sources ───
  sourceWorkPersona: {
    text: "How a teammate works this source's items; one item can override it on its own page.",
    learnMore: { topic: "sources", anchor: "a-sources-tab" },
  },
  sourceTriagePersona: {
    text: "What a triage run of this source's items is told. Your notes' triage persona isn't used here.",
    learnMore: { topic: "sources", anchor: "triage-mode-sources" },
  },

  // ─── Persona editor ───
  personaId: {
    text: "How workflows, tasks and settings refer to it. Blank makes one from the title; fixed once created.",
  },
  personaDescription: {
    text: "One line, shown in the persona pickers.",
  },
  personaTags: {
    text: "Comma-separated words for filtering the library.",
  },
  personaKinds: {
    text: "Pickers for these list it first. A hint only: any persona can be picked anywhere.",
    learnMore: { topic: "personas", anchor: "the-library" },
  },
  personaInstructions: {
    text: "Injected into the prompt as written: role, voice, process. Project knowledge belongs in AGENTS.md.",
    learnMore: { topic: "personas", anchor: "the-library" },
  },
} satisfies Record<string, FieldHelp>;

/** A field with a hint. */
export type FieldHelpKey = keyof typeof FIELD_HELP;

/** The hint for `key`. */
export function fieldHelp(key: FieldHelpKey): FieldHelp {
  return FIELD_HELP[key];
}

/**
 * An `aria-describedby` value from the ids that apply — a hint's, an error's
 * when there is one — or undefined when none do (so the attribute is left off).
 */
export function describedBy(...ids: Array<string | false | null | undefined>): string | undefined {
  const list = ids.filter((id): id is string => typeof id === "string" && id.length > 0);
  return list.length ? list.join(" ") : undefined;
}

// ─── Cron, in words ─────────────────────────────────────────────────

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A whole number in [min, max], or null. */
function int(s: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= max ? n : null;
}

/** `*` + `/n`: a step from the start of the range, or null. */
function step(s: string, max: number): number | null {
  const m = /^\*\/(\d+)$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= max ? n : null;
}

/** "a", "a and b", "a, b and c". */
function andList(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** 1st, 2nd, 3rd, 4th … 21st, 22nd, 31st. */
function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/** `9:00`, `14:30` — a 24-hour clock, as the cron is written. */
function clock(hour: number, minute: number): string {
  return `${hour}:${String(minute).padStart(2, "0")}`;
}

/**
 * A day-of-week field as a sorted set of days (0 = Sunday; 7 also means
 * Sunday), from a number, a range (`1-5`), a list (`1,3,5`) or a mix — or null
 * for anything else (names, steps).
 */
function weekdays(field: string): number[] | null {
  const days = new Set<number>();
  for (const part of field.split(",")) {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const a = int(range[1]!, 0, 7), b = int(range[2]!, 0, 7);
      if (a === null || b === null || a > b) return null;
      for (let d = a; d <= b; d++) days.add(d % 7);
      continue;
    }
    const d = int(part, 0, 7);
    if (d === null) return null;
    days.add(d % 7);
  }
  return [...days].sort((x, y) => x - y);
}

/** How a schedule's days read: leading a sentence ("Every weekday") and after a repeat ("on weekdays"). */
interface DayPhrase { lead: string; tail: string }

/** The days part (day-of-month, month, day-of-week), or null when it's a shape we don't put in words. */
function dayPhrase(dom: string, month: string, dow: string): DayPhrase | null {
  if (dom !== "*" && dow !== "*") return null; // cron ORs them: too subtle for one line
  if (dow !== "*") {
    if (month !== "*") return null;
    const days = weekdays(dow);
    if (!days || days.length === 0) return null;
    const key = days.join(",");
    if (days.length === 7) return { lead: "Every day", tail: "" };
    if (key === "1,2,3,4,5") return { lead: "Every weekday", tail: " on weekdays" };
    if (key === "0,6") return { lead: "Every Saturday and Sunday", tail: " on weekends" };
    if (days.length === 1) return { lead: `Every ${DAY_NAMES[days[0]!]}`, tail: ` on ${DAY_NAMES[days[0]!]}s` };
    const names = andList(days.map((d) => DAY_NAMES[d]!));
    return { lead: `Every ${names}`, tail: ` on ${names}` };
  }
  if (dom !== "*") {
    const day = int(dom, 1, 31);
    if (day === null) return null;
    if (month === "*") return { lead: `On the ${ordinal(day)} of every month`, tail: ` on the ${ordinal(day)} of every month` };
    const m = int(month, 1, 12);
    if (m === null) return null;
    return { lead: `Every year on ${MONTH_NAMES[m - 1]} ${day}`, tail: ` on ${MONTH_NAMES[m - 1]} ${day}` };
  }
  if (month !== "*") {
    const m = int(month, 1, 12);
    return m === null ? null : { lead: `Every day in ${MONTH_NAMES[m - 1]}`, tail: ` in ${MONTH_NAMES[m - 1]}` };
  }
  return { lead: "Every day", tail: "" };
}

/**
 * The times part. `at` is a time of day ("9:00", "9:00 and 17:00") that
 * follows the days; `every` is a repeat ("Every 15 minutes") that leads them.
 */
type TimePhrase = { at: string } | { every: string };

function timePhrase(minute: string, hour: string): TimePhrase | null {
  const m = int(minute, 0, 59);
  if (m !== null) {
    if (hour === "*") return { every: m === 0 ? "Every hour" : `Every hour at :${String(m).padStart(2, "0")}` };
    const everyHours = step(hour, 23);
    if (everyHours !== null) {
      const base = everyHours === 1 ? "Every hour" : `Every ${everyHours} hours`;
      return { every: m === 0 ? base : `${base} at :${String(m).padStart(2, "0")}` };
    }
    const range = /^(\d+)-(\d+)$/.exec(hour);
    if (range) {
      const a = int(range[1]!, 0, 23), b = int(range[2]!, 0, 23);
      if (a === null || b === null || a >= b) return null;
      return { every: `Every hour from ${clock(a, m)} to ${clock(b, m)}` };
    }
    const hours = hour.split(",").map((h) => int(h, 0, 23));
    if (hours.some((h) => h === null)) return null;
    return { at: andList([...new Set(hours as number[])].sort((x, y) => x - y).map((h) => clock(h, m))) };
  }
  if (hour !== "*") return null;
  if (minute === "*") return { every: "Every minute" };
  const everyMinutes = step(minute, 59);
  if (everyMinutes !== null) return { every: everyMinutes === 1 ? "Every minute" : `Every ${everyMinutes} minutes` };
  return null;
}

/**
 * A 5-field cron in words — `0 9 * * 1-5` → "Every weekday at 9:00", a
 * 15-minute step → "Every 15 minutes", `0 2 1 * *` → "On the 1st of every
 * month at 2:00" — or null when it isn't a valid 5-field cron or is a shape
 * this doesn't phrase (the caller shows the raw expression then). Times are
 * 24-hour, as written; the daemon fires them in its local time.
 */
export function describeCron(cron: string | null | undefined): string | null {
  const fields = (cron ?? "").trim().split(/\s+/);
  if (fields.length !== 5 || fields[0] === "") return null;
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  const time = timePhrase(minute, hour);
  const days = dayPhrase(dom, month, dow);
  if (!time || !days) return null;
  if ("at" in time) return `${days.lead} at ${time.at}`;
  return `${time.every}${days.tail}`;
}

/**
 * What the schedule form's preview says under the cron field: the cron in
 * words ("Every weekday at 9:00."), or —
 * while it isn't one this can phrase — what to check.
 */
export function cronPreview(cron: string | null | undefined): string {
  const text = (cron ?? "").trim();
  if (!text) return "No schedule yet: pick a preset or type five fields.";
  const words = describeCron(text);
  if (words) return `${words}.`;
  if (text.split(/\s+/).length !== 5) return "Needs five fields, separated by spaces.";
  return "A custom schedule: check each field.";
}
