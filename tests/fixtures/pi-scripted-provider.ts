/**
 * tests/fixtures/pi-scripted-provider.ts — a scripted, model-free model provider for Pi.
 *
 * Test-only. Loaded into a real `pi` with `-e <this file>` (tests/e2e/_pi.ts builds
 * the command), it registers the provider `mpt-mock` with one model, `scripted`, so
 * the e2e suite can run Pi with the real MPT extension (harnesses/pi) and make
 * **zero LLM calls**: every assistant turn is the next step of a JSON script. It is
 * to the Pi path what tests/fixtures/fake-acp-agent.ts is to the ACP one.
 *
 * ## The script
 *
 * A JSON file named by `MPT_E2E_SCRIPT` (absent = every turn gets the fallback text):
 *
 * ```json
 * {
 *   "leader":   [ Rule, ... ],
 *   "teammate": [ Rule, ... ],
 *   "default":  [ Rule, ... ]
 * }
 * ```
 *
 * The rules for this Pi's role are tried first, then `default`'s; the first that
 * matches answers. The role is `MPT_E2E_ROLE` if set, else read off Pi's own flags
 * (`--ppt-worker` → teammate, `--ppt-lead` → leader), else `default`.
 *
 * ```json
 * Rule = {
 *   "name"?:     "for the request log",
 *   "on"?:       "user" | "toolResult" | "latest",   // default "user"
 *   "contains"?: "a substring",
 *   "regex"?:    "a JS regex; its groups become {{match.N}} / {{match.<name>}}",
 *   "turns":     [ Turn, ... ]
 * }
 * Turn = {
 *   "text"?:      "prose (sent after any tool calls in the same message)",
 *   "toolCalls"?: [ { "name": "fail", "arguments": { "comment": "..." } } ],
 *   "usage"?:     { "input"?: n, "output"?: n, "cacheRead"?: n, "cacheWrite"?: n }
 * }
 * ```
 *
 * - `on` picks the message a rule is matched against: the latest user message, the
 *   latest tool result (only one that came after that user message), or `latest` —
 *   whichever of the two is newer. Default `user`, so a rule keyed on the prompt keeps
 *   playing through its run's tool results. A rule with neither `contains` nor `regex`
 *   always matches, so it makes a fallback.
 * - The turn played is `turns[n]`, where `n` counts the assistant messages since the
 *   matched message. So a rule matched on the user prompt plays its turns in order
 *   across one run (tool calls → tool results → next turn → … → final text); a rule
 *   matched on a tool result always plays its first turn. Past the end, the last
 *   turn is replayed if it is text-only, else a fixed "script exhausted" text ends
 *   the run — a script can't loop a tool call forever.
 * - Placeholders `{{...}}` in `text` and in any string inside `arguments` are filled
 *   from context: `{{role}}`, `{{turn}}`, `{{match.N}}` / `{{match.<name>}}` (the
 *   rule's regex groups — e.g. the task title from `## Task: (.+)`), and
 *   `{{env.NAME}}`. Unknown placeholders are left as written, so a test sees them.
 *
 * ## Usage
 *
 * Every turn reports token usage (default 1000 in / 50 out / 200 cache read, or the
 * turn's `usage`) and a cost from the model's (fake) per-million rates, so MPT's
 * usage ledger and cost paths are exercised. Default turn cost: $0.0117.
 *
 * ## Request log
 *
 * When `MPT_E2E_LOG` names a file, every request is appended to it as one JSON line:
 * `{ role, pid, rule, turn, systemPrompt, tools: [names], messages: [{ role, text }] }`,
 * so tests can assert on the persona, state framing, prompts and tool lists.
 *
 * Deterministic: no network, no timers. The response is produced synchronously from
 * the request (a microtask hop only, so the stream is returned before it fills).
 */

import * as fs from "node:fs";
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Model,
  type SimpleStreamOptions,
  type ToolCall,
  type TranscriptContext,
  type TranscriptMessage,
  type Usage,
} from "@earendil-works/pi-ai";

/** The provider and model ids, for `--provider` / `--model`. */
export const PROVIDER = "mpt-mock";
export const MODEL = "scripted";
/** The provider's API id (any unique string: the stream below is its only implementation). */
const API = "mpt-mock-scripted";

/** Fake per-million-token rates, so the default turn costs a recognizable $0.0117. */
const COST = { input: 10, output: 30, cacheRead: 1, cacheWrite: 0 };
const DEFAULT_USAGE = { input: 1000, output: 50, cacheRead: 200, cacheWrite: 0 };

/** What a turn says when no rule matched, or a run outlasted its script. */
const FALLBACK_TEXT = "mpt-mock: no script rule matched.";
const EXHAUSTED_TEXT = "mpt-mock: script exhausted.";

export interface ScriptTurn {
  text?: string;
  toolCalls?: Array<{ name: string; arguments?: Record<string, unknown> }>;
  usage?: Partial<typeof DEFAULT_USAGE>;
}

export interface ScriptRule {
  name?: string;
  on?: "user" | "toolResult" | "latest";
  contains?: string;
  regex?: string;
  turns: ScriptTurn[];
}

export type Script = Partial<Record<"leader" | "teammate" | "default", ScriptRule[]>>;

/** The structural slice of Pi's ExtensionAPI this file needs (Pi supplies the real one). */
interface ProviderHost {
  registerProvider(name: string, config: Record<string, unknown>): void;
}

/** Which script section this Pi plays: env first, then Pi's own MPT role flags. */
function detectRole(): "leader" | "teammate" | "default" {
  const env = process.env["MPT_E2E_ROLE"];
  if (env === "leader" || env === "teammate") return env;
  if (process.argv.includes("--ppt-worker")) return "teammate";
  if (process.argv.includes("--ppt-lead")) return "leader";
  return "default";
}

/** Read the script fresh on every request, so a test may rewrite it between turns. */
function loadScript(): Script {
  const file = process.env["MPT_E2E_SCRIPT"];
  if (!file) return {};
  return JSON.parse(fs.readFileSync(file, "utf8")) as Script;
}

/** A message's text: string content as is, text blocks joined, tool calls summarized. */
function messageText(m: TranscriptMessage): string {
  if (typeof m.content === "string") return m.content;
  return m.content.map((c) => {
    if (c.type === "text") return c.text;
    if (c.type === "toolCall") return `[toolCall ${c.name} ${JSON.stringify(c.arguments)}]`;
    return "";
  }).filter(Boolean).join("\n");
}

interface Selection {
  rule: ScriptRule | null;
  ruleLabel: string;
  turn: number;
  match: RegExpMatchArray | null;
}

/** Pick the rule and turn for this request (see the header for the algorithm). */
function select(rules: ScriptRule[], messages: TranscriptMessage[]): Selection {
  const lastUser = messages.findLastIndex((m) => m.role === "user");
  const lastTool = messages.findLastIndex((m, i) => m.role === "toolResult" && i > lastUser);
  for (const [i, rule] of rules.entries()) {
    const on = rule.on ?? "user";
    const at = on === "user" ? lastUser : on === "toolResult" ? lastTool : Math.max(lastUser, lastTool);
    if (at < 0) continue;
    const text = messageText(messages[at]!);
    let match: RegExpMatchArray | null = null;
    if (rule.contains !== undefined && !text.includes(rule.contains)) continue;
    if (rule.regex !== undefined) {
      match = text.match(new RegExp(rule.regex, "m"));
      if (!match) continue;
    }
    const turn = messages.slice(at + 1).filter((m) => m.role === "assistant").length;
    return { rule, ruleLabel: rule.name ?? `#${i}`, turn, match };
  }
  return { rule: null, ruleLabel: "(fallback)", turn: 0, match: null };
}

/** The turn a selection plays, applying the past-the-end rule. */
function turnFor(sel: Selection): ScriptTurn {
  if (!sel.rule || sel.rule.turns.length === 0) return { text: FALLBACK_TEXT };
  const turns = sel.rule.turns;
  if (sel.turn < turns.length) return turns[sel.turn]!;
  const last = turns[turns.length - 1]!;
  return last.toolCalls?.length ? { text: EXHAUSTED_TEXT } : last;
}

/** Fill `{{...}}` placeholders in every string of `value`. */
function fill<T>(value: T, vars: (key: string) => string | undefined): T {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, key: string) => vars(key) ?? whole) as T;
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, vars)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars)])) as T;
  }
  return value;
}

function usageFor(turn: ScriptTurn): Usage {
  const u = { ...DEFAULT_USAGE, ...turn.usage };
  const cost = {
    input: (u.input * COST.input) / 1e6,
    output: (u.output * COST.output) / 1e6,
    cacheRead: (u.cacheRead * COST.cacheRead) / 1e6,
    cacheWrite: (u.cacheWrite * COST.cacheWrite) / 1e6,
    total: 0,
  };
  cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
  return { ...u, totalTokens: u.input + u.output + u.cacheRead + u.cacheWrite, cost };
}

/** Append one request to the log (`MPT_E2E_LOG`), if asked for. */
function logRequest(entry: Record<string, unknown>): void {
  const file = process.env["MPT_E2E_LOG"];
  if (file) fs.appendFileSync(file, JSON.stringify(entry) + "\n");
}

let callSeq = 0;

/** The provider's stream: build the scripted assistant message, then emit it as Pi's events. */
function streamScripted(model: Model, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const role = detectRole();
  const base: AssistantMessage = {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: usageFor({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    stopReason: "pending", timestamp: Date.now(),
  };

  void (async () => {
    try {
      const script = loadScript();
      const rules = [...(script[role] ?? []), ...(script.default ?? [])];
      const messages = context.messages;
      const sel = select(rules, messages);
      const request = {
        role,
        pid: process.pid,
        rule: sel.ruleLabel,
        turn: sel.turn,
        systemPrompt: getCurrentSystemPrompt(messages),
        tools: getCurrentTools(messages).map((t) => t.name),
        messages: messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, text: messageText(m) })),
      };
      // Request instrumentation, as built-in providers do (docs/custom-provider.md).
      await options?.onPayload?.(request, model);
      logRequest(request);
      await options?.onResponse?.({ status: 200, headers: {} }, model);
      if (options?.signal?.aborted) throw Object.assign(new Error("aborted"), { aborted: true });

      const vars = (key: string): string | undefined => {
        if (key === "role") return role;
        if (key === "turn") return String(sel.turn);
        if (key.startsWith("match.")) {
          const k = key.slice(6);
          return /^\d+$/.test(k) ? sel.match?.[Number(k)] : sel.match?.groups?.[k];
        }
        if (key.startsWith("env.")) return process.env[key.slice(4)];
        return undefined;
      };
      const turn = fill(turnFor(sel), vars);

      const msg: AssistantMessage = { ...base, usage: usageFor(turn) };
      stream.push({ type: "start", partial: msg });
      for (const [i, call] of (turn.toolCalls ?? []).entries()) {
        const toolCall: ToolCall = { type: "toolCall", id: `mock_${process.pid}_${++callSeq}_${i}`, name: call.name, arguments: call.arguments ?? {} };
        msg.content.push(toolCall);
        const index = msg.content.length - 1;
        stream.push({ type: "toolcall_start", contentIndex: index, partial: msg });
        stream.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(toolCall.arguments), partial: msg });
        stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: msg });
      }
      if (turn.text !== undefined || !turn.toolCalls?.length) {
        const text = turn.text ?? "";
        msg.content.push({ type: "text", text });
        const index = msg.content.length - 1;
        stream.push({ type: "text_start", contentIndex: index, partial: msg });
        stream.push({ type: "text_delta", contentIndex: index, delta: text, partial: msg });
        stream.push({ type: "text_end", contentIndex: index, content: text, partial: msg });
      }
      msg.stopReason = turn.toolCalls?.length ? "toolUse" : "stop";
      stream.push({ type: "done", reason: msg.stopReason === "toolUse" ? "toolUse" : "stop", message: msg });
      stream.end();
    } catch (e) {
      const aborted = (e as { aborted?: boolean }).aborted === true;
      const error: AssistantMessage = { ...base, stopReason: aborted ? "aborted" : "error", errorMessage: (e as Error).message };
      stream.push({ type: "error", reason: aborted ? "aborted" : "error", error });
      stream.end();
    }
  })();

  return stream;
}

/** The extension factory: register the provider. Nothing else runs at load. */
export default function (pi: ProviderHost): void {
  pi.registerProvider(PROVIDER, {
    name: "MPT scripted mock",
    // Required when defining models; never sent anywhere.
    baseUrl: "http://mpt-mock.invalid",
    apiKey: "mpt-mock-no-auth",
    api: API,
    models: [{
      id: MODEL,
      name: "Scripted (no model)",
      reasoning: false,
      input: ["text"],
      cost: COST,
      contextWindow: 200_000,
      maxTokens: 8192,
    }],
    streamSimple: streamScripted,
  });
}
