/**
 * shared/agent-protocol.ts — The agent-facing half of the HTTP protocol.
 *
 * What a harness needs to speak to the daemon: the protocol version it sends at
 * registration, the feature-toggle names (and the one wording for a switched-off
 * kind), and the shapes of the agent routes' replies (/api/agents/*,
 * /api/leader/directives, /api/assistant/inbox, the parts of /api/status a
 * harness reads).
 *
 * **Self-contained on purpose: no imports.** The Pi extension can't import
 * `shared/` — `mpt setup` writes it to a managed directory outside this repo — so
 * `npm run sync-shared` (scripts/sync-shared.ts) copies this file verbatim into
 * harnesses/pi/src/shared/agent-protocol.ts, and `npm run check` fails if the copy
 * drifts (docs/DESIGN.md "One Protocol, One Version"). A copy that imported
 * anything would not resolve there. `shared/protocol.ts` re-exports everything
 * here, so the daemon, CLI and UI see one definition.
 *
 * The types describe what a harness may rely on from any daemon it can register
 * with; where the daemon always sends more (e.g. `StatusResponse`),
 * `shared/protocol.ts` extends them. Generic parameters (`W`) stand in for the
 * workflow config, which a harness relays without inspecting.
 */

// ─── Protocol version ────────────────────────────────────────────────
// (Additive, optional routes — like POST /api/agents/:id/session-stats — are not
// a protocol change: an older harness simply never calls them.)

/**
 * The agent-protocol version this build speaks.
 *
 * **Bump this only on a breaking change to the agent protocol** — a route an
 * agent depends on moving or changing shape. Do *not* bump it for the release
 * version: the two are deliberately separate, because gating on build version
 * would nag the whole team on every patch release until people learned to ignore
 * the warning (docs/DESIGN.md "One Protocol, One Version").
 *
 * The daemon refuses to register an agent speaking a version it cannot serve, so
 * skew fails loudly at startup instead of silently half-working — the failure
 * mode docs/DESIGN.md "One Protocol, One Version" describes, where an old extension kept running
 * but streamed no transcript and recorded no usage. The harness sends this value
 * (harnesses/pi/src/runtime/client.ts reads the generated copy), so the two sides
 * can't disagree.
 *
 * History:
 *   1 — WorkItem-centric agent protocol, per-host leader directives.
 *   2 — Leader directives moved from /api/hosts/:hostId/leader/directives to
 *       /api/leader/directives (one leader, so no host key). P1c-1.
 *   3 — Readiness moved from POST /api/hosts/:hostId/readiness to
 *       POST /api/readiness, and is a team-level fact. P1c-3.
 *   4 — Host routing removed: register no longer takes hostId, and
 *       GET /api/hosts/:hostId is gone (use GET /api/config). P1c-2.
 *   5 — GET /api/assistant/inbox no longer returns `chat`: with one leader there
 *       is no chat-agent designation to report. P1c-4.
 *   6 — Every agent, teammates included, polls GET /api/agents/:id/directives
 *       and realizes `new-session` itself: a teammate reset from the web UI goes
 *       to the teammate, not through the leader typing `/new` into its tmux
 *       window. Became the floor (shared/protocol.ts MIN_PROTOCOL_VERSION) when
 *       the Pi leader stopped touching tmux: nothing realizes the legacy
 *       `reset-session` a v5 teammate needed, and a v5 leader still spawned its
 *       own windows. The same change added POST /api/agents/:id/focus (the
 *       leader's /ppt-hop), which is additive.
 */
export const PROTOCOL_VERSION = 6;

// ─── Feature toggles ─────────────────────────────────────────────────

/** A work-item kind the team can switch off in `config.features`. */
export type FeatureName = "stories" | "tasks" | "schedules";

/** Every switchable kind, in display order. */
export const FEATURE_NAMES: readonly FeatureName[] = ["stories", "tasks", "schedules"];

/** Which kinds are on, as `GET /api/status` reports them (defaults applied). */
export type Features = Record<FeatureName, boolean>;

/** A daemon too old to report `features` gates nothing, so treat it as all on. */
export const ALL_FEATURES_ON: Features = { stories: true, tasks: true, schedules: true };

const FEATURE_LABELS: Record<FeatureName, string> = {
  stories: "Stories are",
  tasks: "Tasks (and Templates) are",
  schedules: "Schedules are",
};

/**
 * The one wording for "this kind is switched off", shared by the CLI and every
 * agent tool so the user always gets the same fix: where to turn it back on.
 */
export function featureDisabledMessage(feature: FeatureName): string {
  return `${FEATURE_LABELS[feature]} disabled — enable them in Config (features.${feature})`;
}

/** The toggles from a status response, all on when the daemon didn't send any. */
export function featuresFromStatus(status: { features?: Partial<Features> } | null | undefined): Features {
  const f = status?.features ?? {};
  return { stories: f.stories !== false, tasks: f.tasks !== false, schedules: f.schedules !== false };
}

// ─── Status ──────────────────────────────────────────────────────────

/**
 * GET /api/status, as far as a harness reads it. The daemon sends more (see
 * shared/protocol.ts `StatusResponse`, which extends this).
 */
export interface StatusResponse<W = unknown> {
  stories: { total: number; open: number; done: number };
  tasks: { total: number; byStatus: Record<string, number> };
  members: { total: number; working: number; idle: number };
  defaultWorkflow: string;
  /** Workflow configs by name; a harness relays them without inspecting. */
  workflows: Record<string, W>;
  /** Which work-item kinds are on; absent from daemons that predate the toggles (read via `featuresFromStatus`). */
  features?: Partial<Features>;
}

// ─── Terminal location metadata ──────────────────────────────────────

/**
 * The registration-metadata keys an agent reports its window under. The values
 * come from the harness template's placeholders (`{terminal}`, `{terminalSession}`,
 * `{terminalWindow}`, `{terminalHandle}` — the daemon fills them when it opens the
 * window) and are reported back verbatim: a harness never interprets them. The
 * daemon reads the neutral keys first and falls back to the pre-herdr
 * `tmuxSession`/`tmuxWindow` (daemon/spawner.ts `memberTerminal`), so an agent
 * started by an older mpt is still dismissed and focused in the right place. Not a
 * protocol change: metadata is free-form, and an older daemon ignores keys it
 * doesn't read.
 */
export const TERMINAL_METADATA_KEYS = {
  /** Which backend the window is in (tmux or herdr; shared/types.ts TERMINAL_KINDS). */
  terminal: "terminal",
  /** The container label (tmux session, herdr workspace). */
  session: "terminalSession",
  /** The window label (tmux window, herdr tab). */
  window: "terminalWindow",
  /** The backend's own ID for the window (e.g. a herdr pane ID), a display/debug hint only. */
  handle: "terminalHandle",
  /** Pre-herdr: read by the daemon as a fallback, never written by a current harness. */
  legacySession: "tmuxSession",
  legacyWindow: "tmuxWindow",
} as const;

/**
 * The metadata a harness registers with for its window, from the values its
 * command line was given (neutral flags first, then the older `--*tmux-*` ones).
 * Empty values are left out, so a harness started by hand reports nothing.
 */
export function terminalMetadata(values: {
  terminal?: string;
  session?: string;
  window?: string;
  handle?: string;
  legacySession?: string;
  legacyWindow?: string;
}): Record<string, string> {
  const out: Record<string, string> = {};
  const session = values.session?.trim() || values.legacySession?.trim();
  const window = values.window?.trim() || values.legacyWindow?.trim();
  const terminal = values.terminal?.trim();
  const handle = values.handle?.trim();
  if (terminal) out[TERMINAL_METADATA_KEYS.terminal] = terminal;
  if (session) out[TERMINAL_METADATA_KEYS.session] = session;
  if (window) out[TERMINAL_METADATA_KEYS.window] = window;
  if (handle) out[TERMINAL_METADATA_KEYS.handle] = handle;
  return out;
}

// ─── Agents API (WorkItem-centric; see docs/DESIGN.md "The WorkItem") ─

/**
 * The `code` of a leader registration refused because another leader is live
 * (409). Only one leader may be connected — two would both answer the chat
 * (docs/DESIGN.md "One Host, One Leader") — so a second Pi that would be the
 * leader stays inactive instead. Telling "this process" from "another one" uses
 * the registration's optional `instanceId`: additive, so not a protocol bump.
 */
export const LEADER_ALREADY_CONNECTED = "leader_already_connected";

/** POST /api/agents/register */
export interface AgentRegisterResponse<W = unknown> {
  success: boolean;
  /** A typed refusal reason, e.g. `LEADER_ALREADY_CONNECTED` (with a 409). */
  code?: string;
  /** Present when registered; absent on a refusal (e.g. a 409 protocol mismatch). */
  config?: {
    defaultWorkflow: string;
    /** Workflow configs by name; a harness relays them without inspecting. */
    workflows: Record<string, W>;
    tmuxSession: string;
  };
  error?: string;
  /** The daemon's protocol version, so a harness can warn on its own side too. */
  protocolVersion?: number;
  /** The daemon's build version, for the UI's skew banner. Informational — never gated on. */
  daemonVersion?: string;
  /**
   * The model pinned on this agent by a user (a done `set-model` with source
   * `user`), or null for none. It outlives the harness session, so a harness
   * that declared `SET_MODEL_CAPABILITY` applies it from the start of every new
   * session (docs/DESIGN.md "Choosing a Model"). Additive: absent from an older
   * daemon, which means none.
   */
  modelPin?: string | null;
}

/** GET /api/agents/next-work?agentId=X */
export interface AgentNextWorkResponse {
  workItem: { id: string; title: string } | null;
}

/** POST /api/agents/claim/:workItemId */
export interface AgentClaimResponse {
  success: boolean;
  error?: string;
  /** Minimal bookkeeping id (the prose is in `prompt`). */
  workItem?: { id: string };
  /** Full assembled prompt from the daemon — delivered verbatim to the agent. */
  prompt?: string;
  /**
   * How this work finishes: `poll` when its board state is a poll state, so the
   * run may end with wait (`WAITED`) — offer the wait tool — else `once`.
   * Additive: absent from an older daemon, which means `once`.
   */
  completion?: "once" | "poll";
  /**
   * The role this run is worked in (docs/DESIGN.md "The persona in the system
   * prompt"): null when the work has none (a Solitary task with no persona).
   * Additive: absent from an older daemon, whose prompt always carries the role.
   */
  persona?: ClaimPersona | null;
  /**
   * Set when this claim is a failover revert probe (docs/DESIGN.md "Model
   * Failover"): a team-wide failover is active and its revert timer ran out, so
   * this one work item runs on the chain's primary model — `modelId`, resolved
   * for this harness — above every other choice (pin, persona, default, the
   * failover substitute). Its outcome decides the failover: a run whose model
   * call works ends it; a throttle/5xx re-arms the timer. Sent only to a harness
   * that declared `MODEL_FAILOVER_CAPABILITY`. Additive: absent means no probe.
   */
  failoverProbe?: { modelId: string };
}

/**
 * The capability a harness declares at registration (`capabilities` in the
 * POST /api/agents/register body) when it applies the claim's `persona` itself
 * — in its system prompt — so the daemon leaves the role block out of `prompt`
 * (docs/DESIGN.md "The persona in the system prompt"). A harness that doesn't
 * declare it gets the role inline, byte-identical to before. Additive both ways:
 * an older daemon ignores the field and sends no `persona`, so the role stays in
 * its prompt and the harness has nothing to add.
 */
export const PERSONA_SYSTEM_PROMPT_CAPABILITY = "persona-system-prompt";

/**
 * The capability a harness declares when it realizes the `set-model` directive
 * (`SET_MODEL_ACTION`) itself — between runs — and reports the models it can use
 * (`AvailableModel`). The daemon hands `set-model` only to an agent that
 * declared it; for any other the model routes answer "not supported by this
 * harness" (docs/DESIGN.md "Choosing a Model"). Additive both ways.
 */
export const SET_MODEL_CAPABILITY = "set-model";

/**
 * The capability a harness declares when it understands the team-wide model
 * failover (docs/DESIGN.md "Model Failover"): it applies a `set-model` with
 * source `failover` as a *substitution* — only while its resolved model (pin,
 * persona, team default or its own) is one of `SetModelParams.replaces` — and
 * honours a claim's `failoverProbe`. A harness with only `SET_MODEL_CAPABILITY`
 * applies a failover model unconditionally, so the daemon sends it one only
 * when that agent's model is a failed one, and never makes it a probe.
 */
export const MODEL_FAILOVER_CAPABILITY = "model-failover";

/** Every capability a harness may declare at registration. */
export type AgentCapability = typeof PERSONA_SYSTEM_PROMPT_CAPABILITY | typeof SET_MODEL_CAPABILITY | typeof MODEL_FAILOVER_CAPABILITY;

/**
 * A model the harness can use right now (configured, with credentials), as it
 * reports it at registration (`models`) and on change (POST
 * /api/agents/:id/models). Opaque to the daemon and the UI: `ref` is the string
 * this harness accepts back — in `set-model`, a pin, a model alias mapping
 * (Pi: `provider/id`) — and the rest is for display and for matching the
 * session's model (`MemberSessionStats.model`: same `id` and `provider`).
 */
export interface AvailableModel {
  /** What to send back to select it (Pi: `provider/id`). */
  ref: string;
  /** The harness's model id (as `MemberSessionStats.model.id`). */
  id: string;
  /** A display name (falls back to `id`). */
  name: string;
  /** Who serves it (as `MemberSessionStats.model.provider`); empty when the harness has no such notion. */
  provider: string;
}

/**
 * A persona's tool policy (frontmatter `tools`; docs/DESIGN.md "Persona
 * settings"). Each entry is a tool name, or a pattern where `*` matches any run
 * of characters (no other glob syntax), matched against the tool names *as the
 * harness sees them* (e.g. `read`, `mcp__server__*`). Absent `allow` = every
 * tool; an empty `allow` = none. `deny` wins over `allow`.
 */
export interface PersonaToolPolicy {
  allow?: string[];
  deny?: string[];
}

/** What a persona needs from its harness to run (frontmatter `requires`): checked, never started. */
export interface PersonaRequirements {
  /** MCP server names the persona's work depends on. */
  mcp?: string[];
}

/**
 * A persona's optional, harness-neutral settings (frontmatter `tools`,
 * `skills`, `model`, `requires`; docs/DESIGN.md "Persona settings"). Every field
 * is optional and absent means "the harness default"; how much of it a harness
 * enforces is up to the harness. Additive: an older daemon sends none, an older
 * harness ignores them.
 */
export interface PersonaSettings {
  /** Which tools the persona may use. */
  tools?: PersonaToolPolicy;
  /** The skill names the persona may use; absent = every skill, empty = none. */
  skills?: string[];
  /** A model alias the team config maps to a model; absent = the harness default. */
  model?: string;
  /** What the persona needs (e.g. MCP servers) — reported when missing. */
  requires?: PersonaRequirements;
}

/**
 * A claim's persona, resolved by the daemon (the same one the WorkItem records
 * as its in-flight persona), with its settings (`PersonaSettings`, when it has
 * any).
 */
export interface ClaimPersona extends PersonaSettings {
  /**
   * The resolved persona's id (a team id, `builtin:*`, or `<package>/<id>`); null
   * when a board state names no persona and its one-line framing stands in.
   */
  id: string | null;
  /** The persona's title; null with `id`. */
  title: string | null;
  /** The persona's body (raw markdown); null with `id`. */
  body: string | null;
  /** Board work: the workflow state being worked. */
  state?: string;
  /** Board work whose state names no persona: the one-line framing used instead. */
  stateFraming?: string;
  /**
   * The role block as the daemon renders it for the inline prompt (`## Your
   * Role…` plus the normalized body, trimmed): what a harness puts in its
   * system prompt, so every harness gives the model the same words.
   */
  prompt: string;
  /**
   * True when the role block is in the claim's `prompt` anyway — the harness
   * didn't declare `PERSONA_SYSTEM_PROMPT_CAPABILITY`, or a Work Source's prompt
   * hook kept it — so the harness must not add it again. False: the harness
   * owns it (system prompt) for this run.
   */
  inline: boolean;
  /**
   * The model id `model` (an alias) resolves to for the claiming harness
   * (shared/model-aliases.ts; team config `modelAliases`), present whenever
   * `model` is: null when the alias has no mapping for this harness (the
   * daemon says so on the run's thread) or the team switched persona models
   * off (`personaModels: false`). A harness that can switch models uses it for
   * this work item only. Additive: absent from an older daemon.
   */
  modelId?: string | null;
}

/**
 * POST /api/agents/work-items/:workItemId/state — the single state-setter.
 * The daemon reacts: COMPLETE advances a task ref; FAILED leaves it stuck;
 * WAITED (`{ state: "WAITED", reason }`, poll states only — see
 * `AgentClaimResponse.completion`) ends the check and leaves the task for the
 * next one. WAITED is additive: an older harness never sends it.
 */
export interface AgentSetWorkItemStateResponse {
  success: boolean;
  error?: string;
  newStatus?: string;
  completed?: boolean;
  /** Present (true) when a WAITED was accepted. */
  waited?: boolean;
  /** With `waited`: how many checks of this state have now ended with wait. */
  checks?: number;
  /** Present when a `sessionError` FAILED scheduled a retry. */
  retry?: { workItemId: string; attempt: number; maxAttempts: number; retryAt: string };
}

// ─── Activity (docs/DESIGN.md "Stalled Teammates") ──────────────────
//
// What a harness is doing, sent with every heartbeat — the heartbeat keeps
// flowing while a tool runs, so the daemon can tell "alive but stuck" (a hung
// `node --test` for 13 hours) from "busy". Additive: an older harness sends no
// activity, and the daemon falls back to the age of its session stats.

/** What the harness is doing: no run in flight, waiting on the model, or running a tool. */
export type AgentActivityState = "idle" | "model" | "tool";

/** The harness's current activity, as `POST /api/agents/heartbeat` carries it. */
export interface AgentActivity {
  state: AgentActivityState;
  /** With `tool`: the tool's name (e.g. `bash`). */
  tool?: string;
  /** When this state began (epoch ms). */
  since: number;
  /**
   * With `tool`: a short, single-line view of its input — for bash the
   * command, for a file tool the path, never file contents — at most
   * `ACTIVITY_PREVIEW_MAX` characters, secrets redacted (`cleanActivityPreview`).
   */
  preview?: string;
}

/** What a heartbeat adds to say what the agent is doing (all optional on the wire). */
export interface AgentActivityReport {
  activity: AgentActivity;
  /** The last time a model turn or a tool call completed (or a run started or ended), epoch ms. */
  lastProgressAt: number;
}

/** The longest activity preview, in characters (an ellipsis marks a cut). */
export const ACTIVITY_PREVIEW_MAX = 120;

/**
 * `NAME=value` assignments whose name says secret (`GITHUB_TOKEN=…`,
 * `AWS_SECRET_ACCESS_KEY=…`, `DB_PASSWORD=…`), `--token value` style flags, and
 * `Authorization: Bearer …` headers: the value becomes `***`.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?)[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/gi, "$1=***"],
  [/(--?(?:token|secret|password|passwd|api-?key|access-?key))([= ])("[^"]*"|'[^']*'|\S+)/gi, "$1$2***"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, "$1 ***"],
];

/**
 * An activity preview fit to show and store: whitespace (newlines included)
 * collapsed to single spaces, obvious secrets redacted, cut to
 * `ACTIVITY_PREVIEW_MAX` with an ellipsis. Run by the harness before sending and
 * again by the daemon on receipt, so a harness that forgot can't leak more.
 */
export function cleanActivityPreview(text: string): string {
  let out = text.replace(/\s+/g, " ").trim();
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out.length > ACTIVITY_PREVIEW_MAX ? `${out.slice(0, ACTIVITY_PREVIEW_MAX - 1)}…` : out;
}

// ─── Web pairing (docs/DESIGN.md "Watching and Pairing with a Teammate") ─

/** A release the teammate hasn't picked up yet: resume its work, or complete/fail it. */
export type PairingReleaseAction = "resume" | "complete" | "fail";

/** GET /api/agents/:id/pairing — a teammate's web-pairing intent (drained: each message and release once). */
export interface PairingPoll {
  paired: boolean;
  release: PairingReleaseAction | null;
  /** `queue` lands after the current run (Pi followUp); `steer` at the next tool step. */
  messages: Array<{ id: string; text: string; mode: "queue" | "steer"; at: number }>;
}

// ─── Live transcript (the watch view; docs/DESIGN.md "Watching and Pairing with a Teammate") ─
// Backfill is additive, not a protocol change: a daemon that accepts it says so
// in the watch poll, and a harness sends it only then; an older harness never
// sends one, and the view keeps its "watching from" marker.

/** GET /api/agents/:id/transcript/watch. */
export interface TranscriptWatchResponse {
  watched: boolean;
  /** This daemon accepts a backfill batch (absent from daemons that predate it). */
  backfill?: boolean;
}

/**
 * The `backfill` field of a POST /api/agents/:id/transcript batch: its entries
 * are the agent's current session so far, and *replace* the buffered transcript
 * (sent once, when a watching period starts). `omitted` counts the older entries
 * the agent left out to stay under its cap.
 */
export interface TranscriptBackfill {
  omitted: number;
}

// ─── Assistant inbox (the leader mirrors Pi <-> the daemon chat) ──────

/** Where a message came from: the web UI, the agent's terminal, the agent, the daemon. */
export type AssistantOrigin = "web" | "tui" | "agent" | "system";
/** Receipt states for a user message (null on assistant/system rows). */
export type AssistantDelivery = "queued" | "delivered" | "read";

/** One queued user message from GET /api/assistant/inbox. */
export interface AssistantInboxItem {
  id: string;
  content: string;
  /** Id of the message this one quotes, if any. */
  replyTo: string | null;
  /** Excerpt of the quoted message, so the agent sees what is being answered. */
  quoted: string | null;
  origin: AssistantOrigin;
  /**
   * The sender's choice for a run in flight — `queue` (followUp) or `steer` —
   * from the assistant's terminal-mode composer. Absent/null from the chat
   * composer, which is steered.
   */
  mode?: "queue" | "steer" | null;
}

/** GET /api/assistant/inbox?agentId= — user messages not yet handed to Pi (empty for a non-leader). */
export interface AssistantInboxResponse {
  messages: AssistantInboxItem[];
}

// ─── Directives (asks to do something about an agent) ────────────────

/**
 * A directive is an ask to do something about an agent. The daemon realizes
 * `spawn` and `dismiss` itself (it is the only terminal owner); the target agent
 * realizes `new-session` / `resume-session` and `set-model`.
 */
export interface LeaderDirective {
  id: string;
  action: string;
  /** Target member for actions on an existing agent (absent for spawn). */
  memberId?: string;
  /** Action params, e.g. spawn { name, cwd, storyId, reason }. */
  params: Record<string, unknown>;
  /** Target member's opaque metadata (e.g. tmux window), resolved for the realizer. */
  metadata: Record<string, unknown>;
  /** Only pending directives are listed; the rest are the states its realizer (the daemon or the agent) can set. */
  status: "pending" | "done" | "failed" | "cancelled";
  createdAt: string;
}

/** GET /api/leader/directives (and GET /api/agents/:id/directives) */
export interface LeaderDirectivesResponse {
  directives: LeaderDirective[];
}

/**
 * The directive asking an agent to switch its model (docs/DESIGN.md "Choosing a
 * Model"): realized by the agent itself, between runs — a run in flight is let
 * finish first — and marked `done`, or `failed` with the reason (an unknown or
 * unavailable model). Handed only to an agent that declared
 * `SET_MODEL_CAPABILITY`. Params: `SetModelParams`.
 */
export const SET_MODEL_ACTION = "set-model";

/**
 * Who asked for a model: `user` (a pin, which outlives the session and overrides
 * the persona's model; `model: null` clears it), `default` (the team default),
 * or `failover` (a substitute while the usual model is throttled or failing).
 */
export type SetModelSource = "user" | "failover" | "default";

/** The `params` of a `set-model` directive. `model` is an `AvailableModel.ref`, opaque to the daemon. */
export interface SetModelParams {
  /** The model to use, or null to clear this source's choice. */
  model: string | null;
  /** Why, for logs and the UI. */
  reason?: string;
  source: SetModelSource;
  /**
   * With source `failover`: the failed models this one stands in for. A harness
   * that declared `MODEL_FAILOVER_CAPABILITY` uses `model` only while the model
   * it would otherwise run is one of these (absent: always, the older meaning).
   */
  replaces?: string[];
}

// ─── Model error kinds (docs/DESIGN.md "Model Failover") ─────────────

/**
 * What kind of failure a run's model call hit, sent with a `sessionError`
 * (`errorKind`): `throttle` (429, rate limited), `5xx` (the service failed or
 * was unavailable), `auth` (credentials missing or expired), `context` (the
 * prompt didn't fit the model's context window), `other`. Only `throttle`,
 * `5xx` (and, if configured, `other`) can trip a failover; `auth` and
 * `context` stay with readiness and the normal failure path.
 */
export type ModelErrorKind = "throttle" | "5xx" | "auth" | "context" | "other";

/** Every `ModelErrorKind`, in display order. */
export const MODEL_ERROR_KINDS: readonly ModelErrorKind[] = ["throttle", "5xx", "auth", "context", "other"];

/** Is `value` a `ModelErrorKind`? */
export function isModelErrorKind(value: unknown): value is ModelErrorKind {
  return typeof value === "string" && (MODEL_ERROR_KINDS as readonly string[]).includes(value);
}

/**
 * Classify a model call's error from its text (and an HTTP status when the
 * caller has one) — the provider-neutral rule both sides share: a harness uses
 * it after its own, more precise checks, and the daemon falls back to it for a
 * harness that sends no `errorKind`. Throttle wins over 5xx (a 503 that says
 * "too many requests" is a throttle); context is checked before the generic
 * 4xx/auth words so a "too long" 400 is not read as auth.
 */
export function classifyModelError(text: string | null | undefined, status?: number | null): ModelErrorKind {
  const t = (text ?? "").toLowerCase();
  const code = typeof status === "number" ? status : statusInText(t);
  if (code === 429 || /throttl|too many requests|rate[ _-]?limit|rate exceeded|quota exceeded|slow down/.test(t)) return "throttle";
  if (/context (length|window)|maximum context|prompt is too long|too many tokens|input is too long|token limit|request_too_large/.test(t) || code === 413) return "context";
  if ((code !== null && code >= 500 && code <= 599) ||
      /service unavailable|unavailable|unable to process|internal server error|server error|overloaded|bad gateway|gateway time-?out|internal error|model stream error/.test(t)) return "5xx";
  if (code === 401 || code === 403 ||
      /unauthori[sz]ed|forbidden|access denied|accessdenied|credential|expired ?token|token (has )?expired|invalid api key|api key|not authenticated|authentication|security token/.test(t)) return "auth";
  return "other";
}

/** An HTTP status named in an error text ("API error (429)", "status 503", "503 Service…"), or null. */
function statusInText(t: string): number | null {
  const m = /\((\d{3})\)|status(?: code)?[ :=]+(\d{3})|^(\d{3})\b/.exec(t);
  const n = m ? Number(m[1] ?? m[2] ?? m[3]) : NaN;
  return n >= 400 && n <= 599 ? n : null;
}

/** POST /api/leader/directives */
export interface CreateLeaderDirectiveResponse {
  success: boolean;
  directive?: LeaderDirective;
  error?: string;
}
