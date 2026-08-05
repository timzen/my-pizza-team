/**
 * detail-tabs.tsx — Shared "Details" / "Thread" tab bar for the WorkDef and
 * board-task detail pages.
 *
 * The selected tab is backed by the `?tab=` query param so it is deep-linkable:
 * the Inbox links to `?tab=thread` (a completed run's outcome lives in the
 * comments), while everything else defaults to Details. `useDetailTab` reads +
 * writes the param; `DetailTabBar` renders the two-tab switcher.
 */

import { useSearchParams } from "react-router-dom";

export type DetailTab = "details" | "thread";

/** Read/write the active detail tab via the `?tab=` query param (default "details"). */
export function useDetailTab(): [DetailTab, (t: DetailTab) => void] {
  const [params, setParams] = useSearchParams();
  const tab: DetailTab = params.get("tab") === "thread" ? "thread" : "details";
  const setTab = (t: DetailTab) => {
    const next = new URLSearchParams(params);
    if (t === "details") next.delete("tab");
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
}

/** Two-tab switcher: Details | Thread. */
export function DetailTabBar({ tab, onChange, threadCount }: DetailTabBarProps) {
  const tabClass = (active: boolean) =>
    `px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
      active ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
    }`;
  return (
    <div className="flex border-b border-border">
      <button className={tabClass(tab === "details")} onClick={() => onChange("details")}>Details</button>
      <button className={tabClass(tab === "thread")} onClick={() => onChange("thread")}>
        Thread{typeof threadCount === "number" && threadCount > 0 ? ` (${threadCount})` : ""}
      </button>
    </div>
  );
}
