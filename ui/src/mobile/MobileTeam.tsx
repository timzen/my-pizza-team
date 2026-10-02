/**
 * MobileTeam — The phone view's **Team** tab (`/m`): who's working on what, and
 * what's waiting.
 *
 *  - **Teammates** (never the leader — it's the Chat tab), the desktop dock's rows
 *    (components/team/TeamParts) without their hover-only actions; each opens its
 *    live view at `/m/teammates/:id`, which is the desktop TeammatePage as is
 *    (watch, and Pair if you want to).
 *  - **Queue** — the Queue tab's list (pages/QueuePage `QueueList`), with its
 *    stall banner and recovery buttons, fed from the shell's data.
 *
 * Team size and spawning stay on the desktop: they're setup, not a peek.
 */

import { Link, Route, Routes, useMatch } from "react-router-dom";
import type { TeamData } from "@/hooks/useTeamData";
import type { QueueData } from "@/hooks/useQueue";
import { TeammateRow } from "@/components/team/TeamParts";
import { QueueList } from "@/pages/QueuePage";
import { TeammatePage } from "@/pages/TeammatePage";
import { MOBILE_ROOT } from "@/lib/mobile";
import { ChevronLeft } from "lucide-react";

const teammatePath = (id: string) => `${MOBILE_ROOT}/teammates/${encodeURIComponent(id)}`;

export function MobileTeam({ team, queue, paused }: { team: TeamData; queue: QueueData; paused: boolean }) {
  const watching = useMatch(`${MOBILE_ROOT}/teammates/:id`) !== null;
  if (watching) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <Link to={MOBILE_ROOT} className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2 text-sm text-muted-foreground">
          <ChevronLeft className="h-4 w-4" />Team
        </Link>
        <div className="min-h-0 flex-1">
          <Routes>
            <Route path={`${MOBILE_ROOT}/teammates/:id`} element={<TeammatePage />} />
          </Routes>
        </div>
      </div>
    );
  }

  const { online, offline, pendingSpawns, failedSpawns, skewed, teammates } = team;
  const skewReasonFor = (id: string) => skewed.find((s) => s.teammate.id === id)?.reason;

  return (
    <div className="h-full space-y-6 overflow-y-auto p-3">
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">
          Teammates <span className="font-normal text-muted-foreground">({online.length} online)</span>
        </h2>
        {skewed.length > 0 && (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">
            {skewed.length === 1 ? "An agent is" : `${skewed.length} agents are`} out of step with the daemon — restart from the desktop Team tab.
          </p>
        )}
        {/* Summaries, not the dock's spawn rows: their cancel buttons are revealed
            on hover, and an invisible button is still tappable on a phone. */}
        {failedSpawns.length > 0 && (
          <p className="rounded-md border border-destructive/50 bg-destructive/5 p-2 text-xs text-destructive">
            {failedSpawns.length === 1 ? "A spawn" : `${failedSpawns.length} spawns`} failed: {failedSpawns[0]!.error || "spawn failed"}
          </p>
        )}
        {pendingSpawns.length > 0 && (
          <p className="rounded-md border border-dashed border-amber-500/50 bg-amber-500/5 p-2 text-xs text-muted-foreground">
            {pendingSpawns.length} pending spawn{pendingSpawns.length === 1 ? "" : "s"}: {pendingSpawns.map((s) => s.name || "(unnamed)").join(", ")}
          </p>
        )}
        {online.map((t) => (
          <TeammateRow key={t.id} teammate={t} href={teammatePath(t.id)} skewReason={skewReasonFor(t.id)} />
        ))}
        {offline.length > 0 && (
          <div className="space-y-2 pt-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Offline</p>
            {offline.map((t) => <TeammateRow key={t.id} teammate={t} href={null} />)}
          </div>
        )}
        {teammates.length === 0 && pendingSpawns.length === 0 && (
          <p className="py-2 text-xs text-muted-foreground">No teammates yet. Set a team size from the desktop view.</p>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Queue</h2>
        <QueueList queue={queue} teammates={teammates} paused={paused} teammatePath={teammatePath} />
      </section>
    </div>
  );
}
