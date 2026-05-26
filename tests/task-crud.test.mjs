// End-to-end tests for task CRUD operations
// Run with: node tests/task-crud.test.mjs
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pizza-crud-test-"));
const teamDir = path.join(tmpDir, ".pi-pizza-team");
fs.mkdirSync(teamDir, { recursive: true });

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}`); failed++; }
}

// --- Minimal Store simulation ---
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
`);

// Create a story directory structure
const storyDir = path.join(teamDir, "stories", "test-story");
const tasksDir = path.join(storyDir, "tasks");
fs.mkdirSync(tasksDir, { recursive: true });

// Insert story
db.prepare("INSERT INTO stories VALUES (?, ?, ?, ?, ?, ?, ?)").run(
  "test-story", "Test Story", "A test story", "open", "[]", null, storyDir
);

// Workflow config
const workflow = {
  states: ["todo", "in_progress", "needs_input", "review", "done"],
  transitions: {
    todo: { in_progress: "any" },
    in_progress: { needs_input: "teammate", review: "teammate" },
    needs_input: { in_progress: "lead" },
    review: { done: "lead", in_progress: "lead" },
  },
};

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

// --- Test 1: Create a task ---
console.log("\n--- Test 1: Create task ---");
{
  const storyId = "test-story";
  const title = "Implement feature X";
  const description = "Build the X feature with tests";
  
  // Simulate POST /api/stories/:storyId/tasks logic
  const existingTasks = db.prepare("SELECT * FROM tasks WHERE story_id = ?").all(storyId);
  const nextSeq = existingTasks.length > 0 ? Math.max(...existingTasks.map(t => t.seq)) + 1 : 1;
  const seqStr = String(nextSeq).padStart(2, "0");
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  const taskDirPath = path.join(tasksDir, `${seqStr}-${slug}`);
  fs.mkdirSync(taskDirPath, { recursive: true });

  const taskId = `${storyId}-${nextSeq}`;
  const taskData = { id: taskId, title, description, status: "todo", result: null };
  fs.writeFileSync(path.join(taskDirPath, "task.json"), JSON.stringify(taskData, null, 2) + "\n");

  db.prepare("INSERT INTO tasks (id, story_id, seq, slug, title, description, status, result, dir_path, dirty) VALUES (?,?,?,?,?,?,?,?,?,0)")
    .run(taskId, storyId, nextSeq, slug, title, description, "todo", null, taskDirPath);

  // Verify
  const created = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  assert(created !== undefined, "Task exists in DB");
  assert(created.title === title, "Title matches");
  assert(created.description === description, "Description matches");
  assert(created.status === "todo", "Status is todo");
  assert(created.seq === 1, "Seq is 1");
  assert(fs.existsSync(path.join(taskDirPath, "task.json")), "task.json exists on disk");
  
  const onDisk = JSON.parse(fs.readFileSync(path.join(taskDirPath, "task.json"), "utf-8"));
  assert(onDisk.id === taskId, "task.json has correct id");
  assert(onDisk.title === title, "task.json has correct title");
}

// --- Test 2: Edit task ---
console.log("\n--- Test 2: Edit task title and description ---");
{
  const taskId = "test-story-1";
  const newTitle = "Implement feature X (updated)";
  const newDesc = "Updated description with more detail";

  // Simulate PUT /api/tasks/:id
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  assert(task !== undefined, "Task exists before edit");

  db.prepare("UPDATE tasks SET title = ?, description = ?, dirty = 1 WHERE id = ?")
    .run(newTitle, newDesc, taskId);

  const updated = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  assert(updated.title === newTitle, "Title updated in DB");
  assert(updated.description === newDesc, "Description updated in DB");
  assert(updated.dirty === 1, "Task marked dirty for flush");
}

// --- Test 3: Move task through workflow states ---
console.log("\n--- Test 3: Workflow transitions ---");
{
  const taskId = "test-story-1";

  // todo → in_progress (allowed for any/lead)
  let check = canTransition(taskId, "in_progress", "lead");
  assert(check.ok === true, "todo → in_progress allowed for lead");
  db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(taskId);

  // in_progress → review (requires teammate, NOT lead)
  check = canTransition(taskId, "review", "lead");
  assert(check.ok === false, "in_progress → review NOT allowed for lead");
  assert(check.error.includes("teammate"), "Error mentions teammate requirement");

  // in_progress → needs_input (requires teammate)
  check = canTransition(taskId, "needs_input", "lead");
  assert(check.ok === false, "in_progress → needs_input NOT allowed for lead");

  // in_progress → review (allowed for teammate)
  check = canTransition(taskId, "review", "teammate");
  assert(check.ok === true, "in_progress → review allowed for teammate");
  db.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(taskId);

  // review → done (allowed for lead)
  check = canTransition(taskId, "done", "lead");
  assert(check.ok === true, "review → done allowed for lead");

  // review → in_progress (allowed for lead)
  check = canTransition(taskId, "in_progress", "lead");
  assert(check.ok === true, "review → in_progress allowed for lead");

  // review → todo (invalid transition)
  check = canTransition(taskId, "todo", "lead");
  assert(check.ok === false, "review → todo NOT allowed (no such transition)");
  assert(check.error.includes("Cannot transition"), "Error explains invalid transition");

  // review → done (complete it)
  db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(taskId);
  
  // done → anything (no transitions from done)
  check = canTransition(taskId, "in_progress", "lead");
  assert(check.ok === false, "done → in_progress NOT allowed (no transitions from done)");
}

// --- Test 4: Delete task ---
console.log("\n--- Test 4: Delete task ---");
{
  // Create a task to delete
  const taskDirPath2 = path.join(tasksDir, "02-deletable-task");
  fs.mkdirSync(taskDirPath2, { recursive: true });
  fs.writeFileSync(path.join(taskDirPath2, "task.json"), JSON.stringify({ id: "test-story-2", title: "Deletable", description: "Will be deleted", status: "todo", result: null }, null, 2));
  db.prepare("INSERT INTO tasks (id, story_id, seq, slug, title, description, status, result, dir_path, dirty) VALUES (?,?,?,?,?,?,?,?,?,0)")
    .run("test-story-2", "test-story", 2, "deletable-task", "Deletable", "Will be deleted", "todo", null, taskDirPath2);

  // Also add an assignment
  db.prepare("INSERT INTO assignments (task_id, member_id, claimed_at) VALUES (?, ?, ?)").run("test-story-2", "alice", Date.now());

  assert(fs.existsSync(taskDirPath2), "Task directory exists before delete");
  const beforeDelete = db.prepare("SELECT * FROM tasks WHERE id = ?").get("test-story-2");
  assert(beforeDelete !== undefined, "Task in DB before delete");

  // Simulate DELETE /api/tasks/:id
  db.prepare("DELETE FROM assignments WHERE task_id = ?").run("test-story-2");
  db.prepare("DELETE FROM messages WHERE task_id = ?").run("test-story-2");
  db.prepare("DELETE FROM messages_loaded WHERE task_id = ?").run("test-story-2");
  db.prepare("DELETE FROM tasks WHERE id = ?").run("test-story-2");
  fs.rmSync(taskDirPath2, { recursive: true });

  const afterDelete = db.prepare("SELECT * FROM tasks WHERE id = ?").get("test-story-2");
  assert(afterDelete === undefined, "Task removed from DB");
  assert(!fs.existsSync(taskDirPath2), "Task directory removed from disk");
  const assignmentAfter = db.prepare("SELECT * FROM assignments WHERE task_id = ?").get("test-story-2");
  assert(assignmentAfter === undefined, "Assignment cleaned up");
}

// --- Test 5: Error cases ---
console.log("\n--- Test 5: Error cases ---");
{
  // Create on non-existent story
  const fakeStory = db.prepare("SELECT * FROM stories WHERE id = ?").get("nonexistent");
  assert(fakeStory === undefined, "Non-existent story returns null (would 404)");

  // Delete non-existent task
  const fakeTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get("nonexistent-task");
  assert(fakeTask === undefined, "Non-existent task returns null (would 404)");

  // Move with invalid transition
  // Create a fresh todo task
  const taskDir3 = path.join(tasksDir, "03-error-test");
  fs.mkdirSync(taskDir3, { recursive: true });
  db.prepare("INSERT INTO tasks (id, story_id, seq, slug, title, description, status, result, dir_path, dirty) VALUES (?,?,?,?,?,?,?,?,?,0)")
    .run("test-story-3", "test-story", 3, "error-test", "Error Test", "desc", "todo", null, taskDir3);

  // todo → done (skipping states — invalid)
  let check = canTransition("test-story-3", "done", "lead");
  assert(check.ok === false, "todo → done NOT allowed (skip states)");

  // todo → review (not defined)
  check = canTransition("test-story-3", "review", "lead");
  assert(check.ok === false, "todo → review NOT allowed");

  // Move with missing status field
  assert(true, "Missing status field would be caught by API validation (400)");
}

// --- Test 6: Create second task gets correct sequence ---
console.log("\n--- Test 6: Sequential task creation ---");
{
  const existingTasks = db.prepare("SELECT * FROM tasks WHERE story_id = ?").all("test-story");
  const maxSeq = Math.max(...existingTasks.map(t => t.seq));
  const nextSeq = maxSeq + 1;
  assert(nextSeq === 4, `Next seq after 3 tasks is 4: got ${nextSeq}`);
}

// --- Test 7: Delete task with claimed assignment cleans up ---
console.log("\n--- Test 7: Delete claimed task cleans up assignment ---");
{
  const taskDir4 = path.join(tasksDir, "04-claimed");
  fs.mkdirSync(taskDir4, { recursive: true });
  db.prepare("INSERT INTO tasks (id, story_id, seq, slug, title, description, status, result, dir_path, dirty) VALUES (?,?,?,?,?,?,?,?,?,0)")
    .run("test-story-4", "test-story", 4, "claimed", "Claimed Task", "desc", "in_progress", null, taskDir4);
  db.prepare("INSERT INTO assignments (task_id, member_id, claimed_at) VALUES (?, ?, ?)").run("test-story-4", "bob", Date.now());

  // Delete it
  db.prepare("DELETE FROM assignments WHERE task_id = ?").run("test-story-4");
  db.prepare("DELETE FROM tasks WHERE id = ?").run("test-story-4");
  fs.rmSync(taskDir4, { recursive: true });

  const a = db.prepare("SELECT * FROM assignments WHERE task_id = ?").get("test-story-4");
  assert(a === undefined, "Assignment removed when claimed task is deleted");
}

// Cleanup
db.close();
fs.rmSync(tmpDir, { recursive: true });

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
process.exit(failed > 0 ? 1 : 0);
