/**
 * lib/start-work.ts — The quick-create destinations ("start work"): a Story, a
 * Solitary task, a Scheduled job. Shared by the dock's `+` menu (NewWorkMenu)
 * and the collapsed rail's icons. Each names the feature toggle it needs, so
 * callers drop the ones the team switched off (lib/features.ts filterByFeatures).
 */

import { CalendarClock, Plus, Zap } from "lucide-react";
import type { FeatureName } from "./features";

export const START_WORK: ReadonlyArray<{ to: string; label: string; icon: typeof Plus; feature: FeatureName }> = [
  { to: "/stories/new", label: "New Story", icon: Plus, feature: "stories" },
  { to: "/work-defs/new?type=Solitary", label: "Solitary Task", icon: Zap, feature: "tasks" },
  { to: "/work-defs/new?type=Scheduled", label: "Scheduled Job", icon: CalendarClock, feature: "schedules" },
];
