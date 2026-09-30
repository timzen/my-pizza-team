/**
 * lib/work-item-link.ts — The detail route for a WorkItem's backing ref.
 *
 * Board tasks open their task page; standalone work opens its WorkDef page
 * (comments/outcome live on the ref either way). An auto-triage run opens its
 * note's **triage page**, not the WorkDef page: the WorkDef is an empty container,
 * and the analysis is only useful beside the note (docs/DESIGN.md "Auto Triage").
 * Shared by the Inbox and the teammate view's "working on" link.
 */

export interface LinkableWorkItem {
  ref: { workDefId: string };
  parent?: { kind: "story" | "schedule" | "thought"; id: string };
}

export function workItemPath(item: LinkableWorkItem): string {
  if (item.parent?.kind === "story") {
    return `/task/${encodeURIComponent(item.parent.id)}/${encodeURIComponent(item.ref.workDefId)}`;
  }
  if (item.parent?.kind === "thought") {
    return `/thoughts/${encodeURIComponent(item.parent.id)}/triage`;
  }
  return `/work-defs/${encodeURIComponent(item.ref.workDefId)}`;
}

/** Does this item's detail page have the Details/Thread tabs? (Triage doesn't.) */
export function hasThreadTab(item: LinkableWorkItem): boolean {
  return item.parent?.kind !== "thought";
}
