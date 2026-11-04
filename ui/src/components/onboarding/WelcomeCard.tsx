/**
 * WelcomeCard — The first-run Welcome checklist (docs/DESIGN.md "First run: a
 * checklist, not a tour"), above Home's Queue/Inbox tabs (pages/RootPage) and
 * at the top of the phone's Team tab (mobile/MobileTeam).
 *
 *   ┌ Welcome to your team ─────────────────────────── Dismiss ┐
 *   │ A few first steps… You can reopen this from Help.        │
 *   │ ███████░░░░░░░░  2 of 7 done                             │
 *   │ ✓ Start the assistant            Done          Learn more   │
 *   │ ● Get a teammate              Next                       │
 *   │   Teammates are the agents…   [Spawn a teammate]         │
 *   │ ○ Create your first task      [Use a sample task] …      │
 *   └──────────────────────────────────────────────────────────┘
 *
 * The steps and whether each is done come from the daemon (`GET
 * /api/onboarding`, hooks/useOnboarding — polled, each tick announced); their
 * words and "Learn more" sections from lib/onboarding.ts `WELCOME_STEPS`. Every
 * undone step offers its action; the next one (the first undone, in order) is
 * highlighted and says what it is. When the last step ticks, the card says
 * "You're set" with a few guide topics to read next, and goes once closed (the
 * daemon has latched it complete, so it doesn't come back on reload).
 * **Dismiss** hides it for good, until Help's "Show the Welcome checklist"
 * (components/onboarding/ShowWelcomeButton). Under its hint, **Take the tour**
 * offers the optional guided tour of the screen until this browser has taken
 * or skipped it (components/tour/TakeTourButton; not on the phone).
 *
 * Accessibility (docs/ACCESSIBILITY.md): a `<section>` region named by its h2;
 * the steps are an ordered list whose done / next / not-done state is text
 * (visible, plus a screen-reader prefix), not only the icon; the meter is a
 * `progressbar` with a text value. When the card or a step's action goes
 * away under the keyboard (Dismiss, Run), focus moves to the page's h1 or the
 * card's heading rather than dropping to the body.
 *
 * On the phone (`phone`), only the next step shows its action, spawning is
 * left out — it's setup, a desktop job ("A Phone Is a Peek") — and the links
 * go to the phone's tabs. The first step's action is **Start the assistant**
 * (components/assistant/StartAssistant) on both: one tap, no terminal.
 */

import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, Circle, CircleDot, FlaskConical, Inbox, ListOrdered, PenLine, StickyNote, UserPlus } from "lucide-react";
import type { CreateSampleTaskResponse, OnboardingSampleTask, OnboardingStepId } from "@shared/protocol";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DirectoryInput } from "@/components/ui/directory-input";
import { FormError } from "@/components/ui/form-error";
import { AskAssistantButton, LearnMore } from "@/components/ui/empty-state";
import { SpawnDialog } from "@/components/SpawnDialog";
import { StartAssistant } from "@/components/assistant/StartAssistant";
import { apiPost, useApi } from "@/hooks/useApi";
import { useAnnounce } from "@/hooks/useAnnounce";
import { useFeatures } from "@/hooks/useFeatures";
import { useOnboarding } from "@/hooks/useOnboarding";
import { focusTarget } from "@/hooks/useRouteFocus";
import { spawnState, type SpawnHealth } from "@/lib/empty-states";
import { filterByFeatures } from "@/lib/features";
import { HELP_ROOT, MOBILE_HELP_ROOT, helpPath } from "@/lib/help";
import { MOBILE_TAB_PATHS } from "@/lib/mobile";
import { WELCOME_NEXT_READING, WELCOME_STEPS, welcomeProgress } from "@/lib/onboarding";
import { START_WORK } from "@/lib/start-work";
import { cn } from "@/lib/utils";
import { TakeTourButton } from "@/components/tour/TakeTourButton";

/** The id of the phone Team tab's Queue heading, which "Watch it run" moves focus to. */
export const MOBILE_QUEUE_HEADING_ID = "mobile-team-queue";

/** Shared by every link-styled action in the card: underlined, not only colored (WCAG 1.4.1). */
const LINK_CLASS = "inline-flex min-h-6 items-center gap-1 rounded-sm px-1 text-sm text-primary underline underline-offset-2 hover:decoration-2";

export function WelcomeCard({ phone = false }: { phone?: boolean }) {
  const { data, mode, refetch, dismiss } = useOnboarding();
  const announce = useAnnounce();
  const headingId = useId();
  const hintId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const cardRef = useRef<HTMLElement>(null);

  if (mode === "hidden" || !data) return null;

  const close = async () => {
    // The card unmounts: put focus on the page's heading, not the body.
    const h1 = cardRef.current?.closest("main")?.querySelector<HTMLElement>("h1");
    await dismiss();
    announce(mode === "done" ? "Welcome checklist closed." : "Welcome checklist dismissed. You can reopen it from Help.");
    if (h1) focusTarget(h1);
  };
  const focusHeading = () => { if (headingRef.current) focusTarget(headingRef.current); };
  const helpRoot = phone ? MOBILE_HELP_ROOT : HELP_ROOT;

  if (mode === "done") {
    return (
      <section ref={cardRef} aria-labelledby={headingId} data-welcome-card="done" className="space-y-2 rounded-lg border border-border bg-card p-4">
        <div className="flex items-start gap-2">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
          <div className="min-w-0 flex-1 space-y-1">
            <h2 id={headingId} ref={headingRef} tabIndex={-1} className="font-semibold">You're set</h2>
            <p className="text-sm text-muted-foreground">Every first step is done. To get more from your team, read on:</p>
          </div>
          <Button variant="ghost" size="sm" onClick={close}>Close</Button>
        </div>
        <ul aria-label="Guide topics to read next" className="flex flex-wrap gap-x-3 gap-y-1 pl-7">
          {WELCOME_NEXT_READING.map((t) => (
            <li key={t.topic}><Link to={helpPath(t.topic, undefined, helpRoot)} className={LINK_CLASS}>{t.label}</Link></li>
          ))}
        </ul>
      </section>
    );
  }

  const progress = welcomeProgress(data.steps);

  return (
    <section ref={cardRef} aria-labelledby={headingId} aria-describedby={hintId} data-welcome-card="checklist" className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <h2 id={headingId} ref={headingRef} tabIndex={-1} className="font-semibold">Welcome to your team</h2>
          <p id={hintId} className="text-sm text-muted-foreground">
            A few first steps; each ticks off when you do it, wherever you do it. You can reopen this from Help.
          </p>
          {/* The optional tour of the screen, until this browser has taken it (desktop only). */}
          <TakeTourButton onlyIfNew className="-ml-1.5 text-sm" />
        </div>
        <Button variant="ghost" size="sm" onClick={close}>Dismiss</Button>
      </div>

      <div className="flex items-center gap-3">
        <div
          role="progressbar"
          aria-label="Welcome checklist progress"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.done}
          aria-valuetext={`${progress.done} of ${progress.total} steps done`}
          className="h-2 flex-1 overflow-hidden rounded-full bg-muted"
        >
          <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
        </div>
        <span className="shrink-0 text-xs text-muted-foreground" aria-hidden>{progress.done} of {progress.total} done</span>
      </div>

      <ol className="space-y-1.5">
        {data.steps.map((step) => {
          const copy = WELCOME_STEPS[step.id];
          if (!copy) return null;
          const isNext = step.id === progress.next;
          return (
            <StepRow
              key={step.id}
              id={step.id}
              done={step.done}
              next={isNext}
              phone={phone}
              sampleTask={data.sampleTask}
              onCreated={() => { refetch(); focusHeading(); }}
            />
          );
        })}
      </ol>
    </section>
  );
}

/** One step: its state (icon and text), title, Learn more, and — while undone — its action. */
function StepRow({ id, done, next, phone, sampleTask, onCreated }: {
  id: OnboardingStepId;
  done: boolean;
  next: boolean;
  phone: boolean;
  sampleTask: OnboardingSampleTask | null;
  onCreated: () => void;
}) {
  const copy = WELCOME_STEPS[id];
  const titleId = useId();
  const Icon = done ? CheckCircle2 : next ? CircleDot : Circle;
  const state = done ? "Done" : next ? "Next" : "Not done";
  return (
    <li
      aria-current={next ? "step" : undefined}
      data-step={id}
      data-done={done || undefined}
      className={cn("rounded-md px-2 py-1.5", next && "border border-primary/40 bg-primary/5")}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Icon className={cn("h-4 w-4 shrink-0", done ? "text-primary" : "text-muted-foreground")} aria-hidden />
        <span id={titleId} className={cn("text-sm", done ? "text-muted-foreground" : "font-medium", next && "font-semibold")}>
          <span className="sr-only">{state}: </span>{copy.title}
        </span>
        {/* The state as visible text too, not only the icon (done and next; plain is "not done"). */}
        {(done || next) && (
          <span aria-hidden className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", done ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary")}>
            {state}
          </span>
        )}
        <span className="ml-auto"><LearnMore topic={copy.learnMore.topic} anchor={copy.learnMore.anchor} describedBy={titleId} compact /></span>
      </div>
      {/* Every undone step's action on the desktop (the order is a suggestion);
          only the next one's on the phone, where the card must stay a peek. */}
      {!done && (next || !phone) && (
        <div className="mt-1 space-y-1.5 pl-6">
          {next && <p className="text-xs text-muted-foreground">{copy.text}</p>}
          <StepAction id={id} phone={phone} sampleTask={sampleTask} onCreated={onCreated} />
        </div>
      )}
    </li>
  );
}

/** What to do for one undone step. */
function StepAction({ id, phone, sampleTask, onCreated }: {
  id: OnboardingStepId;
  phone: boolean;
  sampleTask: OnboardingSampleTask | null;
  onCreated: () => void;
}) {
  switch (id) {
    case "leaderOnline":
      return <StartAssistant size="xs" />;
    case "teammateOnline":
      return phone
        ? <p className="text-xs text-muted-foreground">Spawn one, or set a team size, from the desktop view.</p>
        : <SpawnAction />;
    case "firstTaskCreated":
      return <FirstTaskAction phone={phone} sampleTask={sampleTask} onCreated={onCreated} />;
    case "firstRunStarted":
      return phone
        ? (
          <button type="button" className={LINK_CLASS} onClick={() => {
            const h = document.getElementById(MOBILE_QUEUE_HEADING_ID);
            if (h) { focusTarget(h); h.scrollIntoView({ block: "start" }); }
          }}>
            <ListOrdered className="h-3.5 w-3.5" aria-hidden />Go to the Queue
          </button>
        )
        : <Link to="/queue" className={LINK_CLASS}><ListOrdered className="h-3.5 w-3.5" aria-hidden />Open the Queue</Link>;
    case "firstRunReviewed":
      return <Link to={phone ? MOBILE_TAB_PATHS.inbox : "/"} className={LINK_CLASS}><Inbox className="h-3.5 w-3.5" aria-hidden />Open the Inbox</Link>;
    case "assistantUsed":
      return <AskAssistantButton size="xs" />;
    case "thoughtCaptured":
      return <Link to={phone ? MOBILE_TAB_PATHS.thoughts : "/thoughts"} className={LINK_CLASS}><StickyNote className="h-3.5 w-3.5" aria-hidden />Open Thoughts</Link>;
  }
}

/** Spawn a teammate (its own Spawn dialog), or why it wouldn't happen yet. */
function SpawnAction() {
  const [open, setOpen] = useState(false);
  const { data: health } = useApi<SpawnHealth>("/health", [], { pollInterval: 30_000 });
  const spawn = spawnState(health);
  const reasonId = useId();
  return (
    <div className="space-y-1">
      <Button size="xs" onClick={() => setOpen(true)} disabled={!spawn.canSpawn} aria-describedby={spawn.canSpawn ? undefined : reasonId}>
        <UserPlus aria-hidden />Spawn a teammate
      </Button>
      {!spawn.canSpawn && <p id={reasonId} className="text-xs text-amber-700 dark:text-amber-400">{spawn.blockedReason}</p>}
      {spawn.notReadyReason && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          The team isn't ready ({spawn.notReadyReason}): no work is handed out until it is.
        </p>
      )}
      <SpawnDialog open={open} onOpenChange={setOpen} onSpawned={() => {}} />
    </div>
  );
}

/** "Use a sample task" (an editable prefill, Run) or "Write your own". */
function FirstTaskAction({ phone, sampleTask, onCreated }: {
  phone: boolean;
  sampleTask: OnboardingSampleTask | null;
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const features = useFeatures();
  const formId = useId();
  // Write your own: a Solitary task's form if Tasks are on, else the first kind that is.
  const create = phone ? undefined : (filterByFeatures(START_WORK, features).find((k) => k.feature === "tasks") ?? filterByFeatures(START_WORK, features)[0]);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {sampleTask && (
          <Button ref={toggleRef} size="xs" aria-expanded={open} aria-controls={open ? formId : undefined} onClick={() => setOpen((o) => !o)}>
            <FlaskConical aria-hidden />Use a sample task
          </Button>
        )}
        {create && (
          <Link to={create.to} className={LINK_CLASS}><PenLine className="h-3.5 w-3.5" aria-hidden />Write your own</Link>
        )}
        {!create && <AskAssistantButton size="xs" label="Ask the assistant to write one" />}
      </div>
      {open && sampleTask && (
        <SampleTaskForm id={formId} sample={sampleTask} onCancel={() => { setOpen(false); toggleRef.current?.focus(); }} onCreated={() => { setOpen(false); onCreated(); }} />
      )}
    </div>
  );
}

/** The sample task, prefilled and editable; Run creates and queues it (`POST /api/onboarding/sample-task`). */
function SampleTaskForm({ id, sample, onCancel, onCreated }: {
  id: string;
  sample: OnboardingSampleTask;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState(sample.title);
  const [goal, setGoal] = useState(sample.goal);
  const [criteria, setCriteria] = useState(sample.acceptanceCriteria);
  const [directory, setDirectory] = useState(sample.directory ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const announce = useAnnounce();
  const titleRef = useRef<HTMLInputElement>(null);
  const base = useId();
  const errorId = `${base}-error`;

  // Opening the form puts the cursor in its first field.
  useEffect(() => { titleRef.current?.focus(); }, []);

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!directory.trim()) { setError("Choose the directory of the project to summarize."); return; }
    setBusy(true);
    try {
      const res = await apiPost<CreateSampleTaskResponse>("/api/onboarding/sample-task", {
        title, goal, acceptanceCriteria: criteria, directory,
      });
      if (!res.success) { setError(res.error || "Couldn't create the sample task"); return; }
      announce("Sample task created and queued.");
      onCreated();
    } catch {
      setError("Couldn't reach the daemon");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form id={id} aria-label="Sample task" onSubmit={run} className="space-y-2 rounded-md border border-border bg-background p-3">
      <div className="space-y-1">
        <Label htmlFor={`${base}-title`}>Title</Label>
        <Input id={`${base}-title`} ref={titleRef} value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${base}-goal`}>Goal</Label>
        <Textarea id={`${base}-goal`} value={goal} onChange={(e) => setGoal(e.target.value)} rows={3} />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${base}-criteria`}>Acceptance criteria</Label>
        <Textarea id={`${base}-criteria`} value={criteria} onChange={(e) => setCriteria(e.target.value)} rows={3} />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${base}-dir`}>Directory</Label>
        <DirectoryInput id={`${base}-dir`} value={directory} onChange={setDirectory} errorId={error ? errorId : undefined} placeholder="The project to summarize" />
      </div>
      <FormError id={errorId} className="text-xs">{error}</FormError>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>Run</Button>
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
