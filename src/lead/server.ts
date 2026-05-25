// HTTP API server for the team lead
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

      const success = this.store.claimTask(taskId, body.memberId);
      if (success) {
        this.store.updateTaskStatus(taskId, "in_progress");
        this.store.updateMemberStatus(body.memberId, "working");
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

      const response: StatusUpdateResponse = { success: true };
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
</style></head><body>
<h1>🍕 pi-pizza-team board <span class="refresh" id="refresh"></span></h1>
<div class="team-bar" id="team"></div>
<div id="board"></div>
<script>
const POLL_MS = 3000;
const COLUMN_ORDER = ['todo', 'in_progress', 'needs_input', 'review', 'done'];

async function refresh() {
  try {
    const [storiesRes, teamRes] = await Promise.all([
      fetch('/api/stories').then(r => r.json()),
      fetch('/api/team').then(r => r.json())
    ]);
    renderTeam(teamRes.members);
    renderBoard(storiesRes.stories);
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

  // Determine all columns needed
  const allStates = new Set(COLUMN_ORDER);
  for (const story of stories) {
    for (const task of story.tasks) allStates.add(task.status);
  }
  const columns = [...allStates].sort((a, b) => {
    const ai = COLUMN_ORDER.indexOf(a), bi = COLUMN_ORDER.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });

  el.innerHTML = stories.map(story => {
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
      + '<span class="swimlane-title">' + story.title + '</span>'
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
