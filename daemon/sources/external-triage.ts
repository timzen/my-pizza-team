/**
 * daemon/sources/external-triage.ts — Triage mode for external (pull-only) Work
 * Sources: the daemon-owned behavior of a mirrored WorkDef whose effective mode
 * is "triage". See docs/DESIGN.md "External sources" — "Triage mode".
 *
 * A source opts in per source (`WorkSource.mode: "triage"`) or per item
 * (`ExternalDef.mode`); the effective mode is recorded with the mirror
 * (daemon/sources/mirror.ts, kv `mode:<defId>`). Such an item is a triage
 * *subject*, exactly like a note: a teammate triages it — the same flow as Auto
 * Triage — and posts an analysis + proposals with `propose_work`; the author
 * accepts (which creates real work, never starts it) or rejects. Nothing ever
 * works the external item itself.
 *
 * What stays the same as "work" mode: enqueueing (once per revision, from the
 * sync loop — a new revision of the item is the "turn"), mirroring, vanish →
 * archive, and the source's eligibility and write-back hooks. What this module
 * takes over from the source, for triage-mode mirrors only:
 *   - the WorkItem's title ("Triage: <title>") and directory (the mirror's, else
 *     the leader's — the thought-triage rule);
 *   - the claim prompt (`triage.md` / the built-in default + the mirror's current
 *     content, open stories, earlier analyses, and the decision summary);
 *   - **Run**, which means **Triage now**: force a run of the current revision.
 *
 * Like the Thought source, the Store-level reads come in as deps, so this never
 * imports the Store.
 */

import type { Comment, WorkDef, WorkItem } from "../../shared/types.ts";
import { buildExternalTriagePrompt } from "../prompt.ts";
import { mirrorTriageWorkItemTitle } from "../triage.ts";
import { mirrorMode, mirrorRevisionKey } from "./mirror.ts";
import type { RunResult, SourceContext } from "./types.ts";

/** The Store-level reads triage mode needs (supplied by the Store). */
export interface ExternalTriageDeps {
  /** The registered leader's directory, if any (where triage runs by default). */
  leaderDirectory(): string | undefined;
  /** The team's `triage.md`, or undefined for the built-in default. */
  getTriageInstructions(): string | undefined;
  /** Open (not done) stories, so a proposal can attach a task to one. */
  getOpenStories(): Array<{ id: string; title: string }>;
  /** The def's thread (analyses and other comments; decisions filtered out). */
  getComments(workDefId: string): Comment[];
  /** One line per earlier proposal on the def and its decision. */
  decisionSummary(workDefId: string): string[];
  /** A source's display name (its `label`, else its id). */
  sourceLabel(sourceId: string): string;
}

/** Is `def` a mirrored WorkDef whose recorded mode is "triage"? `kv` is its source's. */
export function isTriageModeMirror(def: Pick<WorkDef, "id" | "parent">, kv: SourceContext["kv"]): boolean {
  return def.parent?.kind === "external" && mirrorMode(kv, def.id) === "triage";
}

export class ExternalTriage {
  private deps: ExternalTriageDeps;

  constructor(deps: ExternalTriageDeps) {
    this.deps = deps;
  }

  /**
   * At enqueue: the item reads as a triage run ("Triage: <title>") and runs in
   * the mirror's directory or, lacking one, the leader's (with no leader it has
   * none, so any teammate may take it) — the same rule as a note's triage.
   */
  resolveItem(def: WorkDef): { title: string; directory?: string } {
    return { title: mirrorTriageWorkItemTitle(def), directory: def.directory || this.deps.leaderDirectory() };
  }

  /**
   * At claim: the triage prompt with the mirror's *current* content as its
   * subject (sync keeps it current), not the work prompt.
   */
  buildPrompt(def: WorkDef): string {
    const sourceId = def.parent?.source ?? "external";
    return buildExternalTriagePrompt({
      item: {
        id: def.id,
        sourceLabel: this.deps.sourceLabel(sourceId),
        externalId: def.parent?.id ?? def.id,
        title: def.title,
        goal: def.goal,
        acceptanceCriteria: def.acceptanceCriteria,
        additionalContext: def.additionalContext,
        url: def.url,
      },
      instructions: this.deps.getTriageInstructions(),
      stories: this.deps.getOpenStories(),
      // The source's own comments (pulled by sync) aren't earlier analyses.
      priorComments: this.deps.getComments(def.id).filter((c) => !c.external),
      priorDecisions: this.deps.decisionSummary(def.id),
    });
  }

  /**
   * **Run** = **Triage now**: force a run of the revision currently mirrored,
   * even if it was already handed over (the only way to retry a failed run).
   * Refuses an archived or pending mirror, and one already in flight.
   */
  run(def: WorkDef, ctx: SourceContext): RunResult {
    if (def.status === "archived") return { ok: false, conflict: true, error: "An archived item isn't triaged" };
    if (def.pending) return { ok: false, conflict: true, error: "This WorkDef is pending; activate it before running it" };
    if (ctx.hasActiveItem(def.id)) return { ok: false, conflict: true, error: "This item is already being triaged" };
    const revision = ctx.kv.get(mirrorRevisionKey(def.id)) ?? "";
    const item: WorkItem | null = ctx.enqueueRevision(def.id, revision, { force: true });
    return item ? { ok: true, workItem: item } : { ok: false, error: "Could not enqueue triage" };
  }
}
