// End-to-end tests for task messages UI flows
// Run with: node tests/task-messages-ui.test.mjs
//
// Tests the API endpoints that the message panel relies on,
// simulating the full flow the UI performs.
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pizza-msg-test-"));
const teamDir = path.join(tmpDir, ".pi-pizza-team");
fs.mkdirSync(teamDir, { recursive: true });

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}`); failed++; }
}

// --- Setup SQLite store ---
const db = new Database(path.join(teamDir, "state.db"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS stories (
    id TEXT PRIMARY KEY, title TEXT, description TEXT,
    status TEXT DEFAULT 'open', depends_on TEXT DEFAULT '[]',
    dir TEXT, dir_path TEXT
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, story_id TEXT REFERENCES stories(id),
    seq INTEGER, slug TEXT, title TEXT, description TEXT,
    status TEXT DEFAULT 'todo', result TEXT, dir_path TEXT, dirty INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS assignments (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    member_id TEXT, claimed_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT REFERENCES tasks(id), from_id TEXT, body TEXT, created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS messages_loaded (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id), loaded_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY, name TEXT, status TEXT DEFAULT 'idle',
    cwd TEXT, tmux_window TEXT, last_heartbeat INTEGER
  );
`);

// Create story + task directory structure
const storyDir = path.join(teamDir, "stories", "msg-test");
const tasksDir = path.join(storyDir, "tasks");
const taskDir1 = path.join(tasksDir, "01-first-task");
const taskDir2 = path.join(tasksDir, "02-needs-input-task");
const taskDir3 = path.join(tasksDir, "03-many-messages");
fs.mkdirSync(taskDir1, { recursive: true });
fs.mkdirSync(taskDir2, { recursive: true });
fs.mkdirSync(taskDir3, { recursive: true });

// Insert story
db.prepare("INSERT INTO stories VALUES (?, ?, ?, ?, ?, ?, ?)").run(
  "msg-test", "Message Test Story", "Testing message panel", "open", "[]", null, storyDir
);

// Insert tasks
db.prepare("INSERT INTO tasks (id, story_id, seq, slug, title, description, status, dir_path) VALUES (?,?,?,?,?,?,?,?)")
  .run("msg-test-1", "msg-test", 1, "first-task", "First Task", "A normal task", "in_progress", taskDir1);
db.prepare("INSERT INTO tasks (id, story_id, seq, slug, title, description, status, dir_path) VALUES (?,?,?,?,?,?,?,?)")
  .run("msg-test-2", "msg-test", 2, "needs-input-task", "Needs Input Task", "A task waiting for input", "needs_input", taskDir2);
db.prepare("INSERT INTO tasks (id, story_id, seq, slug, title, description, status, dir_path) VALUES (?,?,?,?,?,?,?,?)")
  .run("msg-test-3", "msg-test", 3, "many-messages", "Many Messages Task", "A task with lots of messages", "in_progress", taskDir3);

// Mark all as messages loaded so it doesn't try to read JSONL files
db.prepare("INSERT INTO messages_loaded (task_id, loaded_at) VALUES (?, ?)").run("msg-test-1", Date.now());
db.prepare("INSERT INTO messages_loaded (task_id, loaded_at) VALUES (?, ?)").run("msg-test-2", Date.now());
db.prepare("INSERT INTO messages_loaded (task_id, loaded_at) VALUES (?, ?)").run("msg-test-3", Date.now());

// Workflow config (matching the real one)
const workflow = {
  states: ["todo", "in_progress", "needs_input", "review", "done"],
  transitions: {
    todo: { in_progress: "any" },
    in_progress: { needs_input: "teammate", review: "teammate" },
    needs_input: { in_progress: "lead" },
    review: { done: "lead", in_progress: "lead" },
  },
};

// Helper: get messages (simulating GET /api/tasks/:id/messages)
function getMessages(taskId) {
  return db.prepare("SELECT * FROM messages WHERE task_id = ? ORDER BY created_at")
    .all(taskId)
    .map(row => ({ from: row.from_id, body: row.body, at: new Date(row.created_at).toISOString() }));
}

// Helper: add message (simulating POST /api/tasks/:id/message)
function addMessage(taskId, from, body) {
  const now = Date.now();
  db.prepare("INSERT INTO messages (task_id, from_id, body, created_at) VALUES (?, ?, ?, ?)")
    .run(taskId, from, body, now);
  // Append to JSONL
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  if (task) {
    const messagesFile = path.join(task.dir_path, "messages.jsonl");
    const msg = { from, body, at: new Date(now).toISOString() };
    fs.appendFileSync(messagesFile, JSON.stringify(msg) + "\n");
  }
  return { success: true };
}

// Helper: canTransition
function canTransition(taskId, newStatus, actor) {
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  if (!task) return { ok: false, error: "Task not found" };
  const transitions = workflow.transitions[task.status];
  if (!transitions) return { ok: false, error: `No transitions from "${task.status}"` };
  const permission = transitions[newStatus];
  if (!permission) return { ok: false, error: `Cannot transition from "${task.status}" to "${newStatus}"` };
  if (permission === "any") return { ok: true };
  if (permission === actor) return { ok: true };
  return { ok: false, error: `Transition requires "${permission}", got "${actor}"` };
}

// Helper: move task (simulating POST /api/tasks/:id/move)
function moveTask(taskId, newStatus) {
  const check = canTransition(taskId, newStatus, "lead");
  if (!check.ok) return { success: false, error: check.error };
  db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(newStatus, taskId);
  return { success: true };
}


// ============================================================
// TEST 1: Empty message thread shows no messages
// ============================================================
console.log("\n--- Test 1: Empty message thread ---");
{
  const messages = getMessages("msg-test-1");
  assert(messages.length === 0, "No messages for fresh task");
  assert(Array.isArray(messages), "Returns an array");
}


// ============================================================
// TEST 2: Send message as lead — persisted and retrievable
// ============================================================
console.log("\n--- Test 2: Send message as lead ---");
{
  const result = addMessage("msg-test-1", "lead", "Hello teammate, how's it going?");
  assert(result.success === true, "addMessage returns success");

  const messages = getMessages("msg-test-1");
  assert(messages.length === 1, "One message in thread");
  assert(messages[0].from === "lead", "Message from is 'lead'");
  assert(messages[0].body === "Hello teammate, how's it going?", "Message body matches");
  assert(messages[0].at !== undefined, "Message has 'at' timestamp");

  // Verify persisted to messages.jsonl
  const jsonlPath = path.join(taskDir1, "messages.jsonl");
  assert(fs.existsSync(jsonlPath), "messages.jsonl created on disk");
  const lines = fs.readFileSync(jsonlPath, "utf-8").trim().split("\n");
  assert(lines.length === 1, "One line in JSONL file");
  const parsed = JSON.parse(lines[0]);
  assert(parsed.from === "lead", "JSONL line has from=lead");
  assert(parsed.body === "Hello teammate, how's it going?", "JSONL line body matches");
}


// ============================================================
// TEST 3: Teammate messages show up on refresh
// ============================================================
console.log("\n--- Test 3: Teammate messages appear ---");
{
  // Simulate teammate posting a message via API
  addMessage("msg-test-1", "teammate-alice", "Going well! Almost done with the tests.");

  const messages = getMessages("msg-test-1");
  assert(messages.length === 2, "Two messages now in thread");
  assert(messages[0].from === "lead", "First message is from lead");
  assert(messages[1].from === "teammate-alice", "Second message is from teammate");
  assert(messages[1].body === "Going well! Almost done with the tests.", "Teammate body matches");

  // Messages are in chronological order
  const t1 = new Date(messages[0].at).getTime();
  const t2 = new Date(messages[1].at).getTime();
  assert(t2 >= t1, "Messages in chronological order");
}


// ============================================================
// TEST 4: needs_input flow — reply and move back to in_progress
// ============================================================
console.log("\n--- Test 4: needs_input → reply → resume to in_progress ---");
{
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get("msg-test-2");
  assert(task.status === "needs_input", "Task starts in needs_input");

  // Teammate sent a question (simulate)
  addMessage("msg-test-2", "teammate-bob", "I'm stuck — should I use REST or GraphQL?");

  const msgs1 = getMessages("msg-test-2");
  assert(msgs1.length === 1, "Teammate question in thread");

  // Lead replies
  addMessage("msg-test-2", "lead", "Use REST for this project.");
  const msgs2 = getMessages("msg-test-2");
  assert(msgs2.length === 2, "Lead reply added");

  // After replying, UI offers to move to in_progress — simulate that click
  const moveResult = moveTask("msg-test-2", "in_progress");
  assert(moveResult.success === true, "Move needs_input → in_progress succeeds");

  const updated = db.prepare("SELECT * FROM tasks WHERE id = ?").get("msg-test-2");
  assert(updated.status === "in_progress", "Task is now in_progress");

  // Verify the transition was only allowed for lead (not teammate)
  // Reset for this check
  db.prepare("UPDATE tasks SET status = 'needs_input' WHERE id = ?").run("msg-test-2");
  const teammateCheck = canTransition("msg-test-2", "in_progress", "teammate");
  assert(teammateCheck.ok === false, "Teammate cannot move needs_input → in_progress");
  assert(teammateCheck.error.includes("lead"), "Error mentions 'lead' requirement");
}


// ============================================================
// TEST 5: Many messages — chronological order, all returned
// ============================================================
console.log("\n--- Test 5: Many messages — scrolling scenario ---");
{
  // Add 50 messages alternating between lead and teammate
  for (let i = 0; i < 50; i++) {
    const from = i % 2 === 0 ? "lead" : "teammate-charlie";
    const body = `Message number ${i + 1}: ${from === "lead" ? "Lead says something" : "Teammate responds"}`;
    db.prepare("INSERT INTO messages (task_id, from_id, body, created_at) VALUES (?, ?, ?, ?)")
      .run("msg-test-3", from, body, Date.now() + i); // slightly different timestamps
  }

  const messages = getMessages("msg-test-3");
  assert(messages.length === 50, `Got all 50 messages (got ${messages.length})`);
  assert(messages[0].body === "Message number 1: Lead says something", "First message correct");
  assert(messages[49].body === "Message number 50: Teammate responds", "Last message correct");

  // All in chronological order
  let inOrder = true;
  for (let i = 1; i < messages.length; i++) {
    if (new Date(messages[i].at).getTime() < new Date(messages[i-1].at).getTime()) {
      inOrder = false; break;
    }
  }
  assert(inOrder, "All 50 messages in chronological order");

  // Verify response structure matches what UI expects
  assert(messages[0].from !== undefined, "Message has 'from' field");
  assert(messages[0].body !== undefined, "Message has 'body' field");
  assert(messages[0].at !== undefined, "Message has 'at' field (not 'timestamp')");
  assert(messages[0].timestamp === undefined, "No 'timestamp' field (UI bug would be using wrong field)");
}


// ============================================================
// TEST 6: Board polling doesn't interfere — messages are independent
// ============================================================
console.log("\n--- Test 6: Messages independent of board state ---");
{
  // Simulate what the board poll does (GET /api/stories)
  const stories = db.prepare("SELECT * FROM stories").all();
  const tasks = db.prepare("SELECT * FROM tasks WHERE story_id = ?").all("msg-test");
  assert(stories.length === 1, "Board can still load stories");
  assert(tasks.length === 3, "Board can still load tasks");

  // Messages endpoint is a separate query, doesn't block stories
  const msgs = getMessages("msg-test-1");
  assert(msgs.length === 2, "Messages still accessible during board refresh");

  // Adding a message doesn't change task status or board state
  const taskBefore = db.prepare("SELECT status FROM tasks WHERE id = ?").get("msg-test-1");
  addMessage("msg-test-1", "lead", "Just checking in");
  const taskAfter = db.prepare("SELECT status FROM tasks WHERE id = ?").get("msg-test-1");
  assert(taskBefore.status === taskAfter.status, "Sending message doesn't change task status");
}


// ============================================================
// TEST 7: Message response format matches UI expectations
// ============================================================
console.log("\n--- Test 7: API response format validation ---");
{
  const messages = getMessages("msg-test-1");
  // Simulate what the UI's renderMessages function does
  for (const m of messages) {
    const isLead = m.from === 'lead';
    const cls = isLead ? 'msg-lead' : 'msg-teammate';
    const sender = isLead ? 'Lead' : (m.from || 'Teammate');
    const time = m.at ? new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    assert(typeof cls === 'string', `Class computed: ${cls}`);
    assert(typeof sender === 'string' && sender.length > 0, `Sender computed: ${sender}`);
    assert(typeof time === 'string' && time.length > 0, `Time computed: ${time}`);
  }
  assert(true, "All messages render without errors in simulated UI logic");
}


// Cleanup
db.close();
fs.rmSync(tmpDir, { recursive: true });

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
process.exit(failed > 0 ? 1 : 0);
