/**
 * useWorkDefType — On a WorkDef's page (`/work-defs/:id`), that WorkDef's type
 * (Solitary, Scheduled, Triage, …), fetched once per id.
 *
 * A WorkDef's URL doesn't say what kind it is, but two things depend on it:
 * the NavBar's lit section (lib/nav-section.ts — a triage run lives under
 * Thoughts) and the page's Help section (lib/help.ts `helpForPath`).
 */

import { useEffect, useState } from "react";

/**
 * On `/work-defs/:id`, the WorkDef's type (Solitary/Scheduled/…), which decides
 * the lit nav section; null elsewhere or until it loads. Fetched here (rather
 * than pushed up from the page) so deep links highlight correctly too.
 */
export function useWorkDefTypeForPath(pathname: string): string | null {
  const match = /^\/work-defs\/([^/]+)\/?$/.exec(pathname);
  const id = match?.[1] && match[1] !== "new" ? decodeURIComponent(match[1]) : null;
  const [loaded, setLoaded] = useState<{ id: string; type: string | null } | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    fetch(`/api/work-defs/${encodeURIComponent(id)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { workDef?: { type?: string } } | null) => {
        if (!cancelled) setLoaded({ id, type: json?.workDef?.type ?? null });
      })
      .catch(() => { if (!cancelled) setLoaded({ id, type: null }); });
    return () => { cancelled = true; };
  }, [id]);

  // Ignore a result for a different WorkDef (stale until the new fetch lands).
  return id && loaded?.id === id ? loaded.type : null;
}

