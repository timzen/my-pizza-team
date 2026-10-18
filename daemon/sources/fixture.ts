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
 *   - **Revision:** a SHA-256 of the file's content, so touching a file without
 *     changing it doesn't re-run it.
 *   - **Write-back:** every `onComment` / `onItemTerminal` call is recorded in
 *     memory (`writeBacks`, for tests) and appended to `dir/.writeback.jsonl`
 *     (for a person trying it out) — the folder is the "external system".
 *
 * Enabled only by test/dev config (`config.dev.fixtureSource`, daemon/app.ts)
 * or a test registering it directly; never by default.
 */

import * as path from "@std/path";
import { existsSync } from "@std/fs";
import type { Comment, WorkDef, WorkItem } from "../../shared/types.ts";
import { parseWorkDef } from "../store/workdefs.ts";
import type { ExternalDef, SourceContext, WorkSource } from "./types.ts";

/** The fixture source's default id and label. */
export const FIXTURE_SOURCE_ID = "fixture";

/** The write-back file the fixture appends to, inside its folder. */
export const FIXTURE_WRITEBACK_FILE = ".writeback.jsonl";

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
  return {
    externalId,
    title: parsed.title,
    goal: parsed.goal,
    acceptanceCriteria: parsed.acceptanceCriteria || undefined,
    additionalContext: parsed.additionalContext,
    directory: parsed.directory,
    url: parsed.url,
  };
}

export class FixtureSource implements WorkSource {
  readonly id: string;
  readonly label: string;
  readonly apiVersion = 1 as const;
  readonly syncTimeoutMs?: number;
  /** Every write-back call, oldest first. */
  readonly writeBacks: FixtureWriteBack[] = [];
  private readonly everyMs: number | null;

  constructor(private opts: FixtureSourceOptions) {
    this.id = opts.id ?? FIXTURE_SOURCE_ID;
    this.label = opts.label ?? "Fixture";
    this.everyMs = opts.syncEveryMs === undefined ? 60_000 : opts.syncEveryMs;
    this.syncTimeoutMs = opts.syncTimeoutMs;
  }

  syncEveryMs(): number | null {
    return this.everyMs;
  }

  /** Every `*.md` file in the folder, as it reads now. A missing folder is an error (the system is "down"). */
  async sync(): Promise<ExternalDef[]> {
    if (!existsSync(this.opts.dir)) throw new Error(`fixture folder ${this.opts.dir} does not exist`);
    const out: ExternalDef[] = [];
    for (const entry of [...Deno.readDirSync(this.opts.dir)].sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile || !entry.name.endsWith(".md") || entry.name.startsWith(".")) continue;
      const raw = await Deno.readTextFile(path.join(this.opts.dir, entry.name));
      const externalId = entry.name.slice(0, -".md".length);
      out.push({ ...parseItem(externalId, raw), revision: await sha256(raw) });
    }
    return out;
  }

  onComment(def: WorkDef, comment: Comment, ctx: SourceContext): void {
    this.record({ hook: "onComment", defId: def.id, externalId: def.parent?.id ?? "", comment }, ctx);
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
      Deno.writeTextFileSync(path.join(this.opts.dir, FIXTURE_WRITEBACK_FILE), JSON.stringify({ at: new Date().toISOString(), ...call }) + "\n", { append: true });
    } catch (e) {
      ctx.log(`could not record write-back: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
