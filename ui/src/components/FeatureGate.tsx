/**
 * FeatureGate — Route guards for the feature toggles (docs/DESIGN.md "Feature
 * Toggles").
 *
 * `FeatureRoute` wraps a page that belongs to one work-item kind: while the kind
 * is on it renders the page, while it's off a friendly "turned off — enable it in
 * Config" notice instead (not a silent redirect, so a bookmark explains itself).
 * `WorkDefFormRoute` does the same for `/work-defs/new`, whose kind comes from
 * `?type=`. `FeatureOffNotice` is also used by pages that only learn their kind
 * from the daemon's 403 (a WorkDef page).
 */

import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useFeatures } from "@/hooks/useFeatures";
import { FEATURE_LABELS, featureForWorkDefForm, type FeatureName } from "@/lib/features";
import { Card, CardContent } from "@/components/ui/card";
import { Power } from "lucide-react";

/** Render `children` only while `feature` is on; nothing until the toggles load. */
export function FeatureRoute({ feature, children }: { feature: FeatureName; children: ReactNode }) {
  const features = useFeatures();
  if (!features) return null;
  if (!features[feature]) return <FeatureOffNotice feature={feature} />;
  return <>{children}</>;
}

/** `/work-defs/new`: gated by the form's `?type=` (Scheduled → Schedules, else Tasks). */
export function WorkDefFormRoute({ children }: { children: ReactNode }) {
  const { search } = useLocation();
  return <FeatureRoute feature={featureForWorkDefForm(search)}>{children}</FeatureRoute>;
}

/**
 * "This kind is turned off" with a link to Config. Without a `feature` (a page
 * that only got a 403) it speaks generically; with a `sourceLabel` it names a
 * switched-off plugin source ("Jira is turned off").
 */
export function FeatureOffNotice({ feature, sourceLabel, embedded }: {
  feature?: FeatureName;
  /** A plugin source's label (its Work tab while it's off); used when `feature` isn't given. */
  sourceLabel?: string;
  /** Inside a tabbed page's body (Config → Workflows): no own padding or centering, so it stays left-aligned with the header. */
  embedded?: boolean;
}) {
  if (!feature && sourceLabel) {
    return (
      <div className={embedded ? "max-w-xl" : "container mx-auto max-w-xl p-6"}>
        <Card>
          <CardContent className="space-y-2 p-6 text-sm">
            <h1 className="flex items-center gap-2 font-semibold"><Power className="h-4 w-4" />{sourceLabel} is turned off</h1>
            <p className="text-muted-foreground">
              Your team has switched {sourceLabel} off: it isn't synced and nothing new from it runs. Turn it back on under{" "}
              <Link to="/config" className="text-primary underline">Config → Work items</Link>. Finished work
              still shows in the <Link to="/" className="text-primary underline">Inbox</Link>.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }
  const name = feature ? FEATURE_LABELS[feature] : "This kind of work";
  return (
    <div className={embedded ? "max-w-xl" : "container mx-auto max-w-xl p-6"}>
      <Card>
        <CardContent className="space-y-2 p-6 text-sm">
          <h1 className="flex items-center gap-2 font-semibold"><Power className="h-4 w-4" />{name} {feature ? "are" : "is"} turned off</h1>
          <p className="text-muted-foreground">
            Your team has switched {feature ? FEATURE_LABELS[feature] : "it"} off. Turn it back on under{" "}
            <Link to="/config" className="text-primary underline">Config → Work items</Link>. Finished work
            still shows in the <Link to="/" className="text-primary underline">Inbox</Link>.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
