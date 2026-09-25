/**
 * TeamPanel — The dock's **Team** tab: the connected agents and the live queue.
 *
 * What used to be the right-hand TeammateSidebar, now a tab beside the
 * assistant in the left SideDock (DESIGN.md "The Shell: a Dock and a Center"):
 *
 *  - a toolbar: online count, then the team-size and spawn buttons
 *  - **Team** — agents grouped as leader `[L]` / teammates `[Tn]`, each with
 *    status, current work, and working directory. Teammates open their live
 *    view in the center (`/teammates/:id`) and stay highlighted while it's
 *    there. Pending spawn requests and offline agents are listed too.
 *  - **Queue** — non-terminal WorkItems with recovery actions. It lives here
 *    for now; where an always-visible queue belongs is an open question
 *    (docs/ARCHITECTURE.md, SideDock).
 *
 * Presentational over `useTeamData` (owned by the dock, so badges stay live on
 * the other tab); the dialogs are the dock's too, so the rail can open them.
 */

import { useMatch } from "react-router-dom";
import type { TeamData } from "@/hooks/useTeamData";
import { QueueRow, SpawnRequestRow, TeamButtons, TeammateRow } from "./TeamParts";
import { UserPlus, Users } from "lucide-react";

export function TeamPanel({
  team,
  sizeTitle,
  onSize,
  onSpawn,
}: {
  team: TeamData;
  sizeTitle: string;
  onSize: () => void;
  onSpawn: () => void;
}) {
  // Which teammate's view (if any) is in the center.
  const viewingId = useMatch("/teammates/:id")?.params.id ?? null;
  const { teammates, online, offline, pendingSpawns, queue } = team;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between gap-1 border-b border-border px-3">
        <span className="text-xs text-muted-foreground">
          {online.length} online{pendingSpawns.length > 0 ? ` · ${pendingSpawns.length} starting` : ""}
        </span>
        <div className="flex items-center">
          <TeamButtons sizeTitle={sizeTitle} poolBlocked={team.poolBlocked} onSize={onSize} onSpawn={onSpawn} />
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {pendingSpawns.length > 0 && (
          <div className="pb-1">
            <p className="px-1 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Pending spawns ({pendingSpawns.length})
            </p>
            {pendingSpawns.map((s) => (
              <SpawnRequestRow key={s.id} request={s} onCancel={team.cancelSpawn} />
            ))}
          </div>
        )}

        {online.map((t) => (
          <TeammateRow key={t.id} teammate={t} selected={t.id === viewingId} onDismiss={team.dismiss} onReset={team.reset} />
        ))}

        {offline.length > 0 && (
          <div className="pt-2">
            <p className="px-1 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Offline</p>
            {offline.map((t) => (
              <TeammateRow key={t.id} teammate={t} selected={t.id === viewingId} onDismiss={team.dismiss} />
            ))}
          </div>
        )}

        {teammates.length === 0 && (
          <p className="py-4 text-center text-xs text-muted-foreground">
            No teammates yet. Set the team size (<Users className="inline h-3 w-3" />) or spawn one (<UserPlus className="inline h-3 w-3" />) above.
          </p>
        )}

        {/* Live queue: non-terminal WorkItems + recovery actions. */}
        <div className="mt-1 border-t border-border pt-3">
          <p className="px-1 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Queue ({queue.length})
          </p>
          {queue.length === 0 && <p className="px-1 text-xs text-muted-foreground">Nothing queued or in flight.</p>}
          {queue.map((wi) => (
            <QueueRow key={wi.id} item={wi} onCancel={team.cancelItem} onForceFail={team.forceFail} />
          ))}
        </div>
      </div>
    </div>
  );
}
