/**
 * lib/start-work.ts — The quick-create destinations ("start work"): a Story, a
 * Solitary task, a Scheduled job. Shared by the dock's `+` menu (NewWorkMenu)
 * and the collapsed rail's icons.
 */

import { CalendarClock, Plus, Zap } from "lucide-react";

export const START_WORK = [
  { to: "/stories/new", label: "New Story", icon: Plus },
  { to: "/work-defs/new?type=Solitary", label: "Solitary Task", icon: Zap },
  { to: "/work-defs/new?type=Scheduled", label: "Scheduled Job", icon: CalendarClock },
];
