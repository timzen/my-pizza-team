/**
 * StartAssistant — The **Start the assistant** button, shown wherever the UI
 * used to send a new user to a terminal to run `mpt lead`: the Welcome
 * checklist's first step (components/onboarding/WelcomeCard), the Team tab's
 * empty state (components/team/TeamEmpty), the team-size dialog's "no leader"
 * warning (components/TeamSizeDialog), and the chat with no one to answer it
 * (components/assistant/AssistantPane — the dock and the phone's Chat).
 *
 *   [▶ Start the assistant]
 *   ▸ Or from a terminal
 *
 * A click asks the daemon to start it (`POST /api/assistant/start`; the daemon
 * drives the terminal, tmux or herdr, docs/DESIGN.md "The Daemon Is the Supervisor"). While the request
 * runs, and after it succeeds, the button reads "Starting…" (disabled, but still
 * focusable, so focus stays put) with a note on where it runs, until the leader
 * registers: the host's own presence data flips (the onboarding step, the pool's
 * `leaderPresent`, the chat's `chatAgent`) and the host stops rendering this. A
 * refusal shows the daemon's reason and fix inline, and the button is offered
 * again. When `/health` says it can't be started at all (`assistantStartable`),
 * the reason and fix show instead of the button. The rules are
 * lib/start-assistant.ts.
 *
 * The terminal command stays as a secondary disclosure ("Or from a terminal"),
 * with a copy button — for a user who wants the window attached, or a daemon
 * that can't reach the terminal. Where the note names the window, it names the
 * terminal and the attach command the daemon reported (`terminal`, `attach`).
 *
 * Accessibility (docs/ACCESSIBILITY.md): a real button; "Starting the
 * assistant…" and the success are announced politely and an error assertively
 * (FormError) — the leader connecting is the host's news (the Welcome step
 * ticking off is announced already); the note and the error describe the button. When the
 * host removes this with focus inside it (the leader connected), focus moves to
 * the nearest heading that's still on screen rather than dropping to the body.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Check, Copy, Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import { apiPost, useApi } from "@/hooks/useApi";
import { useAnnounce } from "@/hooks/useAnnounce";
import { focusTarget } from "@/hooks/useRouteFocus";
import { LEADER_COMMAND } from "@/lib/empty-states";
import {
  START_SLOW_MS, START_UNREACHABLE, startAvailability, startOutcome,
  type StartHealth, type StartOutcome, type StartResponse,
} from "@/lib/start-assistant";
import { cn } from "@/lib/utils";

/** Where a click has got to. */
type Phase = { kind: "idle" } | { kind: "busy" } | StartOutcome;

export function StartAssistant({ size = "sm", command = true, className }: {
  /** The button's size: `sm` (default), or `xs` in tight rows (the Welcome checklist, the chat). */
  size?: "xs" | "sm";
  /** Offer the "Or from a terminal" disclosure (default true). */
  command?: boolean;
  className?: string;
}) {
  const { data: health } = useApi<StartHealth>("/health", [], { pollInterval: 30_000 });
  const available = startAvailability(health);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [slow, setSlow] = useState(false);
  const announce = useAnnounce();
  const rootRef = useRef<HTMLDivElement>(null);
  const base = useId();
  const noteId = `${base}-note`;
  const errorId = `${base}-error`;
  const reasonId = `${base}-reason`;

  // "Starting…" that lasts a minute gets a hint: the window needs a look.
  useEffect(() => {
    if (phase.kind !== "starting") return;
    const t = setTimeout(() => setSlow(true), START_SLOW_MS);
    return () => clearTimeout(t);
  }, [phase.kind]);

  // The host removes this once the leader connects. If focus was in it, don't
  // let it drop to the body: put it on the nearest heading still on screen.
  // A layout effect, so its cleanup runs while this is still in the document.
  useLayoutEffect(() => {
    const root = rootRef.current;
    return () => {
      if (!root) return;
      const hadFocus = root.contains(document.activeElement);
      const ancestors: HTMLElement[] = [];
      for (let el = root.parentElement; el; el = el.parentElement) ancestors.push(el);
      if (!hadFocus) return;
      requestAnimationFrame(() => {
        if (document.activeElement && document.activeElement !== document.body) return;
        const host = ancestors.find((el) => el.isConnected && el.querySelector("h1, h2, h3"));
        const heading = host?.querySelector<HTMLElement>("h1, h2, h3");
        if (heading) focusTarget(heading);
      });
    };
  }, []);

  const start = async () => {
    if (phase.kind === "busy" || phase.kind === "starting") return;
    setPhase({ kind: "busy" });
    setSlow(false);
    announce("Starting the assistant…");
    let outcome: StartOutcome;
    try {
      outcome = startOutcome(await apiPost<StartResponse>("/api/assistant/start"));
    } catch {
      outcome = { kind: "error", message: START_UNREACHABLE };
    }
    setPhase(outcome);
    if (outcome.kind === "starting") {
      announce(outcome.already
        ? "The assistant is already running; waiting for it to connect."
        : "The assistant is starting; it will answer once it connects.");
    }
  };

  const pending = phase.kind === "busy" || phase.kind === "starting";
  const where = phase.kind === "starting" ? phase.where : null;
  const attach = phase.kind === "starting" ? phase.attach : null;
  const terminal = phase.kind === "starting" ? phase.terminal : null;

  return (
    <div ref={rootRef} className={cn("space-y-1.5", className)} data-start-assistant="">
      {available.canStart ? (
        <Button
          size={size}
          onClick={start}
          disabled={pending}
          focusableWhenDisabled
          aria-describedby={[phase.kind === "starting" && noteId, phase.kind === "error" && errorId].filter(Boolean).join(" ") || undefined}
        >
          {pending ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Play aria-hidden />}
          {phase.kind === "busy" ? "Starting the assistant…" : phase.kind === "starting" ? "Starting…" : "Start the assistant"}
        </Button>
      ) : (
        <p id={reasonId} className="text-xs text-amber-700 dark:text-amber-400">
          The assistant can't be started from here: {available.reason}. To fix it, {available.fix}.
        </p>
      )}
      {phase.kind === "starting" && (
        <p id={noteId} className="text-xs text-muted-foreground">
          {phase.already ? "It's already running" : "It's starting"}
          {where ? <> in the {terminal ? `${terminal} ` : ""}window <code className="font-mono">{where}</code></> : null}
          ; it shows up here once it connects.
          {slow && attach && <> Still nothing? Run <code className="font-mono">{attach}</code> to see that window.</>}
        </p>
      )}
      <FormError id={errorId} className="text-xs">{phase.kind === "error" ? phase.message : null}</FormError>
      {command && <TerminalCommand />}
    </div>
  );
}

/** "Or from a terminal": the CLI command that starts the assistant, with a copy button. */
function TerminalCommand() {
  const [copied, setCopied] = useState(false);
  const announce = useAnnounce();
  const copy = () => {
    navigator.clipboard?.writeText(LEADER_COMMAND)
      .then(() => { setCopied(true); announce("Copied"); setTimeout(() => setCopied(false), 1500); })
      .catch(() => announce("Couldn't copy; select the command and copy it yourself", "assertive"));
  };
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer rounded-sm py-0.5 font-medium text-foreground">Or from a terminal</summary>
      <div className="mt-1 space-y-1">
        <p>In your team's directory, run:</p>
        <div className="flex items-center gap-2">
          <code className="rounded bg-muted px-2 py-1 font-mono text-foreground">{LEADER_COMMAND}</code>
          <Button variant="outline" size="xs" onClick={copy} aria-label={`Copy the command ${LEADER_COMMAND}`}>
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}{copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <p>It opens the same window and attaches you to it.</p>
      </div>
    </details>
  );
}
