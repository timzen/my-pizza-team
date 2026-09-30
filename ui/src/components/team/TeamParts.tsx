/**
 * TeamParts — The rows and avatars the Team tab and the dock's collapsed rail
 * are built from: an agent row (status icon, model, current work, directory,
 * context fill and session cost; reset / dismiss; teammates link to their live view), an
 * avatar for the rail, and a pending-spawn row. (Queue rows live on the Queue
 * tab — pages/QueuePage.)
 *
 * Status is the icon's shape — pairing, waiting, working, lost contact — not a
 * colored dot (docs/DESIGN.md "Teammate Status: Shape, not Color").
 *
 * Moved out of the old right-hand TeammateSidebar when the team joined the
 * assistant in the left SideDock (DESIGN.md "The Shell: a Dock and a Center").
 */

import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Trash2, RotateCcw, FolderOpen, Clock, X, Crown, User, Users, UserPlus, AlertTriangle, Bot, Loader, CloudOff, Gauge } from "lucide-react";
import { dirName, formatContext, formatCost, modelTitle, roleOf, statusLabel, viewPath, type FailedSpawn, type SpawnRequest, type Teammate } from "@/lib/team";

/**
 * The two team-level actions: set the steady team size, spawn one teammate in a
 * directory. The amber dot flags a size nothing can realize (no leader).
 */
export function TeamButtons({
  sizeTitle,
  poolBlocked,
  onSize,
  onSpawn,
}: {
  sizeTitle: string;
  poolBlocked: boolean;
  onSize: () => void;
  onSpawn: () => void;
}) {
  return (
    <>
      <Button variant="ghost" size="icon" className="relative h-7 w-7" onClick={onSize} title={sizeTitle} aria-label="Set team size">
        <Users className="h-4 w-4" />
        {poolBlocked && <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-amber-500" />}
      </Button>
      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onSpawn} title="Spawn a teammate in a directory" aria-label="Spawn teammate">
        <UserPlus className="h-4 w-4" />
      </Button>
    </>
  );
}

/**
 * What an agent is doing, as an icon: **person** pairing with you, **bot**
 * waiting for work, a turning **loader** working, **cloud-off** lost contact.
 * The leader keeps its crown while it's reachable.
 */
export function StatusIcon({ teammate, className }: { teammate: Teammate; className?: string }) {
  const label = statusLabel(teammate.status);
  const common = { className, "aria-label": label } as const;
  if (teammate.status === "offline") return <CloudOff {...common} />;
  if (roleOf(teammate) === "leader") return <Crown {...common} />;
  if (teammate.status === "pairing") return <User {...common} />;
  if (teammate.status === "working") {
    // Slow spin (reduced-motion users get a still loader — the shape still says "working").
    return <Loader {...common} className={`${className ?? ""} motion-safe:animate-[spin_2.5s_linear_infinite]`} />;
  }
  return <Bot {...common} />;
}

/** The model a teammate is running (its name; provider/id on hover), if reported. */
export function ModelName({ teammate, className }: { teammate: Teammate; className?: string }) {
  const m = teammate.session?.model;
  if (!m) return null;
  return <span className={cn("min-w-0 truncate text-[10px] text-muted-foreground", className)} title={modelTitle(m)}>{m.name}</span>;
}

/**
 * Context fill and session cost, compact: `◔ 42%  $1.25`. Renders nothing for
 * an agent whose harness doesn't report them.
 */
export function SessionStats({ teammate, className }: { teammate: Teammate; className?: string }) {
  const s = teammate.session;
  const ctx = formatContext(s);
  if (!s || (!ctx && !s.costUsd)) return null;
  return (
    <span className={cn("flex shrink-0 items-center gap-2 font-mono text-[10px] text-muted-foreground", className)}>
      {ctx && (
        <span className="flex items-center gap-0.5" title={ctx.title}>
          <Gauge className="h-3 w-3" aria-hidden />{ctx.label}
        </span>
      )}
      <span title={`Session cost: ${formatCost(s.costUsd)} (resets with each fresh session)`}>{formatCost(s.costUsd)}</span>
    </span>
  );
}

/** A circle with the status icon (collapsed rail). Teammates link to their view. */
export function TeammateAvatar({ teammate, selected }: { teammate: Teammate; selected?: boolean }) {
  const to = viewPath(teammate);
  const ctx = formatContext(teammate.session);
  const title = `${teammate.name} · ${statusLabel(teammate.status)}${teammate.session?.model ? ` · ${teammate.session.model.name}` : ""}${teammate.currentWork ? ` · ⚙️ ${teammate.currentWork}` : ""}` +
    `${ctx ? ` · ${ctx.label} context` : ""}${teammate.session ? ` · ${formatCost(teammate.session.costUsd)}` : ""}${to ? " — click to watch" : ""}`;
  const circle = (
    <div className={`h-8 w-8 rounded-full flex items-center justify-center bg-background border ${selected ? "border-primary ring-2 ring-primary/30" : "border-border"} ${teammate.status === "offline" ? "opacity-50" : ""}`}>
      <StatusIcon teammate={teammate} className="h-4 w-4" />
    </div>
  );
  return to
    ? <Link to={to} className="relative" title={title}>{circle}</Link>
    : <div className="relative" title={title}>{circle}</div>;
}

/** A pending spawn request row with a cancel button (expanded sidebar). */
/**
 * A spawn the daemon attempted and couldn't finish.
 *
 * Shows the reason, because the alternative is a team that is quietly one short with
 * nothing to explain why. Dismissing removes the record, not a teammate.
 */
export function FailedSpawnRow({ failure, onDismiss }: { failure: FailedSpawn; onDismiss: (id: string) => void }) {
  const dir = dirName(failure.cwd);
  return (
    <div className="group rounded-md border border-destructive/50 bg-destructive/5 p-2.5">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
        <span className="truncate text-sm font-medium">{failure.name || "(unnamed)"}</span>
        <button
          onClick={() => onDismiss(failure.id)}
          className="p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
          title="Dismiss this failure"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className="mt-1 text-[11px] text-destructive">{failure.error || "spawn failed"}</p>
      {(dir || failure.cwd) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <Badge variant="secondary" className="flex max-w-full items-center gap-1 font-mono text-[10px]" title={failure.cwd ?? undefined}>
            <FolderOpen className="h-2.5 w-2.5 shrink-0" />
            <span className="truncate">{dir || failure.cwd}</span>
          </Badge>
        </div>
      )}
    </div>
  );
}

export function SpawnRequestRow({ request, onCancel }: { request: SpawnRequest; onCancel: (id: string) => void }) {
  const dir = dirName(request.cwd);
  return (
    <div className="group rounded-md border border-dashed border-amber-500/50 bg-amber-500/5 p-2.5">
      <div className="flex items-center gap-2">
        <Clock className="h-3.5 w-3.5 shrink-0 text-amber-500 animate-pulse" />
        <span className="font-medium text-sm truncate flex-1">{request.name || "(unnamed)"}</span>
        <button
          onClick={() => onCancel(request.id)}
          className="text-muted-foreground hover:text-destructive p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
          title="Cancel spawn request"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className="text-[11px] text-muted-foreground mt-1">pending · no leader has picked this up</p>
      {(dir || request.cwd) && (
        <div className="flex items-center gap-1 mt-1.5 flex-wrap">
          <Badge variant="secondary" className="text-[10px] font-mono flex items-center gap-1 max-w-full" title={request.cwd ?? undefined}>
            <FolderOpen className="h-2.5 w-2.5 shrink-0" />
            <span className="truncate">{dir || request.cwd}</span>
          </Badge>
        </div>
      )}
    </div>
  );
}

export function TeammateRow({
  teammate,
  selected,
  onDismiss,
  onReset,
  skewReason,
}: {
  teammate: Teammate;
  selected?: boolean;
  onDismiss: (id: string) => void;
  onReset?: (t: Teammate) => void;
  /** Why this agent's extension is out of step, when it is (P1b-4). */
  skewReason?: string;
}) {
  const directory = teammate.directory || null;
  const dir = dirName(directory);
  const to = viewPath(teammate);

  // Teammate rows are clickable as a whole via a "stretched link" (the name's
  // ::after covers the card) so the action buttons can stay real buttons on top
  // — nesting buttons inside an <a> would be invalid.
  return (
    <div
      className={`group relative rounded-md border p-2.5 ${
        selected ? "border-primary bg-accent" : "border-border bg-background"
      } ${to ? "hover:border-primary/50" : ""} ${teammate.status === "offline" ? "opacity-60" : ""}`}
    >
      <div className="flex items-center gap-2">
        <span className="shrink-0" title={statusLabel(teammate.status)}>
          <StatusIcon teammate={teammate} className="h-3.5 w-3.5 text-muted-foreground" />
        </span>
        {skewReason && (
          <span className="relative z-10 shrink-0" title={skewReason} aria-label={skewReason}>
            <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
          </span>
        )}
        {to ? (
          <Link to={to} className="font-medium text-sm truncate flex-1 after:absolute after:inset-0 after:content-['']" title="Watch this teammate">
            {teammate.name}
          </Link>
        ) : (
          <span className="font-medium text-sm truncate flex-1">{teammate.name}</span>
        )}
        <ModelName teammate={teammate} className="relative z-10 max-w-[45%] shrink" />
        {teammate.harness && teammate.harness !== "pi" && (
          <span className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground" title={`${teammate.harness} teammate (experimental, via mpt agent)`}>
            {teammate.harness}
          </span>
        )}
        {/* Collapsed until hover/focus, so they don't hold space the model needs;
            on hover they take the model's place (it truncates). */}
        <div className="relative z-10 hidden items-center gap-0.5 group-hover:flex group-focus-within:flex">
          {/* Reset types Pi's /new; an ACP teammate already starts each item in a fresh session. */}
          {onReset && (!teammate.harness || teammate.harness === "pi") && (
            <button onClick={() => onReset(teammate)} className="text-muted-foreground hover:text-foreground p-0.5" title="Reset session (clears context window)">
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          )}
          <button onClick={() => onDismiss(teammate.id)} className="text-muted-foreground hover:text-destructive p-0.5" title="Dismiss teammate">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {teammate.currentWork && (
        <p className="text-xs text-muted-foreground mt-1 truncate" title={teammate.currentWork}>⚙️ {teammate.currentWork}</p>
      )}

      {(dir || teammate.session) && (
        <div className="flex items-center gap-1 mt-1.5">
          {dir && (
            <Badge variant="secondary" className="text-[10px] font-mono flex min-w-0 items-center gap-1" title={directory ?? undefined}>
              <FolderOpen className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate">{dir}</span>
            </Badge>
          )}
          <SessionStats teammate={teammate} className="ml-auto" />
        </div>
      )}
    </div>
  );
}
