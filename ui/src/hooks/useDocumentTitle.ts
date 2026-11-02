/**
 * useDocumentTitle — Set the browser tab's title to `<Page> · <team> · Pizza
 * Team` (lib/page-title.ts formatPageTitle; docs/ACCESSIBILITY.md
 * "Structure").
 *
 * Each shell calls it with `pageTitleForPath(pathname)`; a detail page calls it
 * with its own item's name, once loaded (the path's title is null there, so the
 * two never fight). Pass null to leave the title alone.
 *
 * The team's name is `/api/status` `teamName`, fetched once per page load and
 * shared by every caller — it doesn't change while the daemon runs.
 */

import { useEffect, useState } from "react";
import { formatPageTitle } from "@/lib/page-title";

/** Set the document title from a page name (or its parts, most specific first); null leaves it alone. */
export function useDocumentTitle(page: string | readonly string[] | null): void {
  const team = useTeamName();
  const title = page === null ? null : formatPageTitle(page, team);
  useEffect(() => {
    if (title !== null) document.title = title;
  }, [title]);
}

/** The cached team name: undefined until the one fetch answers. */
let teamNameCache: string | null | undefined;
let teamNameRequest: Promise<string | null> | null = null;

/** The team's name from `/api/status` (null until it answers, or if it can't). */
function useTeamName(): string | null {
  const [name, setName] = useState<string | null>(teamNameCache ?? null);
  useEffect(() => {
    if (teamNameCache !== undefined) return;
    teamNameRequest ??= fetch("/api/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { teamName?: unknown } | null) => (typeof j?.teamName === "string" && j.teamName ? j.teamName : null))
      .catch(() => null)
      .then((n) => { teamNameCache = n; return n; });
    let live = true;
    teamNameRequest.then((n) => { if (live) setName(n); });
    return () => { live = false; };
  }, []);
  return name;
}
