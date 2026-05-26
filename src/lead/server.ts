// HTTP API server for the team lead
//
// Serves both the REST API (for teammates) and the web UI (for humans).
// Built with Hono for lightweight routing.
//
// Web routes:
//   GET /       → Landing page with status summary
//   GET /board  → Kanban board with swimlanes (auto-polls API)
//
// API routes: see docs/ARCHITECTURE.md for the full route table.
//
// The server enforces workflow permissions on status updates —
// if a teammate tries a transition that requires "lead", it returns 403.
//
// Task distribution can be paused/resumed via /api/control/* endpoints,
// which causes GET /api/next-task to return null while paused.
import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import type { Store } from "./store.js";
import type { TeamConfig } from "../shared/types.js";
import type {
  StatusResponse,
  StoriesResponse,
  NextTaskResponse,
  ClaimRequest,
  ClaimResponse,
  StatusUpdateRequest,
  StatusUpdateResponse,
  PostMessageRequest,
  PostMessageResponse,
  MessagesResponse,
  JoinRequest,
  JoinResponse,
  HeartbeatRequest,
  TeamResponse,
  CreateStoryRequest,
  CreateStoryResponse,
} from "../shared/protocol.js";

export class TeamServer {
  private app: Hono;
  private server: ServerType | null = null;
  private store: Store;
  private config: TeamConfig;
  private paused = false;

  constructor(store: Store, config: TeamConfig) {
    this.store = store;
    this.config = config;
    this.app = new Hono();
    this.setupRoutes();
  }

  private setupRoutes(): void {
    // Landing page
    this.app.get("/", (c) => {
      return c.html(`<!DOCTYPE html>
<html><head><title>🍕 pi-pizza-team</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 600px; margin: 60px auto; padding: 0 20px; background: #1a1a2e; color: #e0e0e0; }
  h1 { font-size: 2em; }
  a { color: #7c83ff; }
  .status { background: #16213e; padding: 16px; border-radius: 8px; margin: 20px 0; }
  code { background: #0f3460; padding: 2px 6px; border-radius: 4px; }
</style></head><body>
<h1>🍕 pi-pizza-team</h1>
<p>The team lead API is running.</p>
<div class="status" id="status">Loading...</div>
<h3>API Endpoints</h3>
<ul>
  <li><a href="/api/status">/api/status</a> — Server status</li>
  <li><a href="/api/stories">/api/stories</a> — All stories</li>
  <li><a href="/api/team">/api/team</a> — Team members</li>
  <li><a href="/board">/board</a> — Kanban board</li>
</ul>
<script>
fetch('/api/status').then(r=>r.json()).then(d=>{
  document.getElementById('status').innerHTML = 
    '<strong>Stories:</strong> '+d.stories.open+' open, '+d.stories.done+' done<br>'+
    '<strong>Team:</strong> '+d.members.total+' members ('+d.members.working+' working)<br>'+
    '<strong>Inbox:</strong> '+d.inbox+' messages';
});
</script>
</body></html>`);
    });

    // Kanban board
    this.app.get("/board", (c) => {
      return c.html(BOARD_HTML);
    });

    // GET /api/status
    this.app.get("/api/status", (c) => {
      const stories = this.store.getStories();
      const allTasks: Record<string, number> = {};
      let totalTasks = 0;

      for (const story of stories) {
        const tasks = this.store.getTasksForStory(story.id);
        for (const task of tasks) {
          allTasks[task.status] = (allTasks[task.status] || 0) + 1;
          totalTasks++;
        }
      }

      const members = this.store.getMembers();
      const inbox = this.store.getInboxTasks();

      const response: StatusResponse = {
        running: true,
        stories: {
          total: stories.length,
          open: stories.filter((s) => s.status === "open").length,
          done: stories.filter((s) => s.status === "done").length,
        },
        tasks: { total: totalTasks, byStatus: allTasks },
        members: {
          total: members.length,
          working: members.filter((m) => m.status === "working").length,
          idle: members.filter((m) => m.status === "idle").length,
        },
        inbox: inbox.length,
      };
      return c.json(response);
    });

    // GET /api/stories
    this.app.get("/api/stories", (c) => {
      const stories = this.store.getStories();
      const response: StoriesResponse = {
        stories: stories.map((story) => {
          const tasks = this.store.getTasksForStory(story.id);
          return {
            id: story.id,
            title: story.title,
            description: story.description,
            status: story.status,
            dependsOn: story.dependsOn,
            ready: this.store.isStoryReady(story.id),
            dir: story.dir,
            tasks: tasks.map((task) => {
              const assignment = this.store.getAssignment(task.id);
              return {
                id: task.id,
                seq: task.seq,
                title: task.title,
                status: task.status,
                assignee: assignment?.memberId || null,
                hasMessages: this.store.hasUnreadMessages(task.id),
              };
            }),
          };
        }),
      };
      return c.json(response);
    });

    // POST /api/stories
    this.app.post("/api/stories", async (c) => {
      const body = (await c.req.json()) as CreateStoryRequest;

      // Validate required fields
      if (!body.id || typeof body.id !== "string") {
        return c.json({ success: false, error: "Field 'id' is required and must be a string" } satisfies CreateStoryResponse, 400);
      }
      if (!body.title || typeof body.title !== "string") {
        return c.json({ success: false, error: "Field 'title' is required and must be a string" } satisfies CreateStoryResponse, 400);
      }
      if (!body.description || typeof body.description !== "string") {
        return c.json({ success: false, error: "Field 'description' is required and must be a string" } satisfies CreateStoryResponse, 400);
      }

      // Check for duplicate ID
      if (this.store.hasStory(body.id)) {
        return c.json({ success: false, error: `Story with id '${body.id}' already exists` } satisfies CreateStoryResponse, 409);
      }

      const status = body.status || "open";
      const dependsOn = body.dependsOn || [];

      const { story, tasks } = this.store.createStory(
        body.id,
        body.title,
        body.description,
        status,
        dependsOn,
        body.tasks,
        body.dir
      );

      const response: CreateStoryResponse = {
        success: true,
        story: {
          id: story.id,
          title: story.title,
          description: story.description,
          status: story.status,
          dependsOn: story.dependsOn,
          ready: this.store.isStoryReady(story.id),
          dir: story.dir,
          tasks: tasks.map((t) => ({
            id: t.id,
            seq: t.seq,
            title: t.title,
            status: t.status,
            assignee: null,
            hasMessages: false,
          })),
        },
      };
      return c.json(response, 201);
    });

    // GET /api/next-task
    this.app.get("/api/next-task", (c) => {
      const memberId = c.req.query("memberId");
      if (!memberId) return c.json({ task: null } satisfies NextTaskResponse);

      if (this.paused) return c.json({ task: null } satisfies NextTaskResponse);

      const task = this.store.getNextAvailableTask();
      if (!task) return c.json({ task: null } satisfies NextTaskResponse);

      // Get context from previous tasks in the same story
      const storyTasks = this.store.getTasksForStory(task.storyId);
      const previousResults = storyTasks
        .filter((t) => t.seq < task.seq && t.result)
        .map((t) => `[${t.title}]: ${t.result}`)
        .join("\n\n");

      const response: NextTaskResponse = {
        task: {
          id: task.id,
          storyId: task.storyId,
          title: task.title,
          description: task.description,
          context: previousResults || undefined,
        },
      };
      return c.json(response);
    });

    // POST /api/tasks/:taskId/claim
    this.app.post("/api/tasks/:taskId/claim", async (c) => {
      const taskId = c.req.param("taskId");
      const body = (await c.req.json()) as ClaimRequest;

      const task = this.store.getTask(taskId);
      const success = this.store.claimTask(taskId, body.memberId);
      if (success) {
        const fromStatus = task?.status || "todo";
        this.store.updateTaskStatus(taskId, "in_progress");
        this.store.updateMemberStatus(body.memberId, "working");

        // Get transition instructions
        const { exitInstructions, enterInstructions } = this.store.getTransitionInstructions(fromStatus, "in_progress");
        const parts: string[] = [];
        if (exitInstructions) parts.push(exitInstructions);
        if (enterInstructions) parts.push(enterInstructions);
        const instructions = parts.length > 0 ? parts.join("\n\n---\n\n") : undefined;

        const response: ClaimResponse = { success, instructions };
        return c.json(response);
      }

      const response: ClaimResponse = {
        success,
        error: success ? undefined : "Task already claimed",
      };
      return c.json(response);
    });

    // POST /api/tasks/:taskId/status
    this.app.post("/api/tasks/:taskId/status", async (c) => {
      const taskId = c.req.param("taskId");
      const body = (await c.req.json()) as StatusUpdateRequest;

      const task = this.store.getTask(taskId);
      const fromStatus = task?.status || "";

      const check = this.store.canTransition(taskId, body.status, body.actor);
      if (!check.ok) {
        const response: StatusUpdateResponse = { success: false, error: check.error };
        return c.json(response, 403);
      }

      this.store.updateTaskStatus(taskId, body.status, body.result);

      // If task is done, release assignment and set member to idle
      if (body.status === "done" && body.memberId) {
        this.store.releaseTask(taskId);
        this.store.updateMemberStatus(body.memberId, "idle");
      }

      // Get transition instructions
      const { exitInstructions, enterInstructions } = this.store.getTransitionInstructions(fromStatus, body.status);
      const parts: string[] = [];
      if (exitInstructions) parts.push(exitInstructions);
      if (enterInstructions) parts.push(enterInstructions);
      const instructions = parts.length > 0 ? parts.join("\n\n---\n\n") : undefined;

      const response: StatusUpdateResponse = { success: true, instructions };
      return c.json(response);
    });

    // POST /api/tasks/:taskId/message
    this.app.post("/api/tasks/:taskId/message", async (c) => {
      const taskId = c.req.param("taskId");
      const body = (await c.req.json()) as PostMessageRequest;

      this.store.addMessage(taskId, body.from, body.body);

      const response: PostMessageResponse = { success: true };
      return c.json(response);
    });

    // GET /api/tasks/:taskId/messages
    this.app.get("/api/tasks/:taskId/messages", (c) => {
      const taskId = c.req.param("taskId");
      const messages = this.store.getMessages(taskId);
      const response: MessagesResponse = { messages };
      return c.json(response);
    });

    // POST /api/team/join
    this.app.post("/api/team/join", async (c) => {
      const body = (await c.req.json()) as JoinRequest;
      this.store.registerMember(body.id, body.name, body.cwd, body.tmuxWindow);

      const response: JoinResponse = {
        success: true,
        config: { workflow: this.config.workflow },
      };
      return c.json(response);
    });

    // POST /api/team/heartbeat
    this.app.post("/api/team/heartbeat", async (c) => {
      const body = (await c.req.json()) as HeartbeatRequest;
      this.store.heartbeat(body.id, body.status);
      return c.json({ ok: true });
    });

    // GET /api/team
    this.app.get("/api/team", (c) => {
      const members = this.store.getMembers();
      const response: TeamResponse = {
        members: members.map((m) => {
          const assignment = this.store.getAssignmentForMember(m.id);
          return {
            id: m.id,
            name: m.name,
            status: m.status,
            currentTask: assignment?.taskId || null,
            tmuxWindow: m.tmuxWindow,
            lastHeartbeat: m.lastHeartbeat,
          };
        }),
      };
      return c.json(response);
    });

    // Control endpoints
    this.app.post("/api/control/pause", (c) => {
      this.paused = true;
      return c.json({ paused: true });
    });

    this.app.post("/api/control/resume", (c) => {
      this.paused = false;
      return c.json({ paused: false });
    });
  }

  async start(): Promise<void> {
    this.server = serve({ fetch: this.app.fetch, port: this.config.port });
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  isPaused(): boolean {
    return this.paused;
  }
}


const BOARD_HTML = `<!DOCTYPE html>
<html><head><title>🍕 pi-pizza-team board</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #1a1a2e; color: #e0e0e0; padding: 20px; }
  h1 { margin-bottom: 20px; font-size: 1.5em; }
  .team-bar { display: flex; gap: 16px; margin-bottom: 20px; padding: 12px; background: #16213e; border-radius: 8px; flex-wrap: wrap; }
  .member { font-size: 0.85em; }
  .member-working { color: #4caf50; }
  .member-idle { color: #888; }
  .refresh { font-size: 0.7em; color: #555; }
  .swimlane { margin-bottom: 24px; border: 1px solid #0f3460; border-radius: 8px; overflow: hidden; }
  .swimlane-header { background: #0f3460; padding: 10px 14px; display: flex; justify-content: space-between; align-items: center; }
  .swimlane-title { font-weight: 600; font-size: 0.95em; }
  .swimlane-meta { font-size: 0.75em; color: #888; }
  .swimlane-blocked { opacity: 0.5; }
  .swimlane-blocked .swimlane-header { background: #1a1a2e; border-bottom: 1px solid #0f3460; }
  .board { display: flex; gap: 2px; min-height: 60px; }
  .column { flex: 1; min-width: 140px; background: #16213e; padding: 10px; }
  .column h2 { font-size: 0.7em; text-transform: uppercase; letter-spacing: 0.05em; color: #7c83ff; margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid #0f3460; }
  .card { background: #0f3460; border-radius: 6px; padding: 8px 10px; margin-bottom: 6px; cursor: pointer; transition: background 0.15s; }
  .card:hover { background: #1a4080; }
  .card-title { font-size: 0.8em; font-weight: 600; margin-bottom: 3px; }
  .card-meta { font-size: 0.7em; color: #888; }
  .card-assignee { font-size: 0.7em; color: #7c83ff; margin-top: 2px; }
  .card-msg { font-size: 0.7em; color: #ffa500; margin-top: 2px; }
  .progress { font-size: 0.75em; color: #4caf50; }
  .empty-col { min-height: 20px; }
  .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
  .toolbar h1 { margin-bottom: 0; }
  .btn-add-story { background: #7c83ff; color: #fff; border: none; padding: 8px 16px; border-radius: 6px; font-size: 0.85em; font-weight: 600; cursor: pointer; transition: background 0.15s; }
  .btn-add-story:hover { background: #5a62d9; }
  .btn-add-story:active { background: #4a51b8; }
  /* Filter/Sort toolbar */
  .controls-bar { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; padding: 12px 14px; background: #16213e; border-radius: 8px; flex-wrap: wrap; }
  .controls-bar .search-input { background: #0f3460; border: 1px solid #1a4080; color: #e0e0e0; border-radius: 5px; padding: 6px 10px; font-size: 0.82em; font-family: inherit; outline: none; min-width: 180px; transition: border-color 0.15s; }
  .controls-bar .search-input:focus { border-color: #7c83ff; }
  .controls-bar .search-input::placeholder { color: #555; }
  .filter-group { display: flex; gap: 4px; align-items: center; }
  .filter-btn { background: #0f3460; border: 1px solid #1a4080; color: #aaa; padding: 5px 10px; border-radius: 5px; font-size: 0.78em; cursor: pointer; transition: all 0.15s; }
  .filter-btn:hover { border-color: #7c83ff; color: #e0e0e0; }
  .filter-btn.active { background: #7c83ff; border-color: #7c83ff; color: #fff; }
  .sort-select { background: #0f3460; border: 1px solid #1a4080; color: #e0e0e0; border-radius: 5px; padding: 5px 8px; font-size: 0.78em; font-family: inherit; outline: none; cursor: pointer; }
  .sort-select:focus { border-color: #7c83ff; }
  .controls-label { font-size: 0.7em; color: #666; text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; }
  .story-count { font-size: 0.78em; color: #888; margin-left: auto; }
  /* Modal styles */
  .modal-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 1000; justify-content: center; align-items: flex-start; padding: 40px 20px; overflow-y: auto; }
  .modal { background: #16213e; border: 1px solid #0f3460; border-radius: 10px; width: 100%; max-width: 580px; padding: 24px; position: relative; }
  .modal h2 { font-size: 1.1em; margin-bottom: 16px; color: #e0e0e0; }
  .modal-close { position: absolute; top: 12px; right: 16px; background: none; border: none; color: #888; font-size: 1.3em; cursor: pointer; }
  .modal-close:hover { color: #e0e0e0; }
  .form-group { margin-bottom: 14px; }
  .form-group label { display: block; font-size: 0.78em; font-weight: 600; color: #aaa; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.03em; }
  .form-group input, .form-group textarea { width: 100%; background: #0f3460; border: 1px solid #1a4080; color: #e0e0e0; border-radius: 5px; padding: 8px 10px; font-size: 0.85em; font-family: inherit; outline: none; transition: border-color 0.15s; }
  .form-group input:focus, .form-group textarea:focus { border-color: #7c83ff; }
  .form-group textarea { resize: vertical; min-height: 60px; }
  .form-group .hint { font-size: 0.7em; color: #666; margin-top: 3px; }
  .form-error { font-size: 0.78em; color: #ff5252; margin-bottom: 12px; display: none; padding: 8px 10px; background: rgba(255,82,82,0.1); border-radius: 5px; }
  .tasks-section { margin-top: 18px; border-top: 1px solid #0f3460; padding-top: 14px; }
  .tasks-section h3 { font-size: 0.85em; color: #aaa; margin-bottom: 10px; }
  .task-row { display: flex; gap: 8px; align-items: flex-start; margin-bottom: 8px; background: #0f3460; border-radius: 6px; padding: 10px; position: relative; }
  .task-row .task-num { font-size: 0.75em; color: #7c83ff; font-weight: 700; min-width: 20px; padding-top: 8px; }
  .task-row .task-fields { flex: 1; display: flex; flex-direction: column; gap: 6px; }
  .task-row .task-fields input, .task-row .task-fields textarea { width: 100%; background: #1a1a2e; border: 1px solid #16213e; color: #e0e0e0; border-radius: 4px; padding: 6px 8px; font-size: 0.8em; font-family: inherit; outline: none; }
  .task-row .task-fields input:focus, .task-row .task-fields textarea:focus { border-color: #7c83ff; }
  .task-row .task-fields textarea { resize: vertical; min-height: 40px; }
  .task-actions { display: flex; flex-direction: column; gap: 2px; }
  .task-actions button { background: none; border: none; color: #888; cursor: pointer; font-size: 0.85em; padding: 2px 4px; border-radius: 3px; }
  .task-actions button:hover { color: #e0e0e0; background: #1a1a2e; }
  .task-actions .btn-remove:hover { color: #ff5252; }
  .btn-add-task { background: none; border: 1px dashed #0f3460; color: #7c83ff; padding: 8px 14px; border-radius: 6px; font-size: 0.8em; cursor: pointer; width: 100%; margin-top: 6px; }
  .btn-add-task:hover { background: #0f3460; border-color: #7c83ff; }
  .modal-footer { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; padding-top: 16px; border-top: 1px solid #0f3460; }
  .btn-cancel { background: none; border: 1px solid #0f3460; color: #aaa; padding: 8px 16px; border-radius: 6px; font-size: 0.85em; cursor: pointer; }
  .btn-cancel:hover { background: #0f3460; color: #e0e0e0; }
  .btn-submit { background: #7c83ff; color: #fff; border: none; padding: 8px 20px; border-radius: 6px; font-size: 0.85em; font-weight: 600; cursor: pointer; }
  .btn-submit:hover { background: #5a62d9; }
  .btn-submit:disabled { background: #3a3f6e; cursor: not-allowed; }
</style></head><body>
<div class="toolbar">
  <h1>🍕 pi-pizza-team board <span class="refresh" id="refresh"></span></h1>
  <button class="btn-add-story" id="btn-add-story" onclick="openAddStoryModal()">+ Add Story</button>
</div>
<div class="team-bar" id="team"></div>
<div class="controls-bar">
  <input type="text" class="search-input" id="search-input" placeholder="🔍 Search stories..." oninput="applyFilters()" />
  <span class="controls-label">Filter:</span>
  <div class="filter-group">
    <button class="filter-btn active" data-filter="all" onclick="setFilter('all')">All</button>
    <button class="filter-btn" data-filter="open" onclick="setFilter('open')">Open</button>
    <button class="filter-btn" data-filter="done" onclick="setFilter('done')">Done</button>
    <button class="filter-btn" data-filter="ready" onclick="setFilter('ready')">Ready</button>
    <button class="filter-btn" data-filter="blocked" onclick="setFilter('blocked')">Blocked</button>
  </div>
  <span class="controls-label">Sort:</span>
  <select class="sort-select" id="sort-select" onchange="applyFilters()">
    <option value="default">Default</option>
    <option value="name-asc">Name (A-Z)</option>
    <option value="name-desc">Name (Z-A)</option>
    <option value="progress">Progress</option>
    <option value="most-tasks">Most tasks</option>
    <option value="fewest-tasks">Fewest tasks</option>
  </select>
  <span class="story-count" id="story-count"></span>
</div>
<div id="board"></div>

<!-- Add Story Modal -->
<div class="modal-overlay" id="add-story-modal">
  <div class="modal" role="dialog" aria-labelledby="modal-title" aria-modal="true">
    <button class="modal-close" onclick="closeAddStoryModal()" aria-label="Close">&times;</button>
    <h2 id="modal-title">Add Story</h2>
    <div class="form-error" id="form-error"></div>
    <div class="form-group">
      <label for="story-id">ID *</label>
      <input type="text" id="story-id" placeholder="e.g. auth-login" />
    </div>
    <div class="form-group">
      <label for="story-title">Title *</label>
      <input type="text" id="story-title" placeholder="e.g. Implement login flow" />
    </div>
    <div class="form-group">
      <label for="story-desc">Description *</label>
      <textarea id="story-desc" placeholder="What this story delivers..."></textarea>
    </div>
    <div class="form-group">
      <label for="story-depends">Depends On</label>
      <input type="text" id="story-depends" placeholder="Comma-separated story IDs (optional)" />
      <div class="hint">e.g. setup-db, auth-core</div>
    </div>
    <div class="form-group">
      <label for="story-dir">Working Directory</label>
      <input type="text" id="story-dir" placeholder="Optional, e.g. ~/Workspace/my-project" />
      <div class="hint">Hint for teammates about where to work</div>
    </div>
    <div class="tasks-section">
      <h3>Tasks (optional)</h3>
      <div id="task-list"></div>
      <button class="btn-add-task" onclick="addTaskRow()">+ Add Task</button>
    </div>
    <div class="modal-footer">
      <button class="btn-cancel" onclick="closeAddStoryModal()">Cancel</button>
      <button class="btn-submit" id="btn-submit" onclick="submitStory()">Create Story</button>
    </div>
  </div>
</div>
<script>
const POLL_MS = 3000;
const COLUMN_ORDER = ['todo', 'in_progress', 'needs_input', 'review', 'done'];

// --- State ---
let allStories = [];
let currentFilter = localStorage.getItem('board-filter') || 'all';
let currentSort = localStorage.getItem('board-sort') || 'default';
let currentSearch = localStorage.getItem('board-search') || '';

// Restore persisted state on load
(function initControls() {
  document.getElementById('search-input').value = currentSearch;
  document.getElementById('sort-select').value = currentSort;
  // Set active filter button
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === currentFilter);
  });
})();

function setFilter(filter) {
  currentFilter = filter;
  localStorage.setItem('board-filter', filter);
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });
  applyFilters();
}

function applyFilters() {
  currentSearch = document.getElementById('search-input').value;
  currentSort = document.getElementById('sort-select').value;
  localStorage.setItem('board-search', currentSearch);
  localStorage.setItem('board-sort', currentSort);
  renderBoard(allStories);
}

function filterAndSortStories(stories) {
  let filtered = stories;

  // Search filter
  const search = currentSearch.trim().toLowerCase();
  if (search) {
    filtered = filtered.filter(s =>
      s.title.toLowerCase().includes(search) ||
      s.description.toLowerCase().includes(search)
    );
  }

  // Status filter
  if (currentFilter === 'open') {
    filtered = filtered.filter(s => s.status === 'open');
  } else if (currentFilter === 'done') {
    filtered = filtered.filter(s => s.status === 'done');
  } else if (currentFilter === 'ready') {
    filtered = filtered.filter(s => s.ready && s.status !== 'done');
  } else if (currentFilter === 'blocked') {
    filtered = filtered.filter(s => !s.ready && s.status !== 'done');
  }

  // Sort
  if (currentSort === 'name-asc') {
    filtered = [...filtered].sort((a, b) => a.title.localeCompare(b.title));
  } else if (currentSort === 'name-desc') {
    filtered = [...filtered].sort((a, b) => b.title.localeCompare(a.title));
  } else if (currentSort === 'progress') {
    filtered = [...filtered].sort((a, b) => {
      const pa = a.tasks.length ? a.tasks.filter(t => t.status === 'done').length / a.tasks.length : 0;
      const pb = b.tasks.length ? b.tasks.filter(t => t.status === 'done').length / b.tasks.length : 0;
      return pb - pa;
    });
  } else if (currentSort === 'most-tasks') {
    filtered = [...filtered].sort((a, b) => b.tasks.length - a.tasks.length);
  } else if (currentSort === 'fewest-tasks') {
    filtered = [...filtered].sort((a, b) => a.tasks.length - b.tasks.length);
  }

  return filtered;
}

function updateStoryCount(shown, total) {
  const el = document.getElementById('story-count');
  if (shown === total) {
    el.textContent = total + ' ' + (total === 1 ? 'story' : 'stories');
  } else {
    el.textContent = 'Showing ' + shown + ' of ' + total + ' stories';
  }
}

function openAddStoryModal() {
  const modal = document.getElementById('add-story-modal');
  modal.style.display = 'flex';
  // Reset form
  document.getElementById('story-id').value = '';
  document.getElementById('story-title').value = '';
  document.getElementById('story-desc').value = '';
  document.getElementById('story-depends').value = '';
  document.getElementById('story-dir').value = '';
  document.getElementById('task-list').innerHTML = '';
  hideError();
  document.getElementById('btn-submit').disabled = false;
  document.getElementById('btn-submit').textContent = 'Create Story';
  // Focus first field
  setTimeout(() => document.getElementById('story-id').focus(), 50);
}

function closeAddStoryModal() {
  document.getElementById('add-story-modal').style.display = 'none';
}

function hideError() {
  const el = document.getElementById('form-error');
  el.style.display = 'none';
  el.textContent = '';
}

function showError(msg) {
  const el = document.getElementById('form-error');
  el.textContent = msg;
  el.style.display = 'block';
}

function renumberTasks() {
  const rows = document.querySelectorAll('#task-list .task-row');
  rows.forEach((row, i) => {
    row.querySelector('.task-num').textContent = (i + 1) + '.';
  });
}

function addTaskRow() {
  const list = document.getElementById('task-list');
  const idx = list.children.length + 1;
  const row = document.createElement('div');
  row.className = 'task-row';
  row.innerHTML = '<div class="task-num">' + idx + '.</div>'
    + '<div class="task-fields">'
    + '<input type="text" placeholder="Task title" class="task-title-input" />'
    + '<textarea placeholder="Task description" class="task-desc-input"></textarea>'
    + '</div>'
    + '<div class="task-actions">'
    + '<button onclick="moveTask(this,-1)" title="Move up">&#9650;</button>'
    + '<button onclick="moveTask(this,1)" title="Move down">&#9660;</button>'
    + '<button class="btn-remove" onclick="removeTask(this)" title="Remove">&times;</button>'
    + '</div>';
  list.appendChild(row);
  row.querySelector('.task-title-input').focus();
}

function removeTask(btn) {
  const row = btn.closest('.task-row');
  row.remove();
  renumberTasks();
}

function moveTask(btn, dir) {
  const row = btn.closest('.task-row');
  const list = document.getElementById('task-list');
  const rows = Array.from(list.children);
  const idx = rows.indexOf(row);
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= rows.length) return;
  if (dir === -1) {
    list.insertBefore(row, rows[newIdx]);
  } else {
    list.insertBefore(row, rows[newIdx].nextSibling);
  }
  renumberTasks();
}

async function submitStory() {
  hideError();
  const id = document.getElementById('story-id').value.trim();
  const title = document.getElementById('story-title').value.trim();
  const description = document.getElementById('story-desc').value.trim();
  const dependsRaw = document.getElementById('story-depends').value.trim();
  const dir = document.getElementById('story-dir').value.trim();

  if (!id) { showError('ID is required.'); document.getElementById('story-id').focus(); return; }
  if (!title) { showError('Title is required.'); document.getElementById('story-title').focus(); return; }
  if (!description) { showError('Description is required.'); document.getElementById('story-desc').focus(); return; }

  const dependsOn = dependsRaw ? dependsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];

  const taskRows = document.querySelectorAll('#task-list .task-row');
  const tasks = [];
  for (const row of taskRows) {
    const t = row.querySelector('.task-title-input').value.trim();
    const d = row.querySelector('.task-desc-input').value.trim();
    if (t) tasks.push({ title: t, description: d || t });
  }

  const btn = document.getElementById('btn-submit');
  btn.disabled = true;
  btn.textContent = 'Creating...';

  try {
    const res = await fetch('/api/stories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, title, description, dependsOn, dir: dir || undefined, tasks: tasks.length ? tasks : undefined })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      showError(data.error || 'Failed to create story');
      btn.disabled = false;
      btn.textContent = 'Create Story';
      return;
    }
    closeAddStoryModal();
    refresh();
  } catch (e) {
    showError('Network error: ' + e.message);
    btn.disabled = false;
    btn.textContent = 'Create Story';
  }
}

// Keyboard handling for modal
document.addEventListener('keydown', function(e) {
  const modal = document.getElementById('add-story-modal');
  if (modal.style.display !== 'flex') return;
  if (e.key === 'Escape') { closeAddStoryModal(); return; }
  // Trap focus within modal
  if (e.key === 'Tab') {
    const focusable = modal.querySelectorAll('input, textarea, button:not([disabled])');
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

// Close modal on overlay click
document.getElementById('add-story-modal').addEventListener('click', function(e) {
  if (e.target === this) closeAddStoryModal();
});

async function refresh() {
  try {
    const [storiesRes, teamRes] = await Promise.all([
      fetch('/api/stories').then(r => r.json()),
      fetch('/api/team').then(r => r.json())
    ]);
    renderTeam(teamRes.members);
    allStories = storiesRes.stories;
    renderBoard(allStories);
    document.getElementById('refresh').textContent = 'updated ' + new Date().toLocaleTimeString();
  } catch(e) {
    document.getElementById('refresh').textContent = 'error: ' + e.message;
  }
}

function renderTeam(members) {
  const el = document.getElementById('team');
  if (members.length === 0) { el.innerHTML = '<span class="member member-idle">No teammates yet</span>'; return; }
  el.innerHTML = members.map(m => {
    const cls = m.status === 'working' ? 'member-working' : 'member-idle';
    const icon = m.status === 'working' ? '🔨' : '☕';
    const task = m.currentTask ? ' → ' + m.currentTask : '';
    return '<span class="member ' + cls + '">' + icon + ' ' + m.name + task + '</span>';
  }).join('');
}

function renderBoard(stories) {
  const el = document.getElementById('board');
  const filtered = filterAndSortStories(stories);
  updateStoryCount(filtered.length, stories.length);

  // Determine all columns needed
  const allStates = new Set(COLUMN_ORDER);
  for (const story of filtered) {
    for (const task of story.tasks) allStates.add(task.status);
  }
  const columns = [...allStates].sort((a, b) => {
    const ai = COLUMN_ORDER.indexOf(a), bi = COLUMN_ORDER.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });

  el.innerHTML = filtered.map(story => {
    const blocked = !story.ready && story.status !== 'done';
    const doneCount = story.tasks.filter(t => t.status === 'done').length;
    const blockedClass = blocked ? ' swimlane-blocked' : '';
    const blockedLabel = blocked ? ' (blocked by: ' + story.dependsOn.join(', ') + ')' : '';

    const columnsHtml = columns.map(state => {
      const tasks = story.tasks.filter(t => t.status === state);
      const cards = tasks.map(t => {
        const assignee = t.assignee ? '<div class="card-assignee">→ ' + t.assignee + '</div>' : '';
        const msg = t.hasMessages ? '<div class="card-msg">📬 messages</div>' : '';
        return '<div class="card"><div class="card-title">' + t.title + '</div><div class="card-meta">#' + t.seq + '</div>' + assignee + msg + '</div>';
      }).join('');
      const label = state.replace(/_/g, ' ');
      const content = cards || '<div class="empty-col"></div>';
      return '<div class="column"><h2>' + label + '</h2>' + content + '</div>';
    }).join('');

    return '<div class="swimlane' + blockedClass + '">'
      + '<div class="swimlane-header">'
      + '<span class="swimlane-title">' + story.title + (story.dir ? ' <span style="font-size:0.75em;color:#888;font-weight:400;">📂 ' + story.dir + '</span>' : '') + '</span>'
      + '<span class="swimlane-meta"><span class="progress">' + doneCount + '/' + story.tasks.length + '</span>' + blockedLabel + '</span>'
      + '</div>'
      + '<div class="board">' + columnsHtml + '</div>'
      + '</div>';
  }).join('');
}

refresh();
setInterval(refresh, POLL_MS);
</script>
</body></html>`;
