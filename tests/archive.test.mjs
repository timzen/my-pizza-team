// End-to-end tests for story archiving
// Run with: node tests/archive.test.mjs
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pizza-archive-test-"));
const teamDir = path.join(tmpDir, ".pi-pizza-team");
const storiesDir = path.join(teamDir, "stories");
const archivedDir = path.join(teamDir, "archived");
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
  CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY, name TEXT, cwd TEXT, tmux_window TEXT,
    status TEXT DEFAULT 'idle', last_heartbeat INTEGER
  );
  CREATE TABLE IF NOT EXISTS token_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT REFERENCES tasks(id), input_tokens INTEGER,
    output_tokens INTEGER, model TEXT, cost_usd REAL, recorded_at INTEGER
  );
`);

// Helper functions that mirror store methods
function getTasksForStory(storyId) {
  return db.prepare("SELECT * FROM tasks WHERE story_id = ? ORDER BY seq").all(storyId);
}

function isStoryArchivable(storyId) {
  const tasks = getTasksForStory(storyId);
  if (tasks.length === 0) return false;
  return tasks.every(t => t.status === "done");
}

function archiveStory(storyId) {
  if (!isStoryArchivable(storyId)) {
    throw new Error(`Cannot archive story "${storyId}": not all tasks are done`);
  }
  const story = db.prepare("SELECT * FROM stories WHERE id = ?").get(storyId);
  if (!story) throw new Error(`Story "${storyId}" not found`);

  fs.mkdirSync(archivedDir, { recursive: true });

  const sourcePath = story.dir_path;
  const destPath = path.join(archivedDir, storyId);

  // Move directory
  fs.renameSync(sourcePath, destPath);

  // Update story.json with archivedAt timestamp
  const storyFile = path.join(destPath, "story.json");
  const storyData = JSON.parse(fs.readFileSync(storyFile, "utf-8"));
  const archivedAt = new Date().toISOString();
  storyData.archivedAt = archivedAt;
  fs.writeFileSync(storyFile, JSON.stringify(storyData, null, 2) + "\n");

  // Generate SYNOPSIS.md
  const tasks = getTasksForStory(storyId);
  const date = archivedAt.split("T")[0];
  const lines = [
    `# ${story.title}`, "",
    `**Archived**: ${date}`,
    `**ID**: ${story.id}`, "",
    "## Description", story.description, "",
    "## Tasks Completed", "",
  ];
  for (let i = 0; i < tasks.length; i++) {
    lines.push(`### ${i + 1}. ${tasks[i].title}`);
    lines.push(`**Status**: ${tasks[i].status}`);
    if (tasks[i].result) lines.push(`**Result**: ${tasks[i].result}`);
    lines.push("");
  }
  lines.push("## Summary");
  lines.push(`${tasks.length} task${tasks.length === 1 ? "" : "s"} completed for this story.`);
  lines.push("");
  fs.writeFileSync(path.join(destPath, "SYNOPSIS.md"), lines.join("\n"));

  // Remove from SQLite
  for (const task of tasks) {
    db.prepare("DELETE FROM assignments WHERE task_id = ?").run(task.id);
    db.prepare("DELETE FROM messages WHERE task_id = ?").run(task.id);
    db.prepare("DELETE FROM messages_loaded WHERE task_id = ?").run(task.id);
    db.prepare("DELETE FROM token_usage WHERE task_id = ?").run(task.id);
  }
  db.prepare("DELETE FROM tasks WHERE story_id = ?").run(storyId);
  db.prepare("DELETE FROM stories WHERE id = ?").run(storyId);

  return { archivedAt, destPath };
}

function getArchivedStories() {
  if (!fs.existsSync(archivedDir)) return [];
  const results = [];
  for (const dirName of fs.readdirSync(archivedDir)) {
    const dirPath = path.join(archivedDir, dirName);
    if (!fs.statSync(dirPath).isDirectory()) continue;
    const storyFile = path.join(dirPath, "story.json");
    if (!fs.existsSync(storyFile)) continue;
    const storyData = JSON.parse(fs.readFileSync(storyFile, "utf-8"));
    let synopsis = storyData.description || "";
    const synopsisFile = path.join(dirPath, "SYNOPSIS.md");
    if (fs.existsSync(synopsisFile)) {
      synopsis = fs.readFileSync(synopsisFile, "utf-8");
    }
    results.push({ id: storyData.id, title: storyData.title, archivedAt: storyData.archivedAt, synopsis });
  }
  return results;
}

function loadFromDisk() {
  // Only loads from stories/ — not archived/
  if (!fs.existsSync(storiesDir)) return;
  for (const storyDirName of fs.readdirSync(storiesDir)) {
    const storyDirPath = path.join(storiesDir, storyDirName);
    if (!fs.statSync(storyDirPath).isDirectory()) continue;
    const storyFile = path.join(storyDirPath, "story.json");
    if (!fs.existsSync(storyFile)) continue;
    const story = JSON.parse(fs.readFileSync(storyFile, "utf-8"));
    db.prepare("INSERT OR REPLACE INTO stories (id, title, description, status, depends_on, dir, dir_path) VALUES (?,?,?,?,?,?,?)")
      .run(story.id, story.title, story.description, story.status, JSON.stringify(story.dependsOn), story.dir || null, storyDirPath);
    const tasksPath = path.join(storyDirPath, "tasks");
    if (!fs.existsSync(tasksPath)) continue;
    for (const taskDirName of fs.readdirSync(tasksPath).sort()) {
      const taskDirPath = path.join(tasksPath, taskDirName);
      if (!fs.statSync(taskDirPath).isDirectory()) continue;
      const taskFile = path.join(taskDirPath, "task.json");
      if (!fs.existsSync(taskFile)) continue;
      const task = JSON.parse(fs.readFileSync(taskFile, "utf-8"));
      const match = taskDirName.match(/^(\d+)-(.+)$/);
      const seq = match ? parseInt(match[1], 10) : 0;
      const slug = match ? match[2] : taskDirName;
      db.prepare("INSERT OR REPLACE INTO tasks (id, story_id, seq, slug, title, description, status, result, dir_path, dirty) VALUES (?,?,?,?,?,?,?,?,?,0)")
        .run(task.id, story.id, seq, slug, task.title, task.description, task.status, task.result, taskDirPath);
    }
  }
}

// --- Create test story with 2 tasks ---
function createTestStory(storyId, title) {
  const storyDirPath = path.join(storiesDir, storyId);
  const tasksPath = path.join(storyDirPath, "tasks");
  fs.mkdirSync(tasksPath, { recursive: true });

  const storyData = { id: storyId, title, description: "Test description for " + title, status: "open", dependsOn: [] };
  fs.writeFileSync(path.join(storyDirPath, "story.json"), JSON.stringify(storyData, null, 2) + "\n");
  db.prepare("INSERT INTO stories (id, title, description, status, depends_on, dir, dir_path) VALUES (?,?,?,?,?,?,?)")
    .run(storyId, title, storyData.description, "open", "[]", null, storyDirPath);

  // Task 1
  const task1Dir = path.join(tasksPath, "01-task-one");
  fs.mkdirSync(task1Dir, { recursive: true });
  const task1 = { id: `${storyId}-1`, title: "Task One", description: "Do task one", status: "todo", result: null };
  fs.writeFileSync(path.join(task1Dir, "task.json"), JSON.stringify(task1, null, 2) + "\n");
  fs.writeFileSync(path.join(task1Dir, "messages.jsonl"), '{"from":"teammate","body":"Started work","at":"2025-01-01T00:00:00Z"}\n');
  db.prepare("INSERT INTO tasks (id, story_id, seq, slug, title, description, status, result, dir_path, dirty) VALUES (?,?,?,?,?,?,?,?,?,0)")
    .run(task1.id, storyId, 1, "task-one", task1.title, task1.description, task1.status, null, task1Dir);

  // Task 2
  const task2Dir = path.join(tasksPath, "02-task-two");
  fs.mkdirSync(task2Dir, { recursive: true });
  const task2 = { id: `${storyId}-2`, title: "Task Two", description: "Do task two", status: "todo", result: null };
  fs.writeFileSync(path.join(task2Dir, "task.json"), JSON.stringify(task2, null, 2) + "\n");
  db.prepare("INSERT INTO tasks (id, story_id, seq, slug, title, description, status, result, dir_path, dirty) VALUES (?,?,?,?,?,?,?,?,?,0)")
    .run(task2.id, storyId, 2, "task-two", task2.title, task2.description, task2.status, null, task2Dir);

  return { storyDirPath, task1Dir, task2Dir };
}

// ============================================================
// TESTS
// ============================================================

// --- Test 1: Cannot archive story with incomplete tasks ---
console.log("\n--- Test 1: Cannot archive story with incomplete tasks ---");
{
  const { storyDirPath } = createTestStory("story-incomplete", "Incomplete Story");

  assert(!isStoryArchivable("story-incomplete"), "Story with todo tasks is NOT archivable");

  let threw = false;
  try { archiveStory("story-incomplete"); } catch (e) { threw = true; }
  assert(threw, "archiveStory throws when tasks not all done");

  // Verify story still exists
  assert(fs.existsSync(storyDirPath), "Story directory still in stories/");
  const storyInDb = db.prepare("SELECT * FROM stories WHERE id = ?").get("story-incomplete");
  assert(storyInDb !== undefined, "Story still in SQLite");
}

// --- Test 2: Cannot archive story with partially complete tasks ---
console.log("\n--- Test 2: Partially complete story not archivable ---");
{
  // Mark only task 1 as done
  db.prepare("UPDATE tasks SET status = 'done', result = 'Done result' WHERE id = ?").run("story-incomplete-1");

  assert(!isStoryArchivable("story-incomplete"), "Story with 1/2 tasks done is NOT archivable");
}

// --- Test 3: Archive story with all tasks done ---
console.log("\n--- Test 3: Archive story with all tasks done ---");
{
  createTestStory("story-done", "Completed Story");

  // Complete both tasks
  db.prepare("UPDATE tasks SET status = 'done', result = 'Task one completed successfully' WHERE id = ?").run("story-done-1");
  db.prepare("UPDATE tasks SET status = 'done', result = 'Task two completed successfully' WHERE id = ?").run("story-done-2");

  // Add an assignment and messages for cleanup verification
  db.prepare("INSERT INTO assignments (task_id, member_id, claimed_at) VALUES (?, ?, ?)").run("story-done-1", "alice", Date.now());
  db.prepare("INSERT INTO messages (task_id, from_id, body, created_at) VALUES (?, ?, ?, ?)").run("story-done-1", "alice", "Test msg", Date.now());
  db.prepare("INSERT INTO token_usage (task_id, input_tokens, output_tokens, model, cost_usd, recorded_at) VALUES (?,?,?,?,?,?)")
    .run("story-done-1", 100, 50, "claude-sonnet", 0.01, Date.now());

  assert(isStoryArchivable("story-done"), "Story with all tasks done IS archivable");

  // Archive it
  const { archivedAt, destPath } = archiveStory("story-done");

  // Verify: story directory moved
  assert(!fs.existsSync(path.join(storiesDir, "story-done")), "Story dir removed from stories/");
  assert(fs.existsSync(destPath), "Story dir exists in archived/");

  // Verify: SYNOPSIS.md exists
  const synopsisPath = path.join(destPath, "SYNOPSIS.md");
  assert(fs.existsSync(synopsisPath), "SYNOPSIS.md exists");
  const synopsis = fs.readFileSync(synopsisPath, "utf-8");
  assert(synopsis.includes("# Completed Story"), "Synopsis has story title");
  assert(synopsis.includes("**Archived**:"), "Synopsis has archived date");
  assert(synopsis.includes("**ID**: story-done"), "Synopsis has story ID");
  assert(synopsis.includes("### 1. Task One"), "Synopsis has task 1");
  assert(synopsis.includes("### 2. Task Two"), "Synopsis has task 2");
  assert(synopsis.includes("Task one completed successfully"), "Synopsis has task 1 result");
  assert(synopsis.includes("2 tasks completed"), "Synopsis has summary");

  // Verify: story.json has archivedAt
  const storyJson = JSON.parse(fs.readFileSync(path.join(destPath, "story.json"), "utf-8"));
  assert(storyJson.archivedAt !== undefined, "story.json has archivedAt");
  assert(storyJson.archivedAt === archivedAt, "archivedAt matches");

  // Verify: all original files preserved
  assert(fs.existsSync(path.join(destPath, "tasks", "01-task-one", "task.json")), "Task 1 json preserved");
  assert(fs.existsSync(path.join(destPath, "tasks", "01-task-one", "messages.jsonl")), "Task 1 messages preserved");
  assert(fs.existsSync(path.join(destPath, "tasks", "02-task-two", "task.json")), "Task 2 json preserved");

  // Verify: removed from SQLite
  const storyInDb = db.prepare("SELECT * FROM stories WHERE id = ?").get("story-done");
  assert(storyInDb === undefined, "Story removed from SQLite");
  const tasksInDb = db.prepare("SELECT * FROM tasks WHERE story_id = ?").all("story-done");
  assert(tasksInDb.length === 0, "Tasks removed from SQLite");
  const assignments = db.prepare("SELECT * FROM assignments WHERE task_id LIKE ?").all("story-done%");
  assert(assignments.length === 0, "Assignments cleaned up");
  const messages = db.prepare("SELECT * FROM messages WHERE task_id LIKE ?").all("story-done%");
  assert(messages.length === 0, "Messages cleaned up");
  const tokenUsage = db.prepare("SELECT * FROM token_usage WHERE task_id LIKE ?").all("story-done%");
  assert(tokenUsage.length === 0, "Token usage cleaned up");
}

// --- Test 4: getArchivedStories returns archived story ---
console.log("\n--- Test 4: getArchivedStories returns archived stories ---");
{
  const archived = getArchivedStories();
  assert(archived.length === 1, "One archived story returned");
  assert(archived[0].id === "story-done", "Archived story has correct id");
  assert(archived[0].title === "Completed Story", "Archived story has correct title");
  assert(archived[0].archivedAt !== undefined, "Archived story has archivedAt");
  assert(archived[0].synopsis.includes("# Completed Story"), "Synopsis content returned");
}

// --- Test 5: loadFromDisk does NOT load archived stories ---
console.log("\n--- Test 5: loadFromDisk skips archived stories ---");
{
  // Clear DB and reload
  db.exec("DELETE FROM tasks");
  db.exec("DELETE FROM stories");

  loadFromDisk();

  // story-incomplete should be loaded (it's still in stories/)
  const loadedStory = db.prepare("SELECT * FROM stories WHERE id = ?").get("story-incomplete");
  assert(loadedStory !== undefined, "Active story (story-incomplete) loaded from disk");

  // story-done should NOT be loaded (it's in archived/)
  const archivedStory = db.prepare("SELECT * FROM stories WHERE id = ?").get("story-done");
  assert(archivedStory === undefined, "Archived story NOT loaded from disk");
}

// --- Test 6: Archived count is correct ---
console.log("\n--- Test 6: Archived stories count ---");
{
  const archived = getArchivedStories();
  assert(archived.length === 1, "Archived count is 1");

  // Archive another story (complete its tasks first)
  createTestStory("story-two", "Second Story");
  db.prepare("UPDATE tasks SET status = 'done', result = 'done' WHERE story_id = ?").run("story-two");
  archiveStory("story-two");

  const archivedAfter = getArchivedStories();
  assert(archivedAfter.length === 2, "Archived count is now 2");
}

// --- Test 7: Empty tasks story is not archivable ---
console.log("\n--- Test 7: Story with no tasks is not archivable ---");
{
  const emptyStoryDir = path.join(storiesDir, "story-empty");
  fs.mkdirSync(emptyStoryDir, { recursive: true });
  fs.writeFileSync(path.join(emptyStoryDir, "story.json"), JSON.stringify({ id: "story-empty", title: "Empty", description: "No tasks", status: "open", dependsOn: [] }));
  db.prepare("INSERT INTO stories (id, title, description, status, depends_on, dir, dir_path) VALUES (?,?,?,?,?,?,?)")
    .run("story-empty", "Empty", "No tasks", "open", "[]", null, emptyStoryDir);

  assert(!isStoryArchivable("story-empty"), "Story with no tasks is NOT archivable");
}

// --- Test 8: Simulate server restart — archived stays archived ---
console.log("\n--- Test 8: Server restart — archived stays archived ---");
{
  // Close and reopen DB (simulates restart)
  db.exec("DELETE FROM tasks");
  db.exec("DELETE FROM stories");

  // Reload only from stories/ dir
  loadFromDisk();

  const activeStories = db.prepare("SELECT * FROM stories").all();
  const activeIds = activeStories.map(s => s.id);
  assert(!activeIds.includes("story-done"), "story-done not in active after restart");
  assert(!activeIds.includes("story-two"), "story-two not in active after restart");

  // But archived dir still has them
  const archived = getArchivedStories();
  assert(archived.some(s => s.id === "story-done"), "story-done still in archived after restart");
  assert(archived.some(s => s.id === "story-two"), "story-two still in archived after restart");
}

// Cleanup
db.close();
fs.rmSync(tmpDir, { recursive: true });

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
process.exit(failed > 0 ? 1 : 0);
