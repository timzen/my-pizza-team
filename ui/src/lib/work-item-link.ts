/**
 * lib/work-item-link.ts — The detail route for a WorkItem's backing ref.
 *
 * Board tasks open their task page; standalone work opens its WorkDef page
 * (comments/outcome live on the ref either way). Shared by the Inbox and the
 * teammate view's "working on" link.
 */

export interface LinkableWorkItem {
  ref: { workDefId: string };
  parent?: { kind: "story" | "schedule"; id: string };
}

export function workItemPath(item: LinkableWorkItem): string {
  return item.parent?.kind === "story"
    ? `/task/${encodeURIComponent(item.parent.id)}/${encodeURIComponent(item.ref.workDefId)}`
    : `/work-defs/${encodeURIComponent(item.ref.workDefId)}`;
}
