# Frontier Refactor — Task Breakdown

Execution companion to [FRONTIER_ENGINEER_REFACTOR_PLAN.md](FRONTIER_ENGINEER_REFACTOR_PLAN.md)
(the design spec). Milestone-sized chunks. Each milestone ends at a **green
checkpoint**; commits *within* a milestone may be red (the type/removal cascades
below don't isolate cleanly), so the milestone boundary is the green boundary.

## Cross-cutting sequencing notes

- **Contract-break window.** M1 (daemon) makes the agent protocol WorkItem-centric;
  M2 (harness) adopts it. Between them the harness is incompatible with the daemon.
  **Land M1 and M2 back-to-back** — don't ship M1 to a live team dir expecting the
  old harness to keep working.
- **Schema = additive, dead columns ignored.** `state.db` is a disposable index
  over the JSON source of truth. M1 adds the `work_items` table and a
  `members.directory` column; the now-dead columns (`substatus`, `requirements`,
  `work_mode`, `assigned_story_id`) are simply left in place and no longer read.
  This preserves existing team dirs (and assistant/inbox history) with no
  destructive rebuild — old values in story.json/task.json are ignored on load.
- **Removal sweeps are grep-driven.** Capabilities and `assigned-story` are woven
  through many files; each removal task lists the grep to run so nothing is missed.
- **Docs travel with code** (per AGENTS.md): each milestone updates its own repo's
  README/ARCHITECTURE; the conceptual DESIGN/WORK-MODEL rewrite is a task in M1.

---

## M1 — Daemon: the queue engine  *(my-pizza-team)*

The big one. Everything else depends on it. Deno type-checks the whole import
graph, so types + store + routes move together.

### shared/types.ts
- **Add:** `WorkItem`, `WorkItemState` (`READY|IN_PROGRESS|MORIBUND|COMPLETE|FAILED|CANCELED`),
  `WorkItemRef` (`{kind:"task",storyId,taskId} | {kind:"workdef",workDefId}`),
  `WorkDef`, `WorkDefType` (`Solitary|Scheduled`; reserve `Story`).
- **Add:** `WorkDef.directory?`; `Member.directory` (replaces capabilities).
- **Remove:** `Capabilities`, `meetsRequirements`, `DIRECTORY_CAP`, `WorkMode`,
  `DEFAULT_WORK_MODE`, `TaskSubstatus`, `Story.requirements`, `Task.substatus`,
  `Member.capabilities/workMode/assignedStoryId`, `config.recentCapabilities`.
  **Keep** `normalizeDirectory` (now used for the affinity compare).

### shared/protocol.ts
- `next-work` → `{ workItem: {id,title} | null }`; `claim/:workItemId` → `{ prompt, workItem:{id} }`.
- New: work-item state-set, list/cancel/force-fail/read/re-enqueue; work-def CRUD/enqueue.
- `register` takes `directory` (not `capabilities`).

### daemon/store.ts (+ new `store/workdefs.ts`, `cron.ts`)
- **Schema:** add `work_items`, `work_defs`; drop `substatus`/`requirements`/
  `work_mode`/`assigned_story_id`; add `members.directory`. Add a `schemaVersion`
  in `settings`; on mismatch, drop+recreate the DB and re-sync from disk.
- `loadFromDisk`: also load `tasks/*.md` WorkDefs (markdown+frontmatter);
  rebuild the queue — recreate a `READY` WorkItem for any task sitting
  ready-in-an-agent-state with no active item.
- **Task→WorkItem creation:** when `setTaskPosition` lands a task in an agent
  state, create a `READY` WorkItem.
- **WorkItem transitions:** `claimWorkItem`, `setWorkItemState(COMPLETE|FAILED)`,
  `cancelWorkItem`, `forceFailWorkItem`, `markWorkItemRead`, `reEnqueue(ref)` —
  enforce the terminal-only + MORIBUND state machine.
- **Terminal reaction:** COMPLETE (task ref) → advance task + post summary comment
  to the task; COMPLETE (workdef ref) → post summary comment to the def;
  FAILED/CANCELED → leave stuck. Advancing a story to `done` → auto-archive
  (replaces the old dismiss-path archiving).
- `getNextWorkItem(agent)`: directory-affinity tiers (mine → unhomed → other-if-no-
  online-agent-has-that-dir) + `paused`. Presence check over online members.
- **Reap → MORIBUND:** `reapOfflineAgents` moves a silent agent's `IN_PROGRESS`
  items to `MORIBUND` (keep lease). `heartbeat` restores that agent's `MORIBUND`
  items to `IN_PROGRESS`.
- **Cron:** `cron.ts` (vendored ~5-field parser); a scheduler timer enqueues due
  `Scheduled` WorkDefs.
- WorkDef CRUD + disk IO.
- **Remove:** `getNextWorkableTask`, `claimTask`/`completeTaskWork`/
  `returnTaskToReady` (superseded by WorkItem-driven flow), substatus handling,
  `record/add/remove/getRecentCapabilities`, assigned-story archive/dismiss.

### daemon/prompt.ts
- Add `buildWorkDefPrompt(def)`; `claim` picks the builder by ref kind. Keep `buildTaskPrompt`.

### daemon/routes/
- `agents.ts`: `next-work`→workItem; `claim/:workItemId`; `work-items/:id/state`;
  `register` directory. **Remove** `done`/`release`/`return`. `token-usage` +
  `attachments` + `comments` accept a workItemId → resolve to ref.
- New `work.ts` (list/cancel/force-fail/read/re-enqueue), `work-defs.ts` (CRUD/enqueue).
- `shared.ts`: `/health` `queueDepth` = READY count; **remove** `/api/capabilities`.

### Tests
- Rewrite `store.test.ts`: WorkItem transitions incl. no-backward + MORIBUND
  round-trip; terminal reaction advancing vs. sticking a task; re-enqueue;
  directory-affinity tiers (incl. presence reservation); WorkDef enqueue; cron
  due-calc; story auto-archive.
- Rewrite `server.test.ts`: new work/work-def routes; next-work returns workItem;
  claim resolves both ref kinds; register with directory.

### Docs
- `ARCHITECTURE.md` (modules, routes, tables), `DESIGN.md` (lead principle: the
  queue is the single legible record of will/is/did; one recovery action per stuck
  state), `WORK-MODEL.md` → fold in (or add `QUEUE-MODEL.md`).

**✅ Green:** `deno test` passes; daemon boots on a fresh + an existing (rebuilt)
team dir; curl smoke of enqueue → next-work → claim → state=COMPLETE.

---

## M2 — Harness: pi-pizza-team  *(land with M1)*

- `client.ts`: `getNextWork()`→`{workItem}`; `claimWorkItem`;
  `setWorkItemState(id,state)` (replaces completeTask/returnTask); repoint
  token-usage/attachments/comments to `/api/agents/*`; `register` sends `directory`.
- `teammate.ts`: `currentTaskId`→`currentWorkItemId`; `agent_end`→set COMPLETE;
  **remove** `return_task` tool → client-side `fail` (postComment + setState FAILED);
  **drop** `--ppt-work-mode`/`--ppt-story` + `onDismissed`.
- `tools.ts`/`index.ts`: drop capability/work-mode flags.
- Docs: pi-pizza-team `README.md` + `docs/ARCHITECTURE.md`.

**✅ Green:** extension builds; a teammate polls → claims → completes a real
WorkItem against the M1 daemon; `fail` path leaves the task stuck; a killed agent
goes MORIBUND then restores on reconnect.

---

## M3 — UI  *(my-pizza-team/ui — independent; talks HTTP)*

- **NavBar:** `Board | Tasks | Schedule | Context` + help/config/theme; Board gets a
  Workflows sub-tab; Context promoted.
- **Root `/`:** quick-create row; `Inbox` + `Assistant` tabs. Inbox = paginated
  COMPLETE/FAILED WorkItems, unread default, links to ref detail; no CANCELED.
- **Pages:** `TasksPage`, `SchedulePage`, `NewWorkDefPage` (shared form; Schedule
  adds cron + friendly presets), `WorkDefDetailPage`.
- **Sidebar:** `[L] [A] [Tn]` status icons + detail modal; live non-terminal
  WorkItem list (ready/in-progress/at-risk) with cancel (READY) + force-fail
  (MORIBUND); **Re-enqueue** action for stuck tasks. Remove capability badges
  (show directory).
- **SpawnPage:** drop story-binding field.
- Remove `RequirementsEditor` + settings "Recent Capabilities".
- Docs: UI section of `ARCHITECTURE.md`.

**✅ Green:** `npm run build`; manual smoke of create → enqueue → inbox → detail,
sidebar actions, spawn.

---

## M4 — Demo: make it work again  *(mpt-demo-team)*

- Rewrite fixtures to new shapes: stories drop `requirements`, keep/add `directory`;
  tasks drop `substatus`; remove `workMode`/`assignedStoryId` from any seeded agents.
- Add sample `tasks/*.md` WorkDefs (a Solitary + a Scheduled with a cron).
- Update setup scripts / seed flow for the new team-dir layout (`tasks/` dir).
- Refresh demo README/walkthrough to the new nav + queue/inbox story.

**✅ Green:** demo team dir loads on a fresh daemon; board + queue + inbox populate;
a scripted teammate drains a WorkItem end-to-end; the walkthrough steps pass.

---

## Suggested landing order

`M1 + M2` together → `M3` → `M4`. Docs updated within each milestone; the
DESIGN/WORK-MODEL conceptual rewrite rides in M1.
