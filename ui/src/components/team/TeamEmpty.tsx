/**
 * TeamEmpty — The Team tab with nobody online (the dock's components/team/
 * TeamPanel, and the phone's mobile/MobileTeam): what teammates are, who the
 * leader is, and how to get one going (docs/DESIGN.md "An Empty Screen
 * Teaches").
 *
 *  - **Spawn a teammate** opens the dock's Spawn dialog — when a spawn would
 *    actually happen: the daemon can start one (lib/empty-states.ts
 *    `spawnState`, from `/health`). Otherwise it's disabled, and the reason — and the
 *    daemon's own fix — says why. A failing readiness probe is said too: a
 *    teammate would start, but get no work until it passes.
 *  - **How to start the leader** unfolds the one command (`mpt lead`) and what
 *    it does: the leader is the assistant you chat with, and it's what grows
 *    the team to its size.
 *
 * The phone passes no `onSpawn` — spawning is setup, a desktop job (docs/DESIGN.md
 * "A Phone Is a Peek") — and says so instead. `/health` is only asked while this
 * is on screen.
 */

import { useId } from "react";
import { UserPlus, Users, AlertTriangle } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { LEADER_COMMAND, spawnState, type SpawnHealth } from "@/lib/empty-states";

export function TeamEmpty({ leaderPresent, onSpawn }: {
  /** Is a leader connected (the teammate pool's `leaderPresent`)? */
  leaderPresent: boolean;
  /** Open the Spawn dialog; omitted on the phone. */
  onSpawn?: () => void;
}) {
  const { data: health } = useApi<SpawnHealth>("/health", [], { pollInterval: 30_000 });
  const spawn = spawnState(health);
  const reasonId = useId();
  const readinessId = useId();

  // Where the team size and spawning are: this tab's icons, or (on the phone) the desktop.
  const leaderLine = onSpawn
    ? (leaderPresent
      ? "The leader is connected: spawn a teammate now, or set a team size (the people icon above) to keep some online."
      : "The leader isn't running yet.")
    : (leaderPresent
      ? "The leader is connected: spawn a teammate or set a team size from the desktop view."
      : "The leader isn't running yet; once it is, set a team size from the desktop view.");

  const detail = (
    <>
      <p className="max-w-md text-xs text-muted-foreground">{leaderLine}</p>
      {onSpawn && !spawn.canSpawn && (
        <p id={reasonId} className="max-w-md text-xs text-amber-700 dark:text-amber-400">{spawn.blockedReason}</p>
      )}
      {spawn.notReadyReason && (
        <p id={readinessId} className="flex max-w-md items-start gap-1 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          The team isn't ready ({spawn.notReadyReason}): no work is handed out until it is.
        </p>
      )}
    </>
  );

  return (
    <EmptyState kind="team" icon={Users} compact detail={detail}>
      {onSpawn && (
        <Button
          size="sm"
          onClick={onSpawn}
          disabled={!spawn.canSpawn}
          aria-describedby={[!spawn.canSpawn && reasonId, spawn.notReadyReason && readinessId].filter(Boolean).join(" ") || undefined}
        >
          <UserPlus className="mr-1 h-3.5 w-3.5" aria-hidden />Spawn a teammate
        </Button>
      )}
      <details className="w-full max-w-md text-left text-xs">
        <summary className="cursor-pointer rounded-sm py-1 text-center font-medium text-foreground">How to start the leader</summary>
        <div className="mt-2 space-y-1.5 rounded-md border border-border bg-muted/40 p-2 text-muted-foreground">
          <p>In a terminal, in your team's directory, run:</p>
          <pre className="rounded bg-background px-2 py-1 font-mono text-foreground"><code>{LEADER_COMMAND}</code></pre>
          <p>
            It opens the leader in a tmux window. The leader is the assistant you chat with,
            and it starts teammates to meet the team size.
          </p>
        </div>
      </details>
    </EmptyState>
  );
}
