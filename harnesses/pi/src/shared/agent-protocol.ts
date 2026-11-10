// GENERATED FILE — do not edit.
//
// Copied verbatim by scripts/sync-shared.ts from the repo root's
// shared/agent-protocol.ts, the single definition of the agent protocol. Edit it
// there and run `npm run sync-shared`; `npm run check` and the test suites fail
// if the two drift (docs/DESIGN.md "One Protocol, One Version").
//
// Copied rather than imported because the extension is a self-contained package:
// `mpt setup` writes it to a managed directory outside this repo.

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
}

/**
 * POST /api/agents/work-items/:workItemId/state — the single state-setter.
 * The daemon reacts: COMPLETE advances a task ref; FAILED leaves it stuck.
 */
export interface AgentSetWorkItemStateResponse {
  success: boolean;
  error?: string;
  newStatus?: string;
  completed?: boolean;
  /** Present when a `sessionError` FAILED scheduled a retry. */
  retry?: { workItemId: string; attempt: number; maxAttempts: number; retryAt: string };
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
 * realizes `new-session` / `resume-session`.
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

/** POST /api/leader/directives */
export interface CreateLeaderDirectiveResponse {
  success: boolean;
  directive?: LeaderDirective;
  error?: string;
}
