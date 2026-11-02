/**
 * TeamParts — The rows and avatars the Team tab and the dock's collapsed rail
 * are built from: an agent row (status icon, model, current work and the
 * persona it's working with — a chip linking to the persona, docs/DESIGN.md
 * "The in-flight persona" — directory, context fill and session cost; reset /
 * dismiss; teammates link to their live view), an
 * avatar for the rail, and a pending-spawn row. (Queue rows live on the Queue
 * tab — pages/QueuePage.)
 *
 * Status is the icon's shape — pairing, waiting, working, lost contact — not a
 * colored dot (docs/DESIGN.md "Teammate Status: Shape, not Color"), and it's
 * always there as text too: the icon is an image named by `statusLabel`, and
 * a row's link and an avatar are named/hinted by the whole summary
 * (lib/team.ts teammateSummary), so the hints the row's parts show on hover
 * also show when the keyboard reaches the row.
 *
 * Moved out of the old right-hand TeammateSidebar when the team joined the
 * assistant in the left SideDock (DESIGN.md "The Shell: a Dock and a Center").
 */

import { Link } from "react-router-dom";
import { PersonaChip } from "@/components/personas/PersonaChip";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { IconButton } from "@/components/ui/icon-button";
import { Tooltip } from "@/components/ui/tooltip";
import { Trash2, RotateCcw, FolderOpen, Clock, X, Crown, User, Users, UserPlus, AlertTriangle, Bot, Loader, CloudOff, Gauge } from "lucide-react";
import { dirName, formatContext, formatCost, modelTitle, roleOf, statusLabel, teammateSummary, viewPath, type FailedSpawn, type SpawnRequest, type Teammate } from "@/lib/team";

/**
 * The two team-level actions: set the steady team size, spawn one teammate in a
 * directory. The amber dot flags a size nothing can realize (no leader).
 */
export function TeamButtons({
  sizeTitle,
  poolBlocked,
  onSize,
  onSpawn,
  tooltipSide,
}: {
  sizeTitle: string;
  poolBlocked: boolean;
  onSize: () => void;
  onSpawn: () => void;
  /** Where the hints open ("right" on the collapsed rail, so they clear its edge). */
  tooltipSide?: "top" | "right";
}) {
  return (
    <>
      <IconButton className="relative h-7 w-7" onClick={onSize} label="Set team size" hint={sizeTitle} side={tooltipSide}>
        <Users className="h-4 w-4" />
        {poolBlocked && <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-amber-500" />}
      </IconButton>
      <IconButton className="h-7 w-7" onClick={onSpawn} label="Spawn teammate" hint="Spawn a teammate in a directory" side={tooltipSide}>
        <UserPlus className="h-4 w-4" />
      </IconButton>
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
  // An image with a name, not a decorative icon: the shape *is* the status.
  const common = { className, role: "img", "aria-label": label } as const;
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
  return (
    <Tooltip content={modelTitle(m)}>
      <span className={cn("min-w-0 truncate text-[10px] text-muted-foreground", className)}>{m.name}</span>
    </Tooltip>
  );
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
        <Tooltip content={ctx.title}>
          <span className="flex items-center gap-0.5">
            <Gauge className="h-3 w-3" aria-hidden />{ctx.label}
          </span>
        </Tooltip>
      )}
      <Tooltip content={`Session cost: ${formatCost(s.costUsd)} (resets with each fresh session)`}>
        <span>{formatCost(s.costUsd)}</span>
      </Tooltip>
    </span>
  );
}

/** A circle with the status icon (collapsed rail). Teammates link to their view. */
export function TeammateAvatar({ teammate, selected }: { teammate: Teammate; selected?: boolean }) {
  const to = viewPath(teammate);
  const summary = teammateSummary(teammate);
  const circle = (
    <div className={`h-8 w-8 rounded-full flex items-center justify-center bg-background border ${selected ? "border-primary ring-2 ring-primary/30" : "border-border"} ${teammate.status === "offline" ? "opacity-50" : ""}`}>
      <StatusIcon teammate={teammate} className="h-4 w-4" />
    </div>
  );
  // A link is named by the summary (and says where it goes); a plain avatar is
  // focusable so the keyboard can read the same hint.
  return to
    ? (
      <Tooltip content={`${summary} — watch`} describe={false} side="right">
        <Link to={to} className="relative" aria-label={`Watch ${summary}`}>{circle}</Link>
      </Tooltip>
    )
    : (
      <Tooltip content={summary} describe={false} focusable side="right">
        <div className="relative" role="img" aria-label={summary}>{circle}</div>
      </Tooltip>
    );
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
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" role="img" aria-label="Spawn failed" />
        <span className="truncate text-sm font-medium">{failure.name || "(unnamed)"}</span>
        <Tooltip content="Dismiss this failure" describe={false}>
          <button
            onClick={() => onDismiss(failure.id)}
            className="p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
            aria-label="Dismiss this failure"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
      </div>
      <p className="mt-1 text-[11px] text-destructive">{failure.error || "spawn failed"}</p>
      {(dir || failure.cwd) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <Tooltip content={failure.cwd ?? undefined}>
            <Badge variant="secondary" className="flex max-w-full items-center gap-1 font-mono text-[10px]">
              <FolderOpen className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate">{dir || failure.cwd}</span>
            </Badge>
          </Tooltip>
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
        <Clock className="h-3.5 w-3.5 shrink-0 text-amber-600 animate-pulse" />
        <span className="font-medium text-sm truncate flex-1">{request.name || "(unnamed)"}</span>
        <Tooltip content="Cancel spawn request" describe={false}>
          <button
            onClick={() => onCancel(request.id)}
            className="text-muted-foreground hover:text-destructive p-0.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
            aria-label="Cancel spawn request"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
      </div>
      <p className="text-[11px] text-muted-foreground mt-1">pending · no leader has picked this up</p>
      {(dir || request.cwd) && (
        <div className="flex items-center gap-1 mt-1.5 flex-wrap">
          <Tooltip content={request.cwd ?? undefined}>
            <Badge variant="secondary" className="text-[10px] font-mono flex items-center gap-1 max-w-full">
              <FolderOpen className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate">{dir || request.cwd}</span>
            </Badge>
          </Tooltip>
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
  href,
}: {
  teammate: Teammate;
  selected?: boolean;
  /** Absent = no actions (the phone view: hover-revealed buttons don't exist on touch). */
  onDismiss?: (id: string) => void;
  onReset?: (t: Teammate) => void;
  /** Why this agent's extension is out of step, when it is (P1b-4). */
  skewReason?: string;
  /** Where the row links, overriding its live view (the phone view's own route). */
  href?: string | null;
}) {
  const directory = teammate.directory || null;
  const dir = dirName(directory);
  const to = href !== undefined ? href : viewPath(teammate);

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
        <Tooltip content={statusLabel(teammate.status)} describe={false}>
          <span className="shrink-0">
            <StatusIcon teammate={teammate} className="h-3.5 w-3.5 text-muted-foreground" />
          </span>
        </Tooltip>
        {skewReason && (
          <Tooltip content={skewReason} describe={false}>
            <span className="relative z-10 shrink-0">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-600" role="img" aria-label={skewReason} />
            </span>
          </Tooltip>
        )}
        {to ? (
          // The link's tooltip is the whole row in words, so a keyboard user
          // gets the hints (model, context, cost) the row's parts show on hover.
          <Tooltip content={`Watch · ${teammateSummary(teammate)}`} describe={false}>
            <Link to={to} className="font-medium text-sm truncate flex-1 after:absolute after:inset-0 after:content-['']" aria-label={`Watch ${teammateSummary(teammate)}`}>
              {teammate.name}
            </Link>
          </Tooltip>
        ) : (
          <span className="font-medium text-sm truncate flex-1">{teammate.name}</span>
        )}
        <ModelName teammate={teammate} className="relative z-10 max-w-[45%] shrink" />
        {teammate.harness && teammate.harness !== "pi" && (
          <Tooltip content={`${teammate.harness} teammate (experimental, via mpt agent)`}>
            <span className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground">
              {teammate.harness}
            </span>
          </Tooltip>
        )}
        {/* Collapsed until hover/focus, so they don't hold space the model needs;
            on hover they take the model's place (it truncates). */}
        {(onDismiss || onReset) && (
        <div className="relative z-10 hidden items-center gap-0.5 group-hover:flex group-focus-within:flex">
          {/* Reset types Pi's /new; an ACP teammate already starts each item in a fresh session. */}
          {onReset && (!teammate.harness || teammate.harness === "pi") && (
            <Tooltip content="Reset session (clears context window)">
              <button onClick={() => onReset(teammate)} className="text-muted-foreground hover:text-foreground p-0.5" aria-label={`Reset ${teammate.name}'s session`}>
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          )}
          {onDismiss && (
            <Tooltip content="Dismiss teammate" describe={false}>
              <button onClick={() => onDismiss(teammate.id)} className="text-muted-foreground hover:text-destructive p-0.5" aria-label={`Dismiss ${teammate.name}`}>
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          )}
        </div>
        )}
      </div>

      {(teammate.currentWork || teammate.persona) && (
        <div className="mt-1 flex min-w-0 items-center gap-1.5">
          {teammate.currentWork && (
            <p className="min-w-0 truncate text-xs text-muted-foreground" title={teammate.currentWork}>⚙️ {teammate.currentWork}</p>
          )}
          {/* Above the row's stretched link, so the chip opens the persona, not the teammate. */}
          <PersonaChip persona={teammate.persona} className="relative z-10 shrink-0 max-w-[50%]" />
        </div>
      )}

      {(dir || teammate.session) && (
        <div className="flex items-center gap-1 mt-1.5">
          {dir && (
            <Tooltip content={directory ?? undefined}>
              <Badge variant="secondary" className="text-[10px] font-mono flex min-w-0 items-center gap-1">
                <FolderOpen className="h-2.5 w-2.5 shrink-0" />
                <span className="truncate">{dir}</span>
              </Badge>
            </Tooltip>
          )}
          <SessionStats teammate={teammate} className="ml-auto" />
        </div>
      )}
    </div>
  );
}
