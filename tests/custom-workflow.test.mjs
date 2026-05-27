// End-to-end tests for per-story custom workflows
// Run with: node tests/custom-workflow.test.mjs
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pizza-workflow-test-"));
const teamDir = path.join(tmpDir, ".pi-pizza-team");
const storiesDir = path.join(teamDir, "stories");
fs.mkdirSync(storiesDir, { recursive: true });

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}`); failed++; }
}

// --- Config with multiple workflows ---
const config = {
  port: 7437,
  tmuxSession: "test",
  defaultWorkflow: "default",
  workflows: {
    default: {
      states: ["todo", "in_progress", "needs_input", "review", "done"],
      transitions: {
        todo: { in_progress: "any" },
        in_progress: { needs_input: "teammate", review: "teammate" },
        needs_input: { in_progress: "lead" },
        review: { done: "lead", in_progress: "lead" },
      },
    },
    simple: {
      states: ["todo", "in_progress", "done"],
      transitions: {
        todo: { in_progress: "any" },
        in_progress: { done: "any" },
      },
    },
    strict: {
      states: ["todo", "in_progress", "qa", "done"],
      transitions: {
        todo: { in_progress: "teammate" },
        in_progress: { qa: "teammate" },
        qa: { done: "lead", in_progress: "lead" },
      },
    },
  },
  autosave: { flushIntervalMinutes: 9999, commitIntervalHours: 9999, commitMessage: "test", autoCommit: false },
  leaderUrl: "http://localhost:7437",
};

// --- Setup DB ---
const dbPath = path.join(teamDir, "state.db");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS stories (
    id TEXT PRIMARY KEY, title TEXT, description TEXT,
    status TEXT DEFAULT 'open', depends_on TEXT DEFAULT '[]',
    dir TEXT, workflow TEXT, dir_path TEXT
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

// --- Helpers that mirror store methods ---

function createStory(id, title, workflow, tasks = []) {
  const storyDir = path.join(storiesDir, id);
  const tasksDir = path.join(storyDir, "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(storyDir, "story.json"), JSON.stringify({
    id, title, description: "Test", status: "open", dependsOn: [], workflow: workflow || undefined,
  }, null, 2));
  db.prepare("INSERT INTO stories (id, title, description, status, depends_on, workflow, dir_path) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, title, "Test", "open", "[]", workflow || null, storyDir);
  for (let i = 0; i < tasks.length; i++) {
    const taskId = `${id}/${String(i + 1).padStart(2, "0")}`;
    const taskDir = path.join(tasksDir, `${String(i + 1).padStart(2, "0")}-task`);
    fs.mkdirSync(taskDir, { recursive: true });
    db.prepare("INSERT INTO tasks (id, story_id, seq, slug, title, description, status, dir_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(taskId, id, i + 1, "task", tasks[i].title, tasks[i].description || "", tasks[i].status || "todo", taskDir);
  }
}

function getWorkflowForStory(storyId) {
  const row = db.prepare("SELECT workflow FROM stories WHERE id = ?").get(storyId);
  const workflowName = (row && row.workflow) || config.defaultWorkflow;
  return config.workflows[workflowName] || config.workflows[config.defaultWorkflow];
}

function getWorkflowForTask(taskId) {
  const task = db.prepare("SELECT story_id FROM tasks WHERE id = ?").get(taskId);
  if (!task) return config.workflows[config.defaultWorkflow];
  return getWorkflowForStory(task.story_id);
}

function canTransition(taskId, newStatus, actor) {
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  if (!task) return { ok: false, error: "Task not found" };
  const workflow = getWorkflowForTask(taskId);
  const transitions = workflow.transitions[task.status];
  if (!transitions) return { ok: false, error: `No transitions from "${task.status}"` };
  const permission = transitions[newStatus];
  if (!permission) return { ok: false, error: `Cannot transition "${task.status}" → "${newStatus}"` };
  if (permission === "any") return { ok: true };
  if (permission === actor) return { ok: true };
  return { ok: false, error: `Requires "${permission}", got "${actor}"` };
}

// --- Tests ---
console.log("\n⚙️  Custom Workflow Tests\n");

// Test 1: Story with default workflow uses default transitions
console.log("Test 1: Default workflow transitions");
createStory("default-story", "Default Story", null, [{ title: "Task 1" }]);
const t1 = canTransition("default-story/01", "in_progress", "teammate");
assert(t1.ok === true, "todo → in_progress allowed for teammate (default workflow)");
const t1b = canTransition("default-story/01", "done", "teammate");
assert(t1b.ok === false, "todo → done NOT allowed (default workflow)");

// Test 2: Story with "simple" workflow
console.log("\nTest 2: Simple workflow transitions");
createStory("simple-story", "Simple Story", "simple", [{ title: "Task 1" }]);
const t2a = canTransition("simple-story/01", "in_progress", "teammate");
assert(t2a.ok === true, "todo → in_progress allowed (simple workflow)");
db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run("simple-story/01");
const t2b = canTransition("simple-story/01", "done", "teammate");
assert(t2b.ok === true, "in_progress → done allowed for teammate (simple workflow)");
const t2c = canTransition("simple-story/01", "review", "teammate");
assert(t2c.ok === false, "in_progress → review NOT allowed (simple workflow has no review)");

// Test 3: Story with "strict" workflow
console.log("\nTest 3: Strict workflow transitions");
createStory("strict-story", "Strict Story", "strict", [{ title: "Task 1" }]);
const t3a = canTransition("strict-story/01", "in_progress", "lead");
assert(t3a.ok === false, "todo → in_progress NOT allowed for lead (strict: teammate only)");
const t3b = canTransition("strict-story/01", "in_progress", "teammate");
assert(t3b.ok === true, "todo → in_progress allowed for teammate (strict)");
db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run("strict-story/01");
const t3c = canTransition("strict-story/01", "qa", "teammate");
assert(t3c.ok === true, "in_progress → qa allowed for teammate (strict)");
db.prepare("UPDATE tasks SET status = 'qa' WHERE id = ?").run("strict-story/01");
const t3d = canTransition("strict-story/01", "done", "teammate");
assert(t3d.ok === false, "qa → done NOT allowed for teammate (strict: lead only)");
const t3e = canTransition("strict-story/01", "done", "lead");
assert(t3e.ok === true, "qa → done allowed for lead (strict)");

// Test 4: Workflow resolution falls back to default for unknown workflow name
console.log("\nTest 4: Unknown workflow falls back to default");
createStory("unknown-wf-story", "Unknown WF", "nonexistent", [{ title: "Task 1" }]);
const wf = getWorkflowForStory("unknown-wf-story");
assert(wf === config.workflows.default, "Unknown workflow resolves to default");
const t4 = canTransition("unknown-wf-story/01", "in_progress", "teammate");
assert(t4.ok === true, "Transition works using default workflow fallback");

// Test 5: workflow field persisted in story.json
console.log("\nTest 5: workflow field persisted on disk");
const storyJson = JSON.parse(fs.readFileSync(path.join(storiesDir, "simple-story", "story.json"), "utf-8"));
assert(storyJson.workflow === "simple", "story.json has workflow field");
const defaultJson = JSON.parse(fs.readFileSync(path.join(storiesDir, "default-story", "story.json"), "utf-8"));
assert(defaultJson.workflow === undefined, "story.json omits workflow when using default");

// Test 6: Different stories can use different workflows independently
console.log("\nTest 6: Multiple stories with different workflows coexist");
const simpleWf = getWorkflowForStory("simple-story");
const strictWf = getWorkflowForStory("strict-story");
const defaultWf = getWorkflowForStory("default-story");
assert(simpleWf.states.length === 3, "simple has 3 states");
assert(strictWf.states.length === 4, "strict has 4 states");
assert(defaultWf.states.length === 5, "default has 5 states");

// --- Cleanup ---
db.close();
fs.rmSync(tmpDir, { recursive: true });

console.log(`\n${"═".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("✓ All custom-workflow tests passed!\n");
