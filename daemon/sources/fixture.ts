/**
 * daemon/sources/fixture.ts — The markdown-folder fixture source: an in-repo
 * external (pull-only) Work Source, for tests and development.
 * See docs/DESIGN.md "Work Sources: WorkDef Kinds as Plugins" (external sources).
 *
 * It stands in for Jira/Asana/Taskei while third-party package loading is
 * deferred (TODO.md "Work Sources as plugins — package loading (deferred)"),
 * and exercises everything such a source relies on: sync → mirror → one
 * WorkItem per revision, vanish → archive, and write-back.
 *
 *   - **Items:** every `*.md` file directly in `dir` is one item; its file stem
 *     is the `externalId`. The file uses the WorkDef markdown format — `title`,
 *     `directory`, `url` frontmatter, and `## Goal` / `## Acceptance Criteria` /
 *     `## Additional Context` sections (a file without frontmatter is all goal,
 *     titled by its stem).
 *   - **Mode:** `mode: triage` (or `work`) in an item's frontmatter is its
 *     `ExternalDef.mode`; the `mode` option is the source's `WorkSource.mode`
 *     (triage mode — docs/DESIGN.md "External sources").
 *   - **Persona:** `persona: <id>` in an item's frontmatter is its
 *     `ExternalDef.persona`; the `defaultPersona` / `triagePersona` options are
 *     the source's declarations (docs/DESIGN.md "Work Source personas").
 *   - **Revision:** a SHA-256 of the file's content, so touching a file without
 *     changing it doesn't re-run it. The thread file below isn't part of it.
 *   - **Thread:** `<stem>.comments.jsonl` beside an item, one `ExternalComment`
 *     (`{ externalId, author, createdAt, body, channel? }`) per line, is its
 *     `ExternalDef.comments` (docs/DESIGN.md "A mirrored thread"); no file =
 *     no `comments` reported.
 *   - **Write-back:** every `onComment` / `onItemTerminal` call is recorded in
 *     memory (`writeBacks`, for tests) and appended to `dir/.writeback.jsonl`
 *     (for a person trying it out) — the folder is the "external system".
 *     `onComment` also *posts* the comment: it appends it to the item's thread
 *     file (id `mpt-<n>`, channel `Comments`) and returns that id, so the
 *     round trip — post, then see it come back on the next sync — is real.
 *
 * Enabled only by test/dev config (`config.dev.fixtureSource`, daemon/app.ts)
 * or a test registering it directly; never by default.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { existsSync } from "node:fs";
import type { Comment, WorkDef, WorkItem } from "../../shared/types.ts";
import { parseWorkDef } from "../store/workdefs.ts";
import type { CommentWriteBack, ExternalComment, ExternalDef, SourceContext, WorkSource, WorkSourceMode } from "./types.ts";

/** The fixture source's default id and label. */
export const FIXTURE_SOURCE_ID = "fixture";

/** The write-back file the fixture appends to, inside its folder. */
export const FIXTURE_WRITEBACK_FILE = ".writeback.jsonl";

/** An item's thread file, beside it: `<externalId>.comments.jsonl`. */
export function fixtureCommentsFile(dir: string, externalId: string): string {
  return path.join(dir, `${externalId}.comments.jsonl`);
}

/** The channel the fixture posts written-back comments on. */
export const FIXTURE_WRITEBACK_CHANNEL = "Comments";

/** One recorded write-back call. */
export type FixtureWriteBack =
  | { hook: "onComment"; defId: string; externalId: string; comment: Comment }
  | { hook: "onItemTerminal"; defId: string; externalId: string; itemId: string; state: WorkItem["state"] };

export interface FixtureSourceOptions {
  /** The folder of `*.md` items. */
  dir: string;
  id?: string;
  label?: string;
  /** Sync interval in ms (default 60s; null = on demand only, as tests want). */
  syncEveryMs?: number | null;
  syncTimeoutMs?: number;
  /** The source's mode (`WorkSource.mode`; default "work"). */
  mode?: WorkSourceMode;
  /** The source's declared work persona (`WorkSource.defaultPersona`). */
  defaultPersona?: string;
  /** The source's declared triage persona (`WorkSource.triagePersona`). */
  triagePersona?: string;
}

/** SHA-256 of a string, hex. */
async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Parse one item file into an ExternalDef (the revision is filled in by the caller). */
function parseItem(externalId: string, raw: string): Omit<ExternalDef, "revision"> {
  const normalized = raw.replace(/\r\n/g, "\n");
  const parsed = parseWorkDef(externalId, normalized);
  if (!parsed) return { externalId, title: externalId, goal: normalized.trim() };
  const frontmatter = normalized.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
  const mode = frontmatter.match(/^mode:\s*"?(work|triage)"?\s*$/m)?.[1] as WorkSourceMode | undefined;
  return {
    ...(mode ? { mode } : {}),
    externalId,
    title: parsed.title,
    goal: parsed.goal,
    acceptanceCriteria: parsed.acceptanceCriteria || undefined,
    additionalContext: parsed.additionalContext,
    directory: parsed.directory,
    url: parsed.url,
    ...(parsed.persona ? { persona: parsed.persona } : {}),
  };
}

/**
 * An item's thread file as `ExternalComment`s, or undefined when there is none.
 * Lines are passed through as written (a malformed line is dropped) — the
 * daemon validates each comment, as it would a real source's.
 */
async function readThread(file: string): Promise<ExternalComment[] | undefined> {
  if (!existsSync(file)) return undefined;
  const out: ExternalComment[] = [];
  for (const line of (await fs.promises.readFile(file, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as ExternalComment); } catch { /* skip */ }
  }
  return out;
}

export class FixtureSource implements WorkSource {
  readonly id: string;
  readonly label: string;
  readonly apiVersion = 1 as const;
  readonly syncTimeoutMs?: number;
  readonly mode?: WorkSourceMode;
  readonly defaultPersona?: string;
  readonly triagePersona?: string;
  /** Every write-back call, oldest first. */
  readonly writeBacks: FixtureWriteBack[] = [];
  private readonly everyMs: number | null;
  /** Comments posted by write-back (for unique ids). */
  private posted = 0;

  private opts: FixtureSourceOptions;

  constructor(opts: FixtureSourceOptions) {
    this.opts = opts;
    this.id = opts.id ?? FIXTURE_SOURCE_ID;
    this.label = opts.label ?? "Fixture";
    this.everyMs = opts.syncEveryMs === undefined ? 60_000 : opts.syncEveryMs;
    this.syncTimeoutMs = opts.syncTimeoutMs;
    if (opts.mode) this.mode = opts.mode;
    if (opts.defaultPersona) this.defaultPersona = opts.defaultPersona;
    if (opts.triagePersona) this.triagePersona = opts.triagePersona;
  }

  syncEveryMs(): number | null {
    return this.everyMs;
  }

  /** Every `*.md` file in the folder, as it reads now. A missing folder is an error (the system is "down"). */
  async sync(): Promise<ExternalDef[]> {
    if (!existsSync(this.opts.dir)) throw new Error(`fixture folder ${this.opts.dir} does not exist`);
    const out: ExternalDef[] = [];
    for (const entry of [...fs.readdirSync(this.opts.dir, { withFileTypes: true })].sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name.startsWith(".")) continue;
      const raw = await fs.promises.readFile(path.join(this.opts.dir, entry.name), "utf8");
      const externalId = entry.name.slice(0, -".md".length);
      const comments = await readThread(fixtureCommentsFile(this.opts.dir, externalId));
      out.push({ ...parseItem(externalId, raw), revision: await sha256(raw), ...(comments ? { comments } : {}) });
    }
    return out;
  }

  /** Record the call, and post the comment to the item's thread file; returns its new id. */
  onComment(def: WorkDef, comment: Comment, ctx: SourceContext): CommentWriteBack | void {
    const externalId = def.parent?.id ?? "";
    this.record({ hook: "onComment", defId: def.id, externalId, comment }, ctx);
    if (!externalId || !existsSync(this.opts.dir)) return;
    const posted: ExternalComment = {
      externalId: `mpt-${++this.posted}-${Date.now().toString(36)}`,
      author: comment.from,
      createdAt: comment.at,
      body: comment.body,
      channel: FIXTURE_WRITEBACK_CHANNEL,
    };
    try {
      fs.appendFileSync(fixtureCommentsFile(this.opts.dir, externalId), JSON.stringify(posted) + "\n");
    } catch (e) {
      ctx.log(`could not post the comment: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    return { externalId: posted.externalId };
  }

  onItemTerminal(def: WorkDef, item: WorkItem, ctx: SourceContext): Promise<void> {
    this.record({ hook: "onItemTerminal", defId: def.id, externalId: def.parent?.id ?? "", itemId: item.id, state: item.state }, ctx);
    // Async on purpose: a real source's write-back is a network call, so this
    // exercises the fire-and-forget path (nothing comes back to the agent).
    return Promise.resolve();
  }

  private record(call: FixtureWriteBack, ctx: SourceContext): void {
    this.writeBacks.push(call);
    try {
      if (!existsSync(this.opts.dir)) return;
      fs.appendFileSync(path.join(this.opts.dir, FIXTURE_WRITEBACK_FILE), JSON.stringify({ at: new Date().toISOString(), ...call }) + "\n");
    } catch (e) {
      ctx.log(`could not record write-back: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
