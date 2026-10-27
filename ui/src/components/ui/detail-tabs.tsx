/**
 * detail-tabs.tsx — Shared "Details" / "Thread" tab bar for the WorkDef and
 * board-task detail pages.
 *
 * The selected tab is backed by the `?tab=` query param so it is deep-linkable:
 * the Inbox links to `?tab=thread` (a completed run's outcome lives in the
 * comments), while everything else defaults to Details. `useDetailTab` reads +
 * writes the param; `DetailTabBar` renders the two-tab switcher. A triage-mode
 * external item's page adds a third, **Triage** (its default — docs/DESIGN.md
 * "External sources" — "Triage mode"), linked as `?tab=triage`.
 */

import { useSearchParams } from "react-router-dom";

export type DetailTab = "details" | "thread" | "triage";

const TABS: DetailTab[] = ["details", "thread", "triage"];

/**
 * Read/write the active detail tab via the `?tab=` query param. Absent means
 * `defaultTab` ("details" unless the page says otherwise); a `triage` param on a
 * page without that tab falls back to it too (pass `allowTriage`).
 */
export function useDetailTab(defaultTab: DetailTab = "details", allowTriage = false): [DetailTab, (t: DetailTab) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab") as DetailTab | null;
  const tab: DetailTab = raw && TABS.includes(raw) && (raw !== "triage" || allowTriage) ? raw : defaultTab;
  const setTab = (t: DetailTab) => {
    const next = new URLSearchParams(params);
    if (t === defaultTab) next.delete("tab");
    else next.set("tab", t);
    // replace: navigating tabs shouldn't stack history entries.
    setParams(next, { replace: true });
  };
  return [tab, setTab];
}

interface DetailTabBarProps {
  tab: DetailTab;
  onChange: (t: DetailTab) => void;
  /** Optional count shown next to the Thread label (e.g. comment count). */
  threadCount?: number;
  /** Show a leading **Triage** tab (a triage-mode external item), with its pending-proposal count. */
  triage?: { pending: number };
}

/** Tab switcher: Details | Thread, led by Triage when the page has one. */
export function DetailTabBar({ tab, onChange, threadCount, triage }: DetailTabBarProps) {
  const tabClass = (active: boolean) =>
    `px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
      active ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
    }`;
  return (
    <div className="flex border-b border-border">
      {triage && (
        <button className={tabClass(tab === "triage")} onClick={() => onChange("triage")}>
          Triage{triage.pending > 0 ? ` (${triage.pending})` : ""}
        </button>
      )}
      <button className={tabClass(tab === "details")} onClick={() => onChange("details")}>Details</button>
      <button className={tabClass(tab === "thread")} onClick={() => onChange("thread")}>
        Thread{typeof threadCount === "number" && threadCount > 0 ? ` (${threadCount})` : ""}
      </button>
    </div>
  );
}
