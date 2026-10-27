/**
 * lib/work-item-link.ts — The detail route for a WorkItem's backing ref.
 *
 * Board tasks open their task page; standalone work opens its WorkDef page
 * (comments/outcome live on the ref either way). An auto-triage run opens its
 * note's **triage page**, not the WorkDef page: the WorkDef is an empty container,
 * and the analysis is only useful beside the note (docs/DESIGN.md "Auto Triage").
 * A triage-mode external item's run (`triage: true`) opens the mirror's **Triage
 * tab** for the same reason (docs/DESIGN.md "External sources" — "Triage mode").
 * Shared by the Inbox and the teammate view's "working on" link.
 */

export interface LinkableWorkItem {
  ref: { workDefId: string };
  parent?: { kind: "story" | "schedule" | "thought" | "external"; id: string; source?: string };
  /** A run on a triage-mode external item (WorkItemView.triage). */
  triage?: boolean;
}

export function workItemPath(item: LinkableWorkItem): string {
  if (item.parent?.kind === "story") {
    return `/task/${encodeURIComponent(item.parent.id)}/${encodeURIComponent(item.ref.workDefId)}`;
  }
  if (item.parent?.kind === "thought") {
    return `/thoughts/${encodeURIComponent(item.parent.id)}/triage`;
  }
  if (item.triage) {
    return `/work-defs/${encodeURIComponent(item.ref.workDefId)}?tab=triage`;
  }
  return `/work-defs/${encodeURIComponent(item.ref.workDefId)}`;
}

/**
 * Should a link to this item's outcome open the Thread tab? Not for a triage run:
 * a note's triage page has no tabs, and a triage-mode item opens its Triage tab.
 */
export function hasThreadTab(item: LinkableWorkItem): boolean {
  return item.parent?.kind !== "thought" && !item.triage;
}

/** Is this a triage run (a note's, or a triage-mode external item's)? */
export function isTriageRun(item: LinkableWorkItem): boolean {
  return item.parent?.kind === "thought" || !!item.triage;
}
