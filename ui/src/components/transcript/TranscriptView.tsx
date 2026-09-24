/**
 * TranscriptView — A teammate's live Pi session, rendered CLI-ish.
 *
 * One monospace column that reads like the terminal (docs/TEAMMATE_CHAT.md §3),
 * not chat bubbles:
 *
 *   ── watching from 14:32 ──        where live coverage starts (no backfill)
 *   ❯ user input                     the work prompt / tmux typing; long ones collapse
 *   ✻ Thinking (12 lines)            reasoning, collapsed and dimmed
 *   ⏺ assistant prose                markdown
 *   ⏺ bash  ls -la                   a tool call…
 *     ⎿ output preview               …its (collapsible) result; red on error
 *   ▍ working…                       while a run is in flight
 *
 * Presentational: entries come from useTranscriptStream. Sticks to the bottom
 * while you're at the bottom, and leaves you alone once you scroll up.
 */

import { useEffect, useRef, useState } from "react";
import { MarkdownView } from "@/components/ui/markdown-view";
import type { TranscriptEntry } from "@/lib/transcript-types";

/** Lines shown before a user block / tool result collapses. */
const USER_PREVIEW_LINES = 6;
const RESULT_PREVIEW_LINES = 4;
/** Within this many px of the bottom counts as "following". */
const STICK_PX = 80;

type Of<K extends TranscriptEntry["kind"]> = Extract<TranscriptEntry, { kind: K }>;

export function TranscriptView({ entries, empty }: { entries: TranscriptEntry[]; empty?: React.ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);

  // Track whether the reader is at the bottom (scroll events, not render reads).
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) following.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const running = isRunning(entries);
  const visible = entries.filter((e) => e.kind !== "run");
  // Markers alone (just started watching) still count as "nothing yet".
  const hasContent = visible.some((e) => e.kind !== "watch" && e.kind !== "session");

  return (
    <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto bg-background px-4 py-3 font-mono text-[13px] leading-relaxed">
      <div className="space-y-2">
        {visible.map((e) => <EntryRow key={e.seq} entry={e} />)}
      </div>
      {!hasContent && !running && <div className="mt-2">{empty}</div>}
      {running && (
        <p className="mt-2 text-muted-foreground">
          <span className="inline-block w-2 animate-pulse bg-foreground/70">&nbsp;</span> working…
        </p>
      )}
    </div>
  );
}

/** A run is in flight if the latest run marker is a start. */
function isRunning(entries: TranscriptEntry[]): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.kind === "run") return e.state === "start";
    if (e.kind === "session") return false;
  }
  return false;
}

function EntryRow({ entry }: { entry: TranscriptEntry }) {
  switch (entry.kind) {
    case "watch": return <Divider label={`watching from ${clock(entry.at)}`} />;
    case "session": return <Divider label={`new session · ${clock(entry.at)}`} />;
    case "user": return <UserBlock entry={entry} />;
    case "message": return <MessageBlock entry={entry} />;
    case "tool": return <ToolBlock entry={entry} />;
    default: return null;
  }
}

function Divider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      <span>{label}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function UserBlock({ entry }: { entry: Of<"user"> }) {
  const lines = entry.text.split("\n");
  const [open, setOpen] = useState(lines.length <= USER_PREVIEW_LINES);
  const shown = open ? entry.text : lines.slice(0, USER_PREVIEW_LINES).join("\n");
  return (
    <div className="rounded-sm border-l-2 border-primary/60 bg-muted/50 py-1 pl-2 pr-2">
      <div className="flex gap-2">
        <span className="select-none text-primary">❯</span>
        <div className="min-w-0 flex-1">
          {entry.origin === "tui" && <span className="mr-2 text-xs text-muted-foreground">[terminal]</span>}
          <span className="whitespace-pre-wrap break-words">{shown}</span>
          {lines.length > USER_PREVIEW_LINES && (
            <button type="button" onClick={() => setOpen(!open)} className="block text-xs text-muted-foreground hover:text-foreground">
              {open ? "▴ collapse" : `▾ ${lines.length - USER_PREVIEW_LINES} more lines`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function MessageBlock({ entry }: { entry: Of<"message"> }) {
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const thinking = entry.thinking?.trim() || "";
  const text = entry.text?.trim() || "";
  if (!thinking && !text) return null;
  return (
    <div className="space-y-1">
      {thinking && (
        <div className="text-muted-foreground">
          <button type="button" onClick={() => setThinkingOpen(!thinkingOpen)} className="italic hover:text-foreground">
            ✻ Thinking {thinkingOpen ? "▴" : `(${thinking.split("\n").length} lines) ▾`}
          </button>
          {thinkingOpen && <p className="mt-1 whitespace-pre-wrap border-l border-border pl-3 italic opacity-80">{thinking}</p>}
        </div>
      )}
      {text && (
        <div className="flex gap-2">
          <span className="select-none">⏺</span>
          <MarkdownView content={text} className="min-w-0 flex-1 !text-[13px] [&_p]:mb-1" />
        </div>
      )}
    </div>
  );
}

function ToolBlock({ entry }: { entry: Of<"tool"> }) {
  const [open, setOpen] = useState(false);
  const result = entry.result?.replace(/\s+$/, "") || "";
  const lines = result ? result.split("\n") : [];
  const shown = open ? lines : lines.slice(0, RESULT_PREVIEW_LINES);
  const dot = entry.state === "running" ? "animate-pulse text-amber-500" : entry.state === "error" ? "text-destructive" : "text-green-600";
  return (
    <div>
      <div className="flex gap-2">
        <span className={`select-none ${dot}`}>⏺</span>
        <span className="min-w-0 flex-1 break-words">
          <span className="font-semibold">{entry.name}</span>{" "}
          <span className="text-muted-foreground">{summarizeArgs(entry.args)}</span>
        </span>
      </div>
      {lines.length > 0 && (
        <div className={`ml-4 flex gap-2 ${entry.state === "error" ? "text-destructive" : "text-muted-foreground"}`}>
          <span className="select-none">⎿</span>
          <div className="min-w-0 flex-1">
            <pre className="whitespace-pre-wrap break-words font-mono">{shown.join("\n")}</pre>
            {lines.length > RESULT_PREVIEW_LINES && (
              <button type="button" onClick={() => setOpen(!open)} className="text-xs hover:text-foreground">
                {open ? "▴ collapse" : `▾ ${lines.length - RESULT_PREVIEW_LINES} more lines`}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One line summarizing a tool call's args: the field a human would look for
 * (a command, a path, a pattern), else compact JSON.
 */
function summarizeArgs(args: unknown): string {
  if (args === undefined) return "(already running when you started watching)";
  if (!args || typeof args !== "object") return String(args ?? "");
  const a = args as Record<string, unknown>;
  for (const k of ["command", "path", "file_path", "pattern", "url", "query"]) {
    if (typeof a[k] === "string") return oneLine(a[k] as string);
  }
  return oneLine(JSON.stringify(args));
}

function oneLine(s: string, max = 200): string {
  const flat = s.replace(/\s*\n\s*/g, " ⏎ ");
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
