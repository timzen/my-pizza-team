/**
 * TeamPanel — The dock's **Team** tab: the connected agents and the live queue.
 *
 * What used to be the right-hand TeammateSidebar, now a tab beside the
 * assistant in the left SideDock (DESIGN.md "The Shell: a Dock and a Center"):
 *
 *  - the teammates — the teammates (not the leader: it's the Assistant tab), each
 *    with status, current work, and working directory. Teammates open their live
 *    view in the center (`/teammates/:id`) and stay highlighted while it's
 *    there. Pending spawn requests and offline agents are listed too.
 *
 * The work queue isn't here: it's the dock's summary strip (under both tabs)
 * and the Queue tab on the home page.
 *
 * Presentational over `useTeamData` (owned by the dock, so badges stay live on
 * the other tab). The team-size and spawn buttons live in the dock's tab row
 * (right side, while this tab is active), and their dialogs are the dock's too,
 * so the rail can open them.
 *
 * With nobody online (and no spawn on its way) it shows TeamEmpty: what a
 * teammate is, who the leader is, Spawn a teammate (when a spawn would
 * happen), and how to start the leader. Offline teammates are still listed
 * under it.
 */

import { useMatch } from "react-router-dom";
import type { TeamData } from "@/hooks/useTeamData";
import { FailedSpawnRow, SpawnRequestRow, TeammateRow } from "./TeamParts";
import { TeamEmpty } from "./TeamEmpty";

export function TeamPanel({ team, onSpawn }: { team: TeamData; onSpawn: () => void }) {
  // Which teammate's view (if any) is in the center.
  const viewingId = useMatch("/teammates/:id")?.params.id ?? null;
  const { online, offline, pendingSpawns, failedSpawns, skewed } = team;
  const skewReasonFor = (id: string) => skewed.find((s) => s.teammate.id === id)?.reason;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {/*
          Version skew (P1b-4). Restarting is the fix; until then these agents keep
          working while quietly skipping whatever the newer protocol added — the
          silent failure docs/DESIGN.md "One Protocol, One Version" describes.
        */}
        {skewed.length > 0 && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
            <p className="font-medium text-amber-700 dark:text-amber-400">
              {skewed.length === 1 ? "An agent is" : `${skewed.length} agents are`} out of step with the daemon
            </p>
            <ul className="mt-1 space-y-0.5 text-muted-foreground">
              {skewed.map((s) => <li key={s.teammate.id}>{s.reason}</li>)}
            </ul>
            {/*
              Restarting is the only fix, and doing it one row at a time is the kind
              of chore people skip — so the banner carries the action.
            */}
            <button
              onClick={() => void team.restartSkewed()}
              className="mt-1.5 text-[11px] font-medium text-amber-700 underline hover:no-underline dark:text-amber-400"
            >
              Restart {skewed.length === 1 ? "it" : `all ${skewed.length}`} (rolls the session, clearing context)
            </button>
          </div>
        )}

        {failedSpawns.length > 0 && (
          <div className="pb-1">
            <p className="px-1 pb-1 text-xs font-medium uppercase tracking-wide text-destructive">
              Failed spawns ({failedSpawns.length})
            </p>
            {failedSpawns.map((f) => <FailedSpawnRow key={f.id} failure={f} onDismiss={team.cancelSpawn} />)}
          </div>
        )}

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

        {team.loaded && online.length === 0 && pendingSpawns.length === 0 && (
          <TeamEmpty leaderPresent={!!team.pool?.leaderPresent} onSpawn={onSpawn} />
        )}

        {online.map((t) => (
          <TeammateRow key={t.id} teammate={t} selected={t.id === viewingId} onDismiss={team.dismiss} onReset={team.reset} skewReason={skewReasonFor(t.id)} />
        ))}

        {offline.length > 0 && (
          <div className="pt-2">
            <p className="px-1 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Offline</p>
            {offline.map((t) => (
              <TeammateRow key={t.id} teammate={t} selected={t.id === viewingId} onDismiss={team.dismiss} />
            ))}
          </div>
        )}

      </div>
    </div>
  );
}
