// Unit tests for teammate spawning: name generation + directory resolution
// Run with: node tests/ppt-spawn.test.mjs
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pizza-spawn-test-"));
const teamDir = path.join(tmpDir, ".pi-pizza-team");
const storiesDir = path.join(teamDir, "stories");
fs.mkdirSync(storiesDir, { recursive: true });

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}`); failed++; }
}

// --- DB Setup ---
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
    id TEXT PRIMARY KEY, story_id TEXT, seq INTEGER, slug TEXT,
    title TEXT, description TEXT, status TEXT DEFAULT 'todo',
    result TEXT, dir_path TEXT, dirty INTEGER DEFAULT 0, last_read_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY, name TEXT, cwd TEXT, tmux_window TEXT,
    status TEXT DEFAULT 'idle', last_heartbeat INTEGER
  );
`);

// Insert test data
db.prepare("INSERT INTO stories VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
  "auth-refactor", "Auth Refactor", "Fix auth", "open", "[]", "~/Workspace/my-app", null, path.join(storiesDir, "auth-refactor")
);
db.prepare("INSERT INTO stories VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
  "no-dir-story", "No Dir Story", "Has no dir", "open", "[]", null, null, path.join(storiesDir, "no-dir-story")
);
db.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
  "auth-refactor/01", "auth-refactor", 1, "setup", "Setup", "Do setup", "todo", null, "/tmp", 0, null
);
db.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
  "no-dir-story/01", "no-dir-story", 1, "task", "Task", "Do task", "todo", null, "/tmp", 0, null
);

// Add an existing member
db.prepare("INSERT INTO members VALUES (?, ?, ?, ?, ?, ?)").run(
  "swift-kirk", "swift-kirk", "/tmp", "swift-kirk", "working", Date.now()
);

// --- Import the name generator (inline version for testing) ---

const DEFAULT_ADJECTIVES = [
  "swift", "bold", "keen", "calm", "bright",
  "deft", "firm", "sharp", "brave", "quick",
  "sly", "warm", "cool", "wild", "fair",
  "wry", "apt", "sage", "prime", "vivid",
];

const DEFAULT_NOUNS = [
  "ripley", "kirk", "spock", "solo", "neo",
  "trinity", "deckard", "muad-dib", "case", "molly",
  "picard", "data", "worf", "uhura", "sulu",
  "riker", "bones", "chekov", "scotty", "seven",
  "janeway", "tuvok", "odo", "quark", "kira",
  "adama", "starbuck", "gaius", "athena", "apollo",
];

function generateTeammateName(existingNames, config) {
  const nouns = config?.nouns?.length ? config.nouns : DEFAULT_NOUNS;
  const adjectives = DEFAULT_ADJECTIVES;
  for (let i = 0; i < 100; i++) {
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    const name = `${adj}-${noun}`;
    if (!existingNames.has(name)) return name;
  }
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  let name = `${adj}-${noun}`;
  let i = 2;
  while (existingNames.has(name)) { name = `${adj}-${noun}-${i}`; i++; }
  return name;
}

// --- Helpers ---
function getMembers() {
  return db.prepare("SELECT * FROM members").all();
}

function getStories() {
  return db.prepare("SELECT * FROM stories").all().map(r => ({
    id: r.id, title: r.title, dir: r.dir, status: r.status
  }));
}

function getTasksForStory(storyId) {
  return db.prepare("SELECT * FROM tasks WHERE story_id = ?").all(storyId);
}

function getSpawnOptions(favorites) {
  const options = [];
  const stories = getStories();
  for (const story of stories) {
    if (story.status !== "open" || !story.dir) continue;
    const tasks = getTasksForStory(story.id);
    if (tasks.some(t => t.status === "todo") && !options.some(o => o.dir === story.dir)) {
      options.push({ dir: story.dir, source: "story", label: story.title });
    }
  }
  for (const dir of (favorites || [])) {
    if (!options.some(o => o.dir === dir)) {
      options.push({ dir, source: "favorite" });
    }
  }
  return options;
}

// --- Tests ---

console.log("\n🤖 Teammate Spawn Tests\n");

// Test 1: Name generation produces adjective-noun format
console.log("Test 1: Name generation format");
{
  const existingNames = new Set();
  const name = generateTeammateName(existingNames, null);
  assert(name.includes("-"), `Name has hyphen: "${name}"`);
  const parts = name.split("-");
  assert(parts.length >= 2, `Name has at least 2 parts: "${name}"`);
  assert(DEFAULT_ADJECTIVES.includes(parts[0]), `First part is an adjective: "${parts[0]}"`);
  assert(DEFAULT_NOUNS.includes(parts.slice(1).join("-")), `Rest is a noun: "${parts.slice(1).join("-")}"`);
}

// Test 2: Name generation avoids collisions
console.log("\nTest 2: Name avoids collisions");
{
  const existingNames = new Set(["swift-kirk"]);
  const name = generateTeammateName(existingNames, null);
  assert(name !== "swift-kirk", `Name is not the existing one: "${name}"`);
  assert(!existingNames.has(name), "Generated name not in existing set");
}

// Test 3: Custom nouns config
console.log("\nTest 3: Custom nouns");
{
  const existingNames = new Set();
  const config = { nouns: ["pizza", "pasta", "risotto"] };
  const name = generateTeammateName(existingNames, config);
  const noun = name.split("-").slice(1).join("-");
  assert(config.nouns.includes(noun), `Noun is from custom list: "${noun}"`);
}

// Test 4: Spawn options include story dirs with available tasks
console.log("\nTest 4: Spawn options from stories");
{
  const options = getSpawnOptions([]);
  assert(options.some(o => o.dir === "~/Workspace/my-app" && o.source === "story"), "Story dir included");
  assert(!options.some(o => o.source === "story" && o.label === "No Dir Story"), "Story without dir excluded");
}

// Test 5: Spawn options include favorites
console.log("\nTest 5: Spawn options include favorites");
{
  const options = getSpawnOptions(["~/Projects/cool-app", "~/Workspace/my-app"]);
  assert(options.some(o => o.dir === "~/Projects/cool-app" && o.source === "favorite"), "Favorite dir included");
  // my-app already from story, should not duplicate
  assert(options.filter(o => o.dir === "~/Workspace/my-app").length === 1, "No duplicate for story+favorite overlap");
}

// Test 6: Spawn options exclude stories with no todo tasks
console.log("\nTest 6: Stories without todo tasks excluded");
{
  db.prepare("UPDATE tasks SET status = 'done' WHERE story_id = 'auth-refactor'").run();
  const options = getSpawnOptions([]);
  assert(!options.some(o => o.dir === "~/Workspace/my-app"), "Story with no todo tasks excluded");
  db.prepare("UPDATE tasks SET status = 'todo' WHERE story_id = 'auth-refactor'").run();
}

// Test 7: Name generation with all combinations taken falls back to numbered
console.log("\nTest 7: Fallback to numbered name when saturated");
{
  // Create a set with all possible adj-noun combos for a tiny config
  const config = { nouns: ["x"] };
  const existingNames = new Set(DEFAULT_ADJECTIVES.map(a => `${a}-x`));
  const name = generateTeammateName(existingNames, config);
  assert(name.match(/-x-\d+$/), `Numbered fallback: "${name}"`);
}

// Test 8: Completions suggest story dirs and favorites
console.log("\nTest 8: Autocomplete suggestions");
{
  const favorites = ["~/MyProject"];
  const options = getSpawnOptions(favorites);
  assert(options.length >= 2, `Has options: ${options.length}`);
  const dirs = options.map(o => o.dir);
  assert(dirs.includes("~/Workspace/my-app"), "Story dir in options");
  assert(dirs.includes("~/MyProject"), "Favorite in options");
}

// --- Cleanup ---
db.close();
fs.rmSync(tmpDir, { recursive: true });

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
if (failed > 0) process.exit(1);
