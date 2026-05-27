// End-to-end tests for story deletion
// Run with: node tests/delete-story.test.mjs
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pizza-delete-test-"));
const teamDir = path.join(tmpDir, ".pi-pizza-team");
const storiesDir = path.join(teamDir, "stories");
fs.mkdirSync(storiesDir, { recursive: true });

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}`); failed++; }
}

// --- Setup: Minimal Store-like environment ---
const dbPath = path.join(teamDir, "state.db");
const db = new Database(dbPath);
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
    status TEXT DEFAULT 'todo', result TEXT, dir_path TEXT,
    dirty INTEGER DEFAULT 0, last_read_at INTEGER
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
  CREATE TABLE IF NOT EXISTS token_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT REFERENCES tasks(id), input_tokens INTEGER,
    output_tokens INTEGER, model TEXT, cost_usd REAL, recorded_at INTEGER
  );
`);

// --- Helper: create a story with tasks on disk + DB ---
function createStory(id, title, tasks = []) {
  const storyDir = path.join(storiesDir, id);
  const tasksDir = path.join(storyDir, "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });

  fs.writeFileSync(path.join(storyDir, "story.json"), JSON.stringify({
    id, title, description: "Test story", status: "open", dependsOn: []
  }, null, 2));

  db.prepare("INSERT INTO stories (id, title, description, status, depends_on, dir_path) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, title, "Test story", "open", "[]", storyDir);

  for (let i = 0; i < tasks.length; i++) {
    const taskId = `${id}/${String(i + 1).padStart(2, "0")}`;
    const slug = tasks[i].title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const taskDir = path.join(tasksDir, `${String(i + 1).padStart(2, "0")}-${slug}`);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "task.json"), JSON.stringify({
      id: taskId, title: tasks[i].title, description: tasks[i].description,
      status: tasks[i].status || "todo", result: null
    }, null, 2));

    db.prepare("INSERT INTO tasks (id, story_id, seq, slug, title, description, status, dir_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(taskId, id, i + 1, slug, tasks[i].title, tasks[i].description, tasks[i].status || "todo", taskDir);
  }
}

// --- Helper: deleteStory (mirrors store.deleteStory logic) ---
function deleteStory(storyId) {
  const story = db.prepare("SELECT * FROM stories WHERE id = ?").get(storyId);
  if (!story) return { success: false, error: "not found" };

  const tasks = db.prepare("SELECT * FROM tasks WHERE story_id = ?").all(storyId);
  const inProgress = tasks.filter(t => t.status === "in_progress");
  if (inProgress.length > 0) {
    return { success: false, error: `Cannot delete: ${inProgress.length} task(s) in progress` };
  }

  for (const task of tasks) {
    db.prepare("DELETE FROM assignments WHERE task_id = ?").run(task.id);
    db.prepare("DELETE FROM messages WHERE task_id = ?").run(task.id);
    db.prepare("DELETE FROM messages_loaded WHERE task_id = ?").run(task.id);
    db.prepare("DELETE FROM token_usage WHERE task_id = ?").run(task.id);
  }
  db.prepare("DELETE FROM tasks WHERE story_id = ?").run(storyId);
  db.prepare("DELETE FROM stories WHERE id = ?").run(storyId);

  if (story.dir_path && fs.existsSync(story.dir_path)) {
    fs.rmSync(story.dir_path, { recursive: true });
  }

  return { success: true };
}

// --- Tests ---

console.log("\n🗑️  Delete Story Tests\n");

// Test 1: Delete a story with todo tasks
console.log("Test 1: Delete story with todo tasks");
createStory("delete-me", "Deletable Story", [
  { title: "Task A", description: "Do A" },
  { title: "Task B", description: "Do B" },
]);
const storyDir1 = path.join(storiesDir, "delete-me");
assert(fs.existsSync(storyDir1), "story directory exists before delete");
const result1 = deleteStory("delete-me");
assert(result1.success === true, "delete returns success");
assert(!fs.existsSync(storyDir1), "story directory removed from disk");
assert(!db.prepare("SELECT 1 FROM stories WHERE id = ?").get("delete-me"), "story removed from DB");
assert(db.prepare("SELECT count(*) as c FROM tasks WHERE story_id = ?").get("delete-me").c === 0, "tasks removed from DB");

// Test 2: Cannot delete story with in_progress tasks
console.log("\nTest 2: Cannot delete story with in_progress tasks");
createStory("busy-story", "Busy Story", [
  { title: "Active Task", description: "Doing something", status: "in_progress" },
  { title: "Waiting", description: "Not started" },
]);
const result2 = deleteStory("busy-story");
assert(result2.success === false, "delete fails for in-progress story");
assert(result2.error.includes("in progress"), "error mentions in progress");
assert(fs.existsSync(path.join(storiesDir, "busy-story")), "story directory still exists");
assert(!!db.prepare("SELECT 1 FROM stories WHERE id = ?").get("busy-story"), "story still in DB");

// Test 3: Delete story that doesn't exist
console.log("\nTest 3: Delete non-existent story");
const result3 = deleteStory("nonexistent");
assert(result3.success === false, "delete fails for missing story");

// Test 4: Delete story with no tasks (empty story)
console.log("\nTest 4: Delete empty story (no tasks)");
createStory("empty-story", "Empty Story", []);
const result4 = deleteStory("empty-story");
assert(result4.success === true, "delete succeeds for empty story");
assert(!fs.existsSync(path.join(storiesDir, "empty-story")), "empty story directory removed");

// Test 5: Delete story with done tasks
console.log("\nTest 5: Delete story with done tasks");
createStory("done-story", "Done Story", [
  { title: "Finished", description: "All done", status: "done" },
]);
const result5 = deleteStory("done-story");
assert(result5.success === true, "delete succeeds for done story");
assert(!fs.existsSync(path.join(storiesDir, "done-story")), "done story directory removed");

// Test 6: Messages and assignments cleaned up
console.log("\nTest 6: Messages and assignments cleaned up on delete");
createStory("msg-story", "Story With Messages", [
  { title: "Chatty Task", description: "Has messages" },
]);
const taskId = "msg-story/01";
db.prepare("INSERT INTO messages (task_id, from_id, body, created_at) VALUES (?, ?, ?, ?)").run(taskId, "bot", "Hello", Date.now());
db.prepare("INSERT INTO assignments (task_id, member_id, claimed_at) VALUES (?, ?, ?)").run(taskId, "worker-1", Date.now());
db.prepare("INSERT INTO token_usage (task_id, input_tokens, output_tokens, model, cost_usd, recorded_at) VALUES (?, ?, ?, ?, ?, ?)").run(taskId, 100, 50, "test", 0.01, Date.now());
const result6 = deleteStory("msg-story");
assert(result6.success === true, "delete succeeds");
assert(db.prepare("SELECT count(*) as c FROM messages WHERE task_id = ?").get(taskId).c === 0, "messages cleaned up");
assert(!db.prepare("SELECT 1 FROM assignments WHERE task_id = ?").get(taskId), "assignments cleaned up");
assert(db.prepare("SELECT count(*) as c FROM token_usage WHERE task_id = ?").get(taskId).c === 0, "token usage cleaned up");

// --- Cleanup ---
db.close();
fs.rmSync(tmpDir, { recursive: true });

console.log(`\n${"═".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("✓ All delete-story tests passed!\n");
