/**
 * TeamParts — The rows and avatars the Team tab and the dock's collapsed rail
 * are built from: an agent row (status, current work, directory; reset /
 * dismiss; teammates link to their live view), an avatar for the rail, a
 * pending-spawn row, and a queue row with recovery actions (cancel a READY
 * item; force-fail a MORIBUND one, optionally re-enqueuing).
 *
 * Moved out of the old right-hand TeammateSidebar when the team joined the
 * assistant in the left SideDock (DESIGN.md "The Shell: a Dock and a Center").
 */

import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Trash2, RotateCcw, FolderOpen, Clock, X, Crown, User, Ban, AlertTriangle, Users, UserPlus } from "lucide-react";
import { STATUS_DOT, dirName, roleOf, viewPath, type QueueItem, type Role, type SpawnRequest, type Teammate } from "@/lib/team";

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

/** Role icon for the collapsed rail / row prefix. */
export function RoleIcon({ role, className }: { role: Role; className?: string }) {
  if (role === "leader") return <Crown className={className} />;
  return <User className={className} />;
}

/** A status-colored circle with a role icon (collapsed rail). Teammates link to their view. */
export function TeammateAvatar({ teammate, selected }: { teammate: Teammate; selected?: boolean }) {
  const role = roleOf(teammate);
  const to = viewPath(teammate);
  const title = `${teammate.name} · ${teammate.status}${teammate.currentWork ? ` · ⚙️ ${teammate.currentWork}` : ""}${to ? " — click to watch" : ""}`;
  const circle = (
    <>
      <div className={`h-8 w-8 rounded-full flex items-center justify-center bg-background border ${selected ? "border-primary ring-2 ring-primary/30" : "border-border"} ${teammate.status === "offline" ? "opacity-50" : ""}`}>
        <RoleIcon role={role} className="h-4 w-4" />
      </div>
      <span className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-muted/30 ${STATUS_DOT[teammate.status] || STATUS_DOT.offline}`} />
    </>
  );
  return to
    ? <Link to={to} className="relative" title={title}>{circle}</Link>
    : <div className="relative" title={title}>{circle}</div>;
}

/** A pending spawn request row with a cancel button (expanded sidebar). */
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
}: {
  teammate: Teammate;
  selected?: boolean;
  onDismiss: (id: string) => void;
  onReset?: (t: Teammate) => void;
}) {
  const role = roleOf(teammate);
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
        <span className={`h-2 w-2 rounded-full shrink-0 ${STATUS_DOT[teammate.status] || STATUS_DOT.offline}`} title={teammate.status} />
        <RoleIcon role={role} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        {to ? (
          <Link to={to} className="font-medium text-sm truncate flex-1 after:absolute after:inset-0 after:content-['']" title="Watch this teammate">
            {teammate.name}
          </Link>
        ) : (
          <span className="font-medium text-sm truncate flex-1">{teammate.name}</span>
        )}
        <div className="relative z-10 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {onReset && teammate.hostId && (
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

      {dir && (
        <div className="flex items-center gap-1 mt-1.5 flex-wrap">
          <Badge variant="secondary" className="text-[10px] font-mono flex items-center gap-1 max-w-full" title={directory ?? undefined}>
            <FolderOpen className="h-2.5 w-2.5 shrink-0" />
            <span className="truncate">{dir}</span>
          </Badge>
        </div>
      )}
    </div>
  );
}

const QUEUE_CHIP: Record<string, { label: string; cls: string }> = {
  READY: { label: "queued", cls: "text-muted-foreground" },
  IN_PROGRESS: { label: "working", cls: "text-green-600 border-green-500/50" },
  MORIBUND: { label: "at risk", cls: "text-amber-600 border-amber-500/50" },
};

/** A non-terminal WorkItem with state-appropriate recovery actions. */
export function QueueRow({
  item,
  onCancel,
  onForceFail,
}: {
  item: QueueItem;
  onCancel: (id: string) => void;
  onForceFail: (id: string, reEnqueue: boolean) => void;
}) {
  const chip = QUEUE_CHIP[item.state] || QUEUE_CHIP.READY!;
  return (
    <div className="group rounded-md border border-border bg-background p-2.5 mb-2">
      <div className="flex items-center gap-2">
        {item.state === "MORIBUND" && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />}
        <span className="text-sm truncate flex-1" title={item.title}>{item.title}</span>
        <Badge variant="outline" className={`text-[10px] px-1 py-0 shrink-0 ${chip.cls}`}>{chip.label}</Badge>
      </div>
      {item.memberId && (
        <p className="text-[11px] text-muted-foreground mt-1 truncate">held by {item.memberId}</p>
      )}
      <div className="flex items-center gap-1 mt-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {item.state === "READY" && (
          <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={() => onCancel(item.id)} title="Cancel this queued item">
            <Ban className="h-3 w-3 mr-1" />Cancel
          </Button>
        )}
        {item.state === "MORIBUND" && (
          <>
            <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={() => onForceFail(item.id, false)} title="Force this abandoned item to FAILED">
              <X className="h-3 w-3 mr-1" />Force-fail
            </Button>
            <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={() => onForceFail(item.id, true)} title="Force-fail and enqueue a fresh attempt">
              <RotateCcw className="h-3 w-3 mr-1" />Re-enqueue
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
