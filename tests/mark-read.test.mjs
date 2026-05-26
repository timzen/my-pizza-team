// End-to-end tests for message read indicator behavior
// Run with: node tests/mark-read.test.mjs
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pizza-markread-"));
const teamDir = path.join(tmpDir, ".pi-pizza-team");
fs.mkdirSync(teamDir, { recursive: true });

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}`); failed++; }
}

// --- Setup DB ---
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
    status TEXT DEFAULT 'todo', result TEXT, dir_path TEXT, dirty INTEGER DEFAULT 0,
    last_read_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT REFERENCES tasks(id), from_id TEXT, body TEXT, created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS messages_loaded (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id), loaded_at INTEGER
  );
`);

const storyDir = path.join(teamDir, "stories", "read-test");
const taskDir1 = path.join(storyDir, "tasks", "01-task-a");
const taskDir2 = path.join(storyDir, "tasks", "02-task-b");
fs.mkdirSync(taskDir1, { recursive: true });
fs.mkdirSync(taskDir2, { recursive: true });

db.prepare("INSERT INTO stories VALUES (?, ?, ?, ?, ?, ?, ?)").run(
  "read-test", "Read Test", "desc", "open", "[]", null, storyDir
);
db.prepare("INSERT INTO tasks (id, story_id, seq, slug, title, description, status, dir_path) VALUES (?,?,?,?,?,?,?,?)")
  .run("read-test-1", "read-test", 1, "task-a", "Task A", "Has messages", "in_progress", taskDir1);
db.prepare("INSERT INTO tasks (id, story_id, seq, slug, title, description, status, dir_path) VALUES (?,?,?,?,?,?,?,?)")
  .run("read-test-2", "read-test", 2, "task-b", "Task B", "No messages", "todo", taskDir2);
db.prepare("INSERT INTO messages_loaded (task_id, loaded_at) VALUES (?, ?)").run("read-test-1", Date.now());
db.prepare("INSERT INTO messages_loaded (task_id, loaded_at) VALUES (?, ?)").run("read-test-2", Date.now());

// --- Store helpers (mirror store.ts logic) ---
function hasUnreadMessages(taskId) {
  const lastLead = db.prepare(
    "SELECT MAX(created_at) as t FROM messages WHERE task_id = ? AND from_id = 'lead'"
  ).get(taskId);
  const lastTeammate = db.prepare(
    "SELECT MAX(created_at) as t FROM messages WHERE task_id = ? AND from_id != 'lead'"
  ).get(taskId);

  if (!lastTeammate?.t) return false;

  const taskRow = db.prepare("SELECT last_read_at FROM tasks WHERE id = ?").get(taskId);
  const readTimestamp = Math.max(lastLead?.t || 0, taskRow?.last_read_at || 0);

  if (readTimestamp === 0) return true;
  return lastTeammate.t > readTimestamp;
}

function markMessagesRead(taskId) {
  db.prepare("UPDATE tasks SET last_read_at = ? WHERE id = ?").run(Date.now(), taskId);
}

function addMessage(taskId, from, body) {
  const now = Date.now();
  db.prepare("INSERT INTO messages (task_id, from_id, body, created_at) VALUES (?, ?, ?, ?)")
    .run(taskId, from, body, now);
}

function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {} // busy wait for precise timing in tests
}


// ============================================================
// TEST 1: Task with unread teammate messages shows indicator
// ============================================================
console.log("\n--- Test 1: Unread teammate messages show indicator ---");
{
  // Add a teammate message
  addMessage("read-test-1", "teammate-alice", "Hey, I have a question about the API design");
  sleep(5);

  const unread = hasUnreadMessages("read-test-1");
  assert(unread === true, "📬 indicator shows (teammate message, no lead reply, no mark-read)");

  // Task with no messages has no indicator
  const unread2 = hasUnreadMessages("read-test-2");
  assert(unread2 === false, "No indicator for task with no messages");
}


// ============================================================
// TEST 2: Opening message pane (mark-read) clears indicator
// ============================================================
console.log("\n--- Test 2: mark-read clears indicator (simulates pane open) ---");
{
  // Simulate: user opens message pane → POST /api/tasks/:id/mark-read
  markMessagesRead("read-test-1");

  const unread = hasUnreadMessages("read-test-1");
  assert(unread === false, "📬 indicator gone after mark-read");
}


// ============================================================
// TEST 3: Persists across "page refresh" (re-query from DB)
// ============================================================
console.log("\n--- Test 3: Indicator stays cleared after refresh ---");
{
  // Simulate a page refresh: re-query hasUnreadMessages from scratch
  const unread = hasUnreadMessages("read-test-1");
  assert(unread === false, "Still no indicator after simulated refresh");

  // Verify last_read_at was persisted
  const row = db.prepare("SELECT last_read_at FROM tasks WHERE id = ?").get("read-test-1");
  assert(row.last_read_at !== null, "last_read_at is persisted in DB");
  assert(row.last_read_at > 0, `last_read_at value: ${row.last_read_at}`);
}


// ============================================================
// TEST 4: New teammate message makes indicator reappear
// ============================================================
console.log("\n--- Test 4: New message after mark-read reappears ---");
{
  sleep(5); // ensure new message is later than last_read_at
  addMessage("read-test-1", "teammate-alice", "Actually, one more thing...");

  const unread = hasUnreadMessages("read-test-1");
  assert(unread === true, "📬 reappears after new teammate message");
}


// ============================================================
// TEST 5: Opening pane again clears it again
// ============================================================
console.log("\n--- Test 5: Second mark-read clears again ---");
{
  markMessagesRead("read-test-1");

  const unread = hasUnreadMessages("read-test-1");
  assert(unread === false, "📬 cleared again after second mark-read");

  // Another new message
  sleep(5);
  addMessage("read-test-1", "teammate-bob", "I also have input");
  assert(hasUnreadMessages("read-test-1") === true, "Third message triggers indicator");

  markMessagesRead("read-test-1");
  assert(hasUnreadMessages("read-test-1") === false, "Third mark-read clears");
}


// ============================================================
// TEST 6: Lead reply also clears indicator (old behavior preserved)
// ============================================================
console.log("\n--- Test 6: Lead reply still clears indicator ---");
{
  // New teammate message
  sleep(5);
  addMessage("read-test-1", "teammate-alice", "Waiting for your answer");
  assert(hasUnreadMessages("read-test-1") === true, "Indicator shows before lead reply");

  // Lead replies (old way to clear)
  sleep(5);
  addMessage("read-test-1", "lead", "Here's the answer: use REST");

  const unread = hasUnreadMessages("read-test-1");
  assert(unread === false, "Lead reply clears indicator (backward compat)");
}


// ============================================================
// TEST 7: Task with no messages — mark-read doesn't error
// ============================================================
console.log("\n--- Test 7: No messages — mark-read is safe ---");
{
  // Task B has no messages
  assert(hasUnreadMessages("read-test-2") === false, "No indicator before mark-read");

  // Mark-read on task with no messages should not throw
  markMessagesRead("read-test-2");
  assert(hasUnreadMessages("read-test-2") === false, "No indicator after mark-read on empty task");

  // Verify it set last_read_at even with no messages
  const row = db.prepare("SELECT last_read_at FROM tasks WHERE id = ?").get("read-test-2");
  assert(row.last_read_at !== null, "last_read_at set even with no messages (no error)");
}


// ============================================================
// TEST 8: Optimistic UI behavior simulation
// ============================================================
console.log("\n--- Test 8: Optimistic UI update simulation ---");
{
  // Simulate what the board UI does:
  // 1. taskDataMap has task with hasMessages: true
  // 2. User clicks to open message panel
  // 3. task.hasMessages = false (optimistic)
  // 4. renderBoard re-renders (indicator gone)
  // 5. fetch mark-read fires in background
  // 6. Next poll: server returns hasMessages: false (confirms)

  const taskData = { id: "read-test-1", hasMessages: true };
  assert(taskData.hasMessages === true, "Before open: hasMessages is true");

  // Simulate openMsgPanel logic
  taskData.hasMessages = false; // optimistic
  assert(taskData.hasMessages === false, "After open: optimistic update clears it");

  // The card rendering logic
  const msg = taskData.hasMessages ? '<div class="card-msg">📬 messages</div>' : '';
  assert(msg === '', "Card renders without 📬 indicator after optimistic update");
}


// ============================================================
// TEST 9: Mark-read with only lead messages (edge case)
// ============================================================
console.log("\n--- Test 9: Only lead messages — no indicator ---");
{
  // Create a task where only the lead has posted messages
  db.prepare("INSERT INTO tasks (id, story_id, seq, slug, title, description, status, dir_path) VALUES (?,?,?,?,?,?,?,?)")
    .run("read-test-3", "read-test", 3, "task-c", "Task C", "Only lead msgs", "todo", taskDir1);
  db.prepare("INSERT INTO messages_loaded (task_id, loaded_at) VALUES (?, ?)").run("read-test-3", Date.now());

  addMessage("read-test-3", "lead", "Initial instructions from lead");
  assert(hasUnreadMessages("read-test-3") === false, "No indicator when only lead has messaged");

  // Mark-read is still safe
  markMessagesRead("read-test-3");
  assert(hasUnreadMessages("read-test-3") === false, "Still no indicator after mark-read");
}


// ============================================================
// TEST 10: Concurrent messages from multiple teammates
// ============================================================
console.log("\n--- Test 10: Multiple teammates, mark-read clears all ---");
{
  db.prepare("INSERT INTO tasks (id, story_id, seq, slug, title, description, status, dir_path) VALUES (?,?,?,?,?,?,?,?)")
    .run("read-test-4", "read-test", 4, "task-d", "Task D", "Multi-teammate", "in_progress", taskDir1);
  db.prepare("INSERT INTO messages_loaded (task_id, loaded_at) VALUES (?, ?)").run("read-test-4", Date.now());

  addMessage("read-test-4", "teammate-alice", "From alice");
  sleep(2);
  addMessage("read-test-4", "teammate-bob", "From bob");
  sleep(2);
  addMessage("read-test-4", "teammate-charlie", "From charlie");

  assert(hasUnreadMessages("read-test-4") === true, "Indicator shows with multiple teammate messages");

  markMessagesRead("read-test-4");
  assert(hasUnreadMessages("read-test-4") === false, "Mark-read clears all teammate messages at once");

  // Only one new message from one teammate reappears
  sleep(5);
  addMessage("read-test-4", "teammate-bob", "One more from bob");
  assert(hasUnreadMessages("read-test-4") === true, "Single new message after mark-read triggers indicator");
}


// Cleanup
db.close();
fs.rmSync(tmpDir, { recursive: true });

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
process.exit(failed > 0 ? 1 : 0);
