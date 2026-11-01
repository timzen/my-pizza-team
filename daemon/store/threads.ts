/**
 * daemon/store/threads.ts — A ref's thread, attachments, and token usage.
 *
 * Everything that hangs off a WorkDef's directory (`tasks/<id>/`), uniformly
 * for board tasks and standalone work (docs/DESIGN.md "WorkDefs & Parents"):
 *   - the thread (`comments.jsonl`, append-only): comments and triage decision
 *     lines (docs/DESIGN.md "Auto Triage");
 *   - `notifyComment` — the source's onComment write-back hook, fire-and-forget,
 *     with the in-flight write-backs a mirror's sync waits out and the external
 *     id recorded as `wroteback:<defId>:<id>` (docs/DESIGN.md "A mirrored thread");
 *   - attachments (`attachments/<epoch-ms>-<name>`);
 *   - the ref's token usage (the `token_usage` cache; daemon/store/usage.ts owns
 *     the ledger).
 *
 * The Store delegates its thread methods here one line each. What this needs
 * from the sources comes in as `ThreadStoreDeps`.
 */

import type { DatabaseSync } from "node:sqlite";
import * as path from "node:path";
import * as fs from "node:fs";
import { existsSync } from "node:fs";
import { isTriageDecision, type Comment, type ThreadEntry, type WorkDef, type WorkItemRef } from "../../shared/types.ts";
import { errorMessage } from "../../shared/util.ts";
import type { SourceEntry } from "../sources/registry.ts";
import { wroteBackKey } from "../sources/comments.ts";
import { getWorkDef, workDefDir } from "./workdefs.ts";
import { recordUsage, type UsageEntry } from "./usage.ts";
import type { StoreDomainContext } from "./domain.ts";

/**
 * How long an in-flight `onComment` write-back defers a mirror's new inbound
 * comments (docs/DESIGN.md "A mirrored thread"); after this, a hung hook no
 * longer holds the thread back.
 */
const WRITE_BACK_DEFER_MS = 120_000;

/** One stored attachment, as listed. */
export interface AttachmentInfo {
  name: string;
  storedName: string;
  size: number;
  addedAt: number;
}

/** What the thread domain needs from the rest of the Store. */
export interface ThreadStoreDeps {
  /** The registered source that owns a WorkDef, if any (its onComment hook). */
  sourceFor(def: WorkDef): SourceEntry | undefined;
}

export class ThreadStore {
  private db: DatabaseSync;
  private teamDir: string;
  private deps: ThreadStoreDeps;
  /**
   * `onComment` write-backs still running, per mirrored def: their start
   * times. In memory only — after a restart nothing is in flight. An entry
   * older than `WRITE_BACK_DEFER_MS` no longer defers anything (a hung hook
   * mustn't freeze the thread).
   */
  private pendingWriteBacks = new Map<string, Set<{ startedAt: number }>>();

  constructor(ctx: StoreDomainContext, deps: ThreadStoreDeps) {
    this.db = ctx.db;
    this.teamDir = ctx.teamDir;
    this.deps = deps;
  }

  /** The ref's WorkDef directory, or null when the WorkDef doesn't exist. */
  private refDir(ref: WorkItemRef): string | null {
    return getWorkDef(this.teamDir, ref.workDefId) ? workDefDir(this.teamDir, ref.workDefId) : null;
  }

  /**
   * A ref's comments. Triage **decision** lines live in the same append-only file
   * (docs/DESIGN.md "Auto Triage") and are not comments, so they're filtered out
   * here — every existing caller (the prompt, the thread UI, agents) sees exactly
   * what it did before. Use `getThreadEntries` for the whole file.
   */
  getCommentsForRef(ref: WorkItemRef): Comment[] {
    return this.getThreadEntries(ref).filter((e) => !isTriageDecision(e)) as Comment[];
  }

  /** Every line of a ref's thread, comments and triage decisions alike, in order. */
  getThreadEntries(ref: WorkItemRef): ThreadEntry[] {
    const dir = this.refDir(ref);
    if (!dir) return [];
    const file = path.join(dir, "comments.jsonl");
    if (!existsSync(file)) return [];
    const out: ThreadEntry[] = [];
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      // A malformed line must not take the whole thread down with it.
      try { out.push(JSON.parse(line) as ThreadEntry); } catch { /* skip */ }
    }
    return out;
  }

  /**
   * Append one raw line to a ref's thread (comments.jsonl stays append-only).
   * No onComment hook: for triage analyses/decisions and comments merged in
   * from a source. False when the ref doesn't exist.
   */
  appendThreadEntry(ref: WorkItemRef, entry: ThreadEntry): boolean {
    const dir = this.refDir(ref);
    if (!dir) return false;
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "comments.jsonl"), JSON.stringify(entry) + "\n");
    return true;
  }

  /** Append a comment to a ref's thread, then tell its source (`notifyComment`). A no-op for an unknown ref. */
  addCommentForRef(ref: WorkItemRef, from: string, body: string, attachments?: Array<{ name: string; size: number; type: string }>): void {
    const dir = this.refDir(ref);
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    const comment: Comment = { from, body, at: new Date().toISOString() };
    if (attachments && attachments.length > 0) comment.attachments = attachments;
    fs.appendFileSync(path.join(dir, "comments.jsonl"), JSON.stringify(comment) + "\n");
    this.notifyComment(ref, comment);
  }

  /**
   * Tell the def's source a comment was added (hook: onComment — write-back,
   * e.g. a teammate's completion comment to the external item). Fire-and-forget:
   * an async hook's promise is never awaited, so the caller (a route, the agent
   * protocol) doesn't wait on the external system, and a throw or rejection is
   * only logged. Called synchronously, like onItemTerminal, so a source sees a
   * teammate's closing comment before the state change that follows it.
   */
  private notifyComment(ref: WorkItemRef, comment: Comment): void {
    // A comment that came from the source is never written back to it.
    if (comment.external) return;
    const def = getWorkDef(this.teamDir, ref.workDefId);
    const src = def ? this.deps.sourceFor(def) : undefined;
    if (!def || !src?.source.onComment) return;
    const fail = (e: unknown) => src.ctx.log(`onComment failed: ${errorMessage(e)}`);
    // The id the source gave the posted comment: recorded so sync recognises it
    // when it comes back (docs/DESIGN.md "A mirrored thread").
    const record = (r: unknown) => {
      const id = (r as { externalId?: unknown } | null | undefined)?.externalId;
      if (typeof id !== "string" || !id) return;
      try { src.ctx.kv.set(wroteBackKey(def.id, id), comment.at); } catch (e) { fail(e); }
    };
    try {
      const r = src.source.onComment(def, { ...comment }, src.ctx);
      if (r instanceof Promise) {
        const pending = { startedAt: Date.now() };
        const set = this.pendingWriteBacks.get(def.id) ?? new Set();
        set.add(pending);
        this.pendingWriteBacks.set(def.id, set);
        r.then(record, fail).finally(() => {
          set.delete(pending);
          if (set.size === 0 && this.pendingWriteBacks.get(def.id) === set) this.pendingWriteBacks.delete(def.id);
        });
      } else {
        record(r);
      }
    } catch (e) {
      fail(e);
    }
  }

  /**
   * Is a write-back for this def in flight (started within `WRITE_BACK_DEFER_MS`)?
   * A mirror's sync defers merging new inbound comments while one is.
   */
  writeBackInFlight(defId: string): boolean {
    const pending = this.pendingWriteBacks.get(defId);
    if (!pending) return false;
    const now = Date.now();
    return [...pending].some((p) => now - p.startedAt < WRITE_BACK_DEFER_MS);
  }

  // --- Attachments ---
  //
  // Uploads are stored as `<epoch-ms>-<name>`, so the upload time is recovered
  // from the stored name; files placed by other means fall back to mtime.
  // Teammates often upload the same display name repeatedly — addedAt is how
  // the UI tells them apart.

  private saveAttachmentInDir(attachDir: string, filename: string, data: Uint8Array | string): string {
    fs.mkdirSync(attachDir, { recursive: true });
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "-");
    const storedName = `${Date.now()}-${safeName}`;
    const filePath = path.join(attachDir, storedName);
    if (typeof data === "string") fs.writeFileSync(filePath, data);
    else fs.writeFileSync(filePath, data);
    return storedName;
  }

  private resolveAttachmentInDir(attachDir: string, filename: string): string | null {
    const filePath = path.join(attachDir, filename);
    if (!existsSync(filePath)) return null;
    // Security: the resolved path must stay within the attachments directory.
    const resolved = path.resolve(filePath);
    const base = path.resolve(attachDir);
    if (!resolved.startsWith(base)) return null;
    return resolved;
  }

  private listAttachmentsInDir(attachDir: string): AttachmentInfo[] {
    if (!existsSync(attachDir)) return [];
    const results: AttachmentInfo[] = [];
    for (const entry of fs.readdirSync(attachDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const stat = fs.statSync(path.join(attachDir, entry.name));
      const displayName = entry.name.replace(/^\d+-/, "");
      const tsPrefix = entry.name.match(/^(\d+)-/);
      const addedAt = tsPrefix ? Number(tsPrefix[1]) : (stat.mtime?.getTime() ?? 0);
      results.push({ name: displayName, storedName: entry.name, size: stat.size, addedAt });
    }
    return results.sort((a, b) => b.addedAt - a.addedAt);
  }

  /** Store an upload under a ref's `attachments/`; returns its stored name, or null for an unknown ref. */
  saveAttachmentForRef(ref: WorkItemRef, filename: string, data: Uint8Array | string): string | null {
    const dir = this.refDir(ref);
    if (!dir) return null;
    return this.saveAttachmentInDir(path.join(dir, "attachments"), filename, data);
  }

  /** List a ref's attachments, newest first (works for any WorkDef). */
  getAttachmentsForRef(ref: WorkItemRef): AttachmentInfo[] {
    const dir = this.refDir(ref);
    if (!dir) return [];
    return this.listAttachmentsInDir(path.join(dir, "attachments"));
  }

  /** Resolve a ref attachment's file path (or null if missing / out of bounds). */
  getAttachmentPathForRef(ref: WorkItemRef, filename: string): string | null {
    const dir = this.refDir(ref);
    if (!dir) return null;
    return this.resolveAttachmentInDir(path.join(dir, "attachments"), filename);
  }

  /** Delete a ref attachment. Returns false if it doesn't exist. */
  deleteAttachmentForRef(ref: WorkItemRef, storedName: string): boolean {
    const filePath = this.getAttachmentPathForRef(ref, storedName);
    if (!filePath) return false;
    try { fs.rmSync(filePath); return true; } catch { return false; }
  }

  // --- Token usage on a ref ---

  /**
   * Record a run's usage against a ref (any WorkDef; token_usage is keyed by the
   * WorkDef id). A no-op when the WorkDef doesn't exist. The title is
   * snapshotted, since the ledger outlives the ref (archive/delete). `extra`
   * carries the ledger's newer fields — cache tokens, kind, member
   * (store/usage.ts).
   */
  addTokenUsage(
    ref: WorkItemRef, inputTokens: number, outputTokens: number, model: string, costUsd: number,
    extra: Omit<Partial<UsageEntry>, "refId" | "inputTokens" | "outputTokens" | "model" | "costUsd" | "title"> = {},
  ): void {
    if (!this.refDir(ref)) return;
    const title = getWorkDef(this.teamDir, ref.workDefId)?.title ?? null;
    recordUsage(this.db, { ...extra, title, refId: ref.workDefId, inputTokens, outputTokens, model, costUsd }, this.teamDir);
  }

  /** A ref's runs' usage rows, oldest first. */
  getTokenUsage(taskId: string): Array<{ inputTokens: number; outputTokens: number; model: string; costUsd: number; at: string }> {
    const rows = this.db.prepare("SELECT * FROM token_usage WHERE task_id = ? ORDER BY recorded_at").all(taskId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      inputTokens: row.input_tokens as number,
      outputTokens: row.output_tokens as number,
      model: row.model as string,
      costUsd: row.cost_usd as number,
      at: new Date(row.recorded_at as number).toISOString(),
    }));
  }

  /** A ref's total cost and tokens across its runs, or null when it has none. */
  getTokenUsageSummary(ref: WorkItemRef): { totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number } | null {
    const row = this.db.prepare(
      "SELECT SUM(input_tokens) as inp, SUM(output_tokens) as out, SUM(cost_usd) as cost FROM token_usage WHERE task_id = ?"
    ).get(ref.workDefId) as Record<string, unknown> | undefined;
    if (!row || row.cost === null) return null;
    return { totalCostUsd: row.cost as number, totalInputTokens: row.inp as number, totalOutputTokens: row.out as number };
  }
}
