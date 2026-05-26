// Unit tests for /ppt-spawn story-based spawn and auto-naming
// Run with: node tests/ppt-spawn.test.mjs
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pizza-spawn-test-"));
const teamDir = path.join(tmpDir, ".pi-pizza-team");
fs.mkdirSync(teamDir, { recursive: true });

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    failed++;
  }
}

// Set up a minimal DB mimicking the Store
const db = new Database(path.join(teamDir, "state.db"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS stories (
    id TEXT PRIMARY KEY,
    title TEXT,
    description TEXT,
    status TEXT DEFAULT 'open',
    depends_on TEXT DEFAULT '[]',
    dir TEXT,
    dir_path TEXT
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    story_id TEXT REFERENCES stories(id),
    seq INTEGER,
    slug TEXT,
    title TEXT,
    description TEXT,
    status TEXT DEFAULT 'todo',
    result TEXT,
    dir_path TEXT,
    dirty INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY,
    name TEXT,
    cwd TEXT,
    tmux_window TEXT,
    status TEXT DEFAULT 'idle',
    last_heartbeat INTEGER
  );
`);

// Insert test stories
db.prepare("INSERT INTO stories VALUES (?, ?, ?, ?, ?, ?, ?)").run(
  "auth-refactor", "Auth Refactor", "Refactor the auth module", "open", "[]", "~/Workspace/my-app", "/tmp/stories/auth-refactor"
);
db.prepare("INSERT INTO stories VALUES (?, ?, ?, ?, ?, ?, ?)").run(
  "no-dir-story", "No Dir Story", "Story without dir", "open", "[]", null, "/tmp/stories/no-dir-story"
);
db.prepare("INSERT INTO stories VALUES (?, ?, ?, ?, ?, ?, ?)").run(
  "done-story", "Done Story", "Already done", "done", "[]", "~/done", "/tmp/stories/done-story"
);
db.prepare("INSERT INTO stories VALUES (?, ?, ?, ?, ?, ?, ?)").run(
  "no-tasks-story", "No Tasks Story", "Has no todo tasks", "open", "[]", "~/x", "/tmp/stories/no-tasks-story"
);

// Insert tasks
db.prepare("INSERT INTO tasks (id, story_id, seq, slug, title, description, status) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
  "auth-refactor-1", "auth-refactor", 1, "setup", "Setup", "Do setup", "todo"
);
db.prepare("INSERT INTO tasks (id, story_id, seq, slug, title, description, status) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
  "no-dir-story-1", "no-dir-story", 1, "work", "Work", "Do work", "todo"
);
db.prepare("INSERT INTO tasks (id, story_id, seq, slug, title, description, status) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
  "done-story-1", "done-story", 1, "finished", "Finished", "Done", "done"
);
db.prepare("INSERT INTO tasks (id, story_id, seq, slug, title, description, status) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
  "no-tasks-story-1", "no-tasks-story", 1, "done-task", "Done Task", "Already done", "done"
);

// Insert an existing member to test auto-naming
db.prepare("INSERT INTO members (id, name, cwd, tmux_window, status, last_heartbeat) VALUES (?, ?, ?, ?, ?, ?)").run(
  "auth-refactor", "auth-refactor", "/tmp", "auth-refactor", "working", Date.now()
);

// --- Helper functions that simulate the handler logic ---

function getStory(id) {
  const row = db.prepare("SELECT * FROM stories WHERE id = ?").get(id);
  if (!row) return null;
  return { id: row.id, title: row.title, description: row.description, status: row.status, dependsOn: JSON.parse(row.depends_on), dir: row.dir || undefined, dirPath: row.dir_path };
}

function getMembers() {
  return db.prepare("SELECT * FROM members").all().map(r => ({ id: r.id, name: r.name }));
}

function getStories() {
  return db.prepare("SELECT * FROM stories").all().map(r => ({
    id: r.id, title: r.title, status: r.status, dir: r.dir || undefined
  }));
}

function getTasksForStory(storyId) {
  return db.prepare("SELECT * FROM tasks WHERE story_id = ?").all(storyId);
}

function resolveSpawn(firstArg, secondArg, ctxCwd) {
  const story = getStory(firstArg);
  let name, cwd;

  if (story) {
    const members = getMembers();
    const existingNames = new Set(members.map(m => m.id));
    name = firstArg;
    if (existingNames.has(name)) {
      let i = 2;
      while (existingNames.has(`${firstArg}-${i}`)) i++;
      name = `${firstArg}-${i}`;
    }
    const storyDir = story.dir || ctxCwd;
    cwd = storyDir.startsWith("~")
      ? storyDir.replace("~", process.env.HOME || "")
      : path.resolve(storyDir);
  } else {
    name = firstArg;
    const rawCwd = secondArg || ctxCwd;
    cwd = rawCwd.startsWith("~")
      ? rawCwd.replace("~", process.env.HOME || "")
      : path.resolve(rawCwd);
  }

  return { name, cwd, story };
}

function getCompletions(prefix) {
  const stories = getStories();
  const items = [];
  for (const story of stories) {
    if (story.status !== "open") continue;
    const tasks = getTasksForStory(story.id);
    const hasAvailable = tasks.some(t => t.status === "todo");
    if (!hasAvailable) continue;
    if (story.id.startsWith(prefix || "")) {
      items.push({ value: story.id, label: story.id, description: story.title });
    }
  }
  return items.length > 0 ? items : null;
}

// --- Tests ---

console.log("\n--- Test 1: Spawn with story that has a dir ---");
{
  const { name, cwd, story } = resolveSpawn("auth-refactor", undefined, "/fallback");
  // Since "auth-refactor" member already exists, should auto-increment
  assert(name === "auth-refactor-2", `Name auto-incremented: "${name}" === "auth-refactor-2"`);
  assert(cwd === (process.env.HOME + "/Workspace/my-app"), `Dir resolved: "${cwd}"`);
  assert(story !== null, "Story was found");
}

console.log("\n--- Test 2: Spawn with story without dir (falls back to cwd) ---");
{
  const { name, cwd } = resolveSpawn("no-dir-story", undefined, "/my/current/dir");
  assert(name === "no-dir-story", `Name is story slug: "${name}"`);
  assert(cwd === "/my/current/dir", `Falls back to ctx.cwd: "${cwd}"`);
}

console.log("\n--- Test 3: Auto-increment when teammate exists ---");
{
  // Add auth-refactor-2 as well to test further increment
  db.prepare("INSERT INTO members (id, name, cwd, tmux_window, status, last_heartbeat) VALUES (?, ?, ?, ?, ?, ?)").run(
    "auth-refactor-2", "auth-refactor-2", "/tmp", "auth-refactor-2", "working", Date.now()
  );
  const { name } = resolveSpawn("auth-refactor", undefined, "/fallback");
  assert(name === "auth-refactor-3", `Increments past existing -2: "${name}" === "auth-refactor-3"`);
}

console.log("\n--- Test 4: Legacy mode (name + cwd, no matching story) ---");
{
  const { name, cwd, story } = resolveSpawn("alice", "~/Code/project", "/fallback");
  assert(name === "alice", `Name is as given: "${name}"`);
  assert(cwd === (process.env.HOME + "/Code/project"), `Cwd resolved from ~: "${cwd}"`);
  assert(story === null, "No story matched");
}

console.log("\n--- Test 5: Legacy mode with absolute cwd ---");
{
  const { name, cwd } = resolveSpawn("bob", "/absolute/path", "/fallback");
  assert(name === "bob", `Name is as given: "${name}"`);
  assert(cwd === "/absolute/path", `Absolute cwd preserved: "${cwd}"`);
}

console.log("\n--- Test 6: Legacy mode without cwd (falls back to ctx.cwd) ---");
{
  const { name, cwd } = resolveSpawn("charlie", undefined, "/my/working/dir");
  assert(name === "charlie", `Name is as given: "${name}"`);
  assert(cwd === "/my/working/dir", `Falls back to ctx.cwd: "${cwd}"`);
}

console.log("\n--- Test 7: Autocomplete shows open stories with available tasks ---");
{
  const completions = getCompletions("");
  assert(completions !== null, "Completions returned");
  const ids = completions.map(c => c.value);
  assert(ids.includes("auth-refactor"), "Includes auth-refactor (open, has todo tasks)");
  assert(ids.includes("no-dir-story"), "Includes no-dir-story (open, has todo tasks)");
  assert(!ids.includes("done-story"), "Excludes done-story (status=done)");
  assert(!ids.includes("no-tasks-story"), "Excludes no-tasks-story (no todo tasks)");
}

console.log("\n--- Test 8: Autocomplete descriptions show story titles ---");
{
  const completions = getCompletions("auth");
  assert(completions !== null, "Completions returned for prefix 'auth'");
  assert(completions.length === 1, `Only one match: ${completions.length}`);
  assert(completions[0].description === "Auth Refactor", `Description is title: "${completions[0].description}"`);
}

console.log("\n--- Test 9: Autocomplete prefix filtering ---");
{
  const completions = getCompletions("no-dir");
  assert(completions !== null, "Completions returned for prefix 'no-dir'");
  assert(completions.length === 1, `One match for 'no-dir': ${completions.length}`);
  assert(completions[0].value === "no-dir-story", `Matched no-dir-story: "${completions[0].value}"`);
}

console.log("\n--- Test 10: Autocomplete with no matches ---");
{
  const completions = getCompletions("nonexistent");
  assert(completions === null, "Returns null when no matches");
}

// Cleanup
db.close();
fs.rmSync(tmpDir, { recursive: true });

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
process.exit(failed > 0 ? 1 : 0);
