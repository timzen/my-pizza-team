/**
 * WorkItemFeatures — Config → General's **Work items** card: the built-in
 * kinds' feature toggles (docs/DESIGN.md "Feature Toggles"), saved with the
 * page, and a link to the Sources tab for external sources.
 */

import { Link } from "react-router-dom";
import { featureToggleRows, type Features } from "@/lib/features";
import type { ConfigData } from "@/lib/config-draft";
import { SOURCES_TAB_PATH } from "@/lib/source-settings";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Switch the Stories, Tasks (incl. Templates), and Schedules kinds on or off,
 * saved with the page. The list comes from the server (`featureSources` from
 * GET /api/config). A kind that's on and still has active items can't be
 * switched off — the daemon would refuse (409) — so its checkbox is disabled
 * with what to archive or delete first (`featureUsage`). A refusal that slips
 * through shows as `error`.
 *
 * External Work Sources are switched on the **Sources** tab instead (applied at
 * once there, with its "Turn off and archive N items" disconnect), so there's
 * one control per source; this card links there. A non-external plugin toggle
 * (rare: an in-daemon source declaring `toggle`) stays here.
 */
export function WorkItemFeatures({ config, setConfig, saved, error }: {
  config: ConfigData;
  setConfig: (c: ConfigData) => void;
  saved: ConfigData | null;
  error: string | null;
}) {
  const features: Features = { stories: true, tasks: true, schedules: true, ...config.features };
  const set = (name: string, on: boolean) => setConfig({ ...config, features: { ...features, [name]: on } });
  const all = featureToggleRows(config.featureSources);
  const rows = all.filter((r) => !r.external);
  const external = all.filter((r) => r.external);

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <h2 className="font-semibold">Work items</h2>
        <p className="text-xs text-muted-foreground">
          The kinds of work your team uses. A kind that's off disappears from the nav and the quick-create menu,
          and its pages, API, CLI and assistant tools are refused. Thoughts, Personas and the Inbox are always on.
          Takes effect as soon as you save.
        </p>
        <div className="space-y-2">
          {rows.map((row) => {
            const name = row.feature;
            const on = features[name] !== false;
            const usage = config.featureUsage?.[name];
            // Only a kind that's on (as saved) and still in use is locked on.
            const locked = saved?.features?.[name] !== false && on && (usage?.count ?? 0) > 0;
            return (
              <div key={name} className="space-y-0.5">
                <label className={`flex items-center gap-2 text-sm ${locked ? "opacity-70" : ""}`}>
                  <input
                    id={`feature-${name}`}
                    type="checkbox"
                    checked={on}
                    disabled={locked}
                    onChange={(e) => set(name, e.target.checked)}
                  />
                  <span className="font-medium">{row.label}</span>
                  <span className="text-xs text-muted-foreground">{row.description}</span>
                </label>
                {locked && usage && (
                  <p className="pl-6 text-xs text-muted-foreground">
                    To turn {row.label} off, archive or delete {usage.description} first.
                  </p>
                )}
              </div>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          {external.length > 0
            ? <>External sources ({external.map((r) => r.label).join(", ")}) are switched on and off, and set up, on the{" "}</>
            : <>Work Source plugins are switched on and off, and set up, on the{" "}</>}
          <Link to={SOURCES_TAB_PATH} className="text-primary underline">Sources</Link> tab.
        </p>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
