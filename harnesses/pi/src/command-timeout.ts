// The default timeout for a teammate's bash calls (my-pizza-team docs/DESIGN.md
// "Stalled Teammates" — prevention, next to stall detection and Interrupt).
//
// The incident: a teammate ran `node --test … | grep …` through Pi's bash
// tool with no timeout, a test never settled, and the command slept for 13
// hours. Pi's bash tool takes an optional `timeout` (seconds) and has no
// default of its own, so in `tool_call` (whose `event.input` is mutable and
// reaches the execution) a call that sets none gets the team's default:
// `commandTimeoutMinutes` (60 unless config.json or the work's workflow state
// says otherwise; 0 = off). A timeout the model chose is never touched —
// shorter or longer. Calls another tool makes (codemode) go through the same
// hook and get the same default.
//
// When a defaulted command does time out, `tool_result` appends a note to
// Pi's "Command timed out after N seconds" error: the limit was MPT's
// default, not the model's, and how to ask for more (an explicit `timeout`).
//
// Pure apart from the pi.on wiring: the minutes come in through a getter (the
// work loop's claim-resolved value), so the tests drive it with a fake Pi.

import type { ExtensionAPI, ToolResultEventResult } from "@earendil-works/pi-coding-agent";

/** Pi's bash tool rejects a timeout above 2^31-1 ms; cap a huge default there. */
const MAX_TIMEOUT_SECONDS = Math.floor(2_147_483_647 / 1000);

/** The parts of a `tool_call` event this needs. */
export interface CommandToolCall {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
}

/** The parts of a `tool_result` event this needs. */
export interface CommandToolResult {
  toolName: string;
  toolCallId: string;
  isError: boolean;
  content: Array<{ type: string; text?: string }>;
}

/** The note appended to a defaulted command's timeout error. */
export function defaultTimeoutNote(minutes: number): string {
  return `[my-pizza-team] This was MPT's default command timeout (${minutes} min, team config \`commandTimeoutMinutes\`), ` +
    `applied because the call set no \`timeout\`. If the command legitimately needs longer, run it again with an explicit, ` +
    `larger \`timeout\` (in seconds); if it hung, find out why first (a test that never settles, a watch or serve mode).`;
}

/**
 * Applies the default timeout to bash calls and words its timeouts. One per
 * teammate; `minutes()` is read at each call, so a new claim's value applies
 * from its first command.
 */
export class CommandTimeoutDefault {
  /** Calls given the default, by tool call id → the minutes applied (cleared at their result or end). */
  private readonly defaulted = new Map<string, number>();
  /** The default in minutes for the call at hand (0 = off). */
  private readonly minutes: () => number;

  constructor(minutes: () => number) {
    this.minutes = minutes;
  }

  /**
   * `tool_call`: give a bash call with no `timeout` the default (seconds, as
   * Pi's bash takes it). Returns the seconds set, or null when nothing changed
   * (another tool, an explicit timeout, or the default is off).
   */
  onToolCall(event: CommandToolCall): number | null {
    if (event.toolName !== "bash" || event.input.timeout !== undefined) return null;
    const minutes = this.minutes();
    if (!(Number.isFinite(minutes) && minutes > 0)) return null;
    const seconds = Math.min(Math.max(1, Math.round(minutes * 60)), MAX_TIMEOUT_SECONDS);
    event.input.timeout = seconds;
    this.defaulted.set(event.toolCallId, minutes);
    return seconds;
  }

  /**
   * `tool_result`: when a defaulted call timed out, the result's content with
   * `defaultTimeoutNote` appended; otherwise undefined (the result stands).
   */
  onToolResult(event: CommandToolResult): { content: CommandToolResult["content"] } | undefined {
    const minutes = this.defaulted.get(event.toolCallId);
    if (minutes === undefined) return undefined;
    this.defaulted.delete(event.toolCallId);
    const timedOut = event.isError && event.content.some((c) => c.type === "text" && /Command timed out after \d+ seconds/.test(c.text ?? ""));
    if (!timedOut) return undefined;
    return { content: [...event.content, { type: "text", text: `\n\n${defaultTimeoutNote(minutes)}` }] };
  }

  /** `tool_execution_end`: forget a call (a blocked one never gets a result). */
  onToolEnd(toolCallId: string): void {
    this.defaulted.delete(toolCallId);
  }
}

/** Hook `timeouts` onto `pi`'s tool_call, tool_result and tool_execution_end. */
export function attachCommandTimeout(pi: ExtensionAPI, timeouts: CommandTimeoutDefault): CommandTimeoutDefault {
  pi.on("tool_call", async (event) => { timeouts.onToolCall(event as CommandToolCall); });
  // The appended block is text, like the content it extends.
  pi.on("tool_result", async (event) => timeouts.onToolResult(event) as ToolResultEventResult | undefined);
  pi.on("tool_execution_end", async (event) => { timeouts.onToolEnd(event.toolCallId); });
  return timeouts;
}
