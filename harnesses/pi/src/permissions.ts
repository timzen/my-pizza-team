// Permission system integration for autonomous agents
//
// Uses @gotgenes/pi-permission-system's project-local config with dynamic
// yoloMode toggling. The permission system re-reads config at prompt time,
// so we can flip yoloMode on/off based on the agent's current state:
//   - Autonomous (working on task) → yoloMode: true (no prompts)
//   - Pairing (human hopped in)    → yoloMode: false (normal permissions)
//
// The **leader** (the chat agent) needs the same treatment for a different
// reason: a message sent from the web UI has nobody at the terminal to answer a
// prompt, so an `ask` doesn't just slow things down — it hangs the chat with no
// visible cause. See `registerChatAgentPermissions`.
//
// yoloMode alone is not enough as of pi-permission-system v24: its fail-closed
// bash wrapper floor clamps any `allow` (yolo-rewritten included) back to `ask`
// for indirection wrappers (`timeout`, `nohup`, `sudo`, `env`, `xargs`, ...) —
// "there is no way to auto-allow a wrapper" via policy. The sanctioned escape
// hatch is the authorizer chain: we register a live-authority link that
// answers those asks with `allow` while the agent is autonomous and `defer`
// (normal prompting) while pairing. The link is activated by naming it in the
// `authorizerChain` of the config we write; the chain owner caps its authority
// (an allow on the `path`/`external_directory` surfaces downgrades to defer).
//
// **One config file per directory, shared by every agent in it.** The permission
// system only reads `<cwd>/.pi/extensions/pi-permission-system/config.json` (plus
// the global one) — there is no per-process config. Pool teammates spawn in the
// leader's directory, so the leader and several teammates share one file. Each
// used to write it as if it owned it: the leader restored it "as found" on
// shutdown (deleting the teammates' config), typing in the leader's pane set
// `yoloMode: false` for everyone, and one teammate pairing un-yolo'd its
// autonomous siblings. `DirectoryPermissions` fixes that with a lease registry
// (a sidecar file next to the config): each agent leases the directory with
// what it wants, and the config is *composed* from the live leases:
//   - yolo is on while ANY live lease wants it — an unattended agent must never
//     be left stuck on a prompt nobody will answer. The cost: a human pairing in
//     a directory shared with autonomous agents is also in yolo (DESIGN.md §8).
//   - a teammate lease authors the full permissive map; a leader-only directory
//     only gets yoloMode + the chain link merged into the user's own config.
//   - when the last lease goes, the file is restored to how the first lease
//     found it (deleted if there was none), so a plain `pi` there later isn't
//     silently in yolo.
// Leases are keyed by pid (liveness-checked, so a crash can't pin yolo on), and
// each agent periodically re-asserts, which also self-heals a config deleted
// underneath it (e.g. a demo reset).

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PERMISSION_CONFIG_REL = ".pi/extensions/pi-permission-system/config.json";
/** Sidecar lease registry, next to the config it governs. */
const LEASES_REL = ".pi/extensions/pi-permission-system/ppt-leases.json";
/** How often a lease holder re-asserts the composed config (self-heal). */
const REASSERT_MS = 10_000;
/** A lock older than this is considered abandoned (holder crashed mid-write). */
const STALE_LOCK_MS = 2_000;

/** Operator-facing name of our authorizer chain link (referenced in config). */
export const AUTONOMOUS_AUTHORIZER = "ppt-autonomous";

/**
 * The permission system's cross-extension service slot on globalThis
 * (Symbol.for is process-global, surviving pi's per-extension module
 * isolation). Reading the slot directly avoids a hard dependency on
 * @gotgenes/pi-permission-system — if it isn't installed, the slot is empty
 * and we degrade gracefully.
 */
const PERMISSIONS_SERVICE_KEY = Symbol.for("@gotgenes/pi-permission-system:service");

/** Minimal untyped view of the cross-extension PermissionsService. */
interface PermissionsServiceLike {
  registerAuthorizer?: (
    name: string,
    authorize: (details: Record<string, unknown>, query: unknown, log: {
      review?: (event: string, details?: Record<string, unknown>) => void;
    }) => Promise<{ kind: "allow" } | { kind: "deny"; reason?: string } | { kind: "defer" }>,
  ) => () => void;
}

/**
 * Register the `ppt-autonomous` authorizer chain link: auto-allows `ask`
 * escalations (e.g. the bash indirection-wrapper floor on `timeout`/`nohup`
 * commands) while the agent is autonomous; defers to the normal prompt flow
 * while pairing. Registration is re-attempted on every `permissions:ready`
 * broadcast so it survives /reload and load-order differences.
 */
export function registerAutonomousAuthorizer(pi: ExtensionAPI, getIsAutonomous: () => boolean): void {
  let dispose: (() => void) | null = null;

  const register = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped cross-extension boundary
    const service = (globalThis as any)[PERMISSIONS_SERVICE_KEY] as PermissionsServiceLike | undefined;
    if (!service?.registerAuthorizer) return; // permission system not installed/published

    // A fresh service is published per session; drop any stale registration
    // before re-registering (duplicate names throw).
    try { dispose?.(); } catch { /* stale disposer from a torn-down session */ }
    dispose = null;
    try {
      dispose = service.registerAuthorizer(AUTONOMOUS_AUTHORIZER, async (details, _query, log) => {
        if (getIsAutonomous()) {
          // Durable audit trail: one review entry per auto-allowed ask.
          log?.review?.("ppt.autonomous_auto_allow", {
            toolName: details?.toolName,
            command: details?.command,
          });
          return { kind: "allow" };
        }
        return { kind: "defer" }; // pairing — let the human answer
      });
    } catch {
      dispose = null; // name already registered by a live instance — leave it
    }
  };

  // The service publishes at session_start and broadcasts permissions:ready
  // right after; also try immediately in case it's already up.
  pi.events?.on?.("permissions:ready", register);
  register();
}

// ═══════════════════════════════════════════════════════════════════════
// SHARED-DIRECTORY LEASES
// ═══════════════════════════════════════════════════════════════════════

type LeaseRole = "teammate" | "leader";

interface Lease {
  pid: number;
  role: LeaseRole;
  /** Whether this agent currently needs yolo (autonomous / remote-driven). */
  yolo: boolean;
}

/** The sidecar: the config as first found, plus the live leases. */
interface LeaseFile {
  /** config.json as the first lease found it (null = it did not exist). */
  original: string | null;
  leases: Record<string, Lease>;
}

/** The teammate-authored config: permissive while autonomous, guarded while pairing. */
export function teammateConfig(autonomous: boolean): Record<string, unknown> {
  return autonomous
    ? {
        yoloMode: true,
        // Activate our chain link (registered by registerAutonomousAuthorizer).
        // A named-but-unregistered link is skipped fail-safe (more prompting,
        // never less), so it's harmless in sessions that don't register it.
        authorizerChain: [AUTONOMOUS_AUTHORIZER],
        permission: {
          "*": "allow",
          bash: { "*": "allow" },
          external_directory: "allow",
        },
      }
    : {
        yoloMode: false,
        // Keep the chain named while pairing: the link defers when not
        // autonomous, so prompts reach the human normally.
        authorizerChain: [AUTONOMOUS_AUTHORIZER],
        permission: {
          "*": "allow",
          path: {
            "*": "allow",
            "*.env": "deny",
            "*.env.*": "deny",
          },
          bash: {
            "rm -rf *": "deny",
            "sudo *": "ask",
            "*": "allow",
          },
          external_directory: "ask",
        },
      };
}

/**
 * Merge `yoloMode` and our chain link into a user's existing config, preserving
 * every other key. Used for a leader-only directory: the leader runs in a real
 * project, so it never authors a permission map there.
 */
export function mergeYoloMode(raw: string | null, yolo: boolean): Record<string, unknown> {
  let config: Record<string, unknown> = {};
  if (raw) {
    try { config = JSON.parse(raw) as Record<string, unknown>; } catch { config = {}; }
  }
  config.yoloMode = yolo;
  // The chain link is what answers the fail-closed bash wrapper floor that yolo
  // cannot rewrite. Naming it while not yolo is harmless: it defers.
  const chain = Array.isArray(config.authorizerChain) ? config.authorizerChain as unknown[] : [];
  if (!chain.includes(AUTONOMOUS_AUTHORIZER)) chain.push(AUTONOMOUS_AUTHORIZER);
  config.authorizerChain = chain;
  return config;
}

/**
 * The config a set of live leases implies (null = none left → restore the
 * original). Pure, so the composition rules are testable on their own.
 */
export function composeConfig(file: LeaseFile, live: Lease[]): Record<string, unknown> | null {
  if (live.length === 0) return null;
  const yolo = live.some((l) => l.yolo);
  if (live.some((l) => l.role === "teammate")) return teammateConfig(yolo);
  return mergeYoloMode(file.original, yolo);
}

/** Is `pid` a running process? (EPERM means it exists but isn't ours.) */
function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * One agent's lease on a directory's permission config. See the file header
 * for why this exists; `acquire` → `setYolo`* → `release`.
 */
export class DirectoryPermissions {
  private configPath: string;
  private leasesPath: string;
  private key: string;
  private lease: Lease;
  private held = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private reassertMs: number;

  constructor(cwd: string, role: LeaseRole, opts: { pid?: number; reassertMs?: number } = {}) {
    this.configPath = path.join(cwd, PERMISSION_CONFIG_REL);
    this.leasesPath = path.join(cwd, LEASES_REL);
    const pid = opts.pid ?? process.pid;
    // pid alone isn't unique: a teammate's fresh session re-runs the extension
    // in the same process, and the old instance releases after the new acquires.
    this.key = `${pid}:${Math.random().toString(36).slice(2, 10)}`;
    this.lease = { pid, role, yolo: false };
    this.reassertMs = opts.reassertMs ?? REASSERT_MS;
  }

  /** Take a lease with the given yolo need and start re-asserting it. */
  acquire(yolo: boolean): void {
    this.lease.yolo = yolo;
    this.held = true;
    this.sync();
    if (this.reassertMs > 0 && !this.timer) {
      this.timer = setInterval(() => this.sync(), this.reassertMs);
      // Never keep the process alive just to re-assert.
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  /** Change what this agent needs (autonomous ⇄ pairing, remote ⇄ interactive). */
  setYolo(yolo: boolean): void {
    if (!this.held) return this.acquire(yolo);
    if (this.lease.yolo === yolo) return;
    this.lease.yolo = yolo;
    this.sync();
  }

  /** Drop the lease; the last one out restores the original config. */
  release(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (!this.held) return;
    this.held = false;
    this.sync();
  }

  /**
   * Under the lock: upsert (or drop) our lease, prune dead ones, and write the
   * composed config if it differs from what's on disk. Best effort — a
   * read-only directory must never take the agent down.
   */
  private sync(): void {
    try {
      withLock(this.leasesPath + ".lock", () => {
        const file = this.readLeases();
        if (this.held) file.leases[this.key] = { ...this.lease };
        else delete file.leases[this.key];
        for (const [k, l] of Object.entries(file.leases)) {
          if (!isAlive(l.pid)) delete file.leases[k];
        }
        const live = Object.values(file.leases);
        const next = composeConfig(file, live);
        if (next === null) {
          restore(this.configPath, file.original);
          fs.rmSync(this.leasesPath, { force: true });
          return;
        }
        writeIfChanged(this.configPath, JSON.stringify(next, null, 2) + "\n");
        fs.writeFileSync(this.leasesPath, JSON.stringify(file, null, 2) + "\n");
      });
    } catch { /* best effort */ }
  }

  /**
   * The registry, or a fresh one that snapshots the config as found. A missing
   * sidecar with a live config means we're first in (or a reset wiped it) — in
   * both cases what's on disk now is what to restore.
   */
  private readLeases(): LeaseFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.leasesPath, "utf-8")) as LeaseFile;
      if (parsed && typeof parsed === "object" && parsed.leases) return parsed;
    } catch { /* fall through */ }
    fs.mkdirSync(path.dirname(this.leasesPath), { recursive: true });
    return { original: readFileOrNull(this.configPath), leases: {} };
  }
}

/**
 * Spawn-time config for a directory with no agents yet: the permissive teammate
 * config, recorded as ppt-authored (original: null) so that when the spawned
 * teammate's lease is the last to go, the file is removed rather than
 * "restored" to this permissive copy. A directory that already has a config
 * (or live leases) is left alone — the teammate's own lease composes it.
 */
export function prepareSpawnConfig(cwd: string): void {
  const configPath = path.join(cwd, PERMISSION_CONFIG_REL);
  const leasesPath = path.join(cwd, LEASES_REL);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  withLock(leasesPath + ".lock", () => {
    if (fs.existsSync(configPath) || fs.existsSync(leasesPath)) return;
    fs.writeFileSync(configPath, JSON.stringify(teammateConfig(true), null, 2) + "\n");
    const file: LeaseFile = { original: null, leases: {} };
    fs.writeFileSync(leasesPath, JSON.stringify(file, null, 2) + "\n");
  });
}

/**
 * A tiny cross-process mutex: `mkdir` is atomic. Spins briefly; a lock older
 * than STALE_LOCK_MS is abandoned (its holder died mid-write) and stolen.
 */
function withLock(lockPath: string, fn: () => void): void {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 5_000;
  for (;;) {
    try { fs.mkdirSync(lockPath); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > STALE_LOCK_MS) { fs.rmSync(lockPath, { recursive: true, force: true }); continue; }
      } catch { continue; }
      if (Date.now() > deadline) throw new Error(`permission lease lock timeout: ${lockPath}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try { fn(); } finally { fs.rmSync(lockPath, { recursive: true, force: true }); }
}

function restore(configPath: string, original: string | null): void {
  if (original === null) fs.rmSync(configPath, { force: true });
  else writeIfChanged(configPath, original);
}

function writeIfChanged(file: string, content: string): void {
  if (readFileOrNull(file) === content) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// ═══════════════════════════════════════════════════════════════════════
// TEAMMATE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Teammate permissions: lease the directory as autonomous (yolo), and drop to
 * pairing rules the moment a human types in this pane (`onPause` pauses the
 * work loop). Returns the lease so the loop can flip it on resume, and so
 * session_shutdown can release it.
 */
export function registerPermissionBypass(
  pi: ExtensionAPI,
  getIsAutonomous: () => boolean,
  onPause: () => void,
  cwd: string,
): DirectoryPermissions {
  const lease = new DirectoryPermissions(cwd, "teammate");
  lease.acquire(true);

  pi.on("input", async (event) => {
    if (event.source === "interactive" && getIsAutonomous()) {
      lease.setYolo(false);
      onPause();
    }
    return { action: "continue" as const };
  });

  return lease;
}


// ═══════════════════════════════════════════════════════════════════════
// CHAT AGENT (LEADER)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Keep the chat agent unblockable.
 *
 * The leader answers the chat, and a web-driven run has **no one at the
 * terminal**: a permission prompt hangs the conversation with no visible cause
 * (the web UI just shows a `…` forever). So while the current run was triggered
 * remotely its lease wants yolo, and the `ppt-autonomous` link answers the
 * fail-closed asks yolo can't.
 *
 * It keys off who drove the run rather than being permanently permissive, which
 * is the same autonomous/pairing distinction teammates use:
 *   - `interactive` input (you typing in its tmux pane) → no yolo need, because
 *     you are right there and can answer
 *   - `extension`/`rpc` input (the chat mirror delivering a web message) → yolo
 *
 * Politeness about the user's repo: in a leader-only directory the lease only
 * merges `yoloMode` + the chain link into the user's config and restores it on
 * the way out. If teammates share the directory, their leases win (see the file
 * header) — the leader can no longer delete or un-yolo their config.
 */
export function registerChatAgentPermissions(
  pi: ExtensionAPI,
  cwd: string,
): { isRemoteDriven: () => boolean } {
  const lease = new DirectoryPermissions(cwd, "leader");
  lease.acquire(false);
  let remoteDriven = false;

  pi.on("input", async (event) => {
    // "interactive" means a human is at this pane and can answer a prompt;
    // anything else (the mirror's sendUserMessage, RPC) means they are not.
    remoteDriven = event.source !== "interactive";
    lease.setYolo(remoteDriven);
    return { action: "continue" as const };
  });

  pi.on("session_shutdown", async () => {
    lease.release();
  });

  return { isRemoteDriven: () => remoteDriven };
}

function readFileOrNull(file: string): string | null {
  try { return fs.readFileSync(file, "utf-8"); } catch { return null; }
}
