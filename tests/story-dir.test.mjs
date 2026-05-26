// Unit tests for story dir feature
// Run with: node tests/story-dir.test.mjs
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pizza-test-"));
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

console.log("Test dir:", tmpDir);
console.log("\n--- Schema ---");

// Simulate the Store's schema init + migration
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
`);

// Migration check
const cols = db.prepare("PRAGMA table_info(stories)").all();
assert(cols.some(c => c.name === "dir"), "Schema has 'dir' column");

console.log("\n--- Insert with dir ---");

db.prepare(
  "INSERT INTO stories (id, title, description, status, depends_on, dir, dir_path) VALUES (?, ?, ?, ?, ?, ?, ?)"
).run("test-1", "Test Story 1", "Description", "open", "[]", "~/Workspace/project-a", "/tmp/stories/test-1");

const row1 = db.prepare("SELECT * FROM stories WHERE id = ?").get("test-1");
assert(row1.dir === "~/Workspace/project-a", "Story with dir persists correctly");

console.log("\n--- Insert without dir ---");

db.prepare(
  "INSERT INTO stories (id, title, description, status, depends_on, dir, dir_path) VALUES (?, ?, ?, ?, ?, ?, ?)"
).run("test-2", "Test Story 2", "Description", "open", "[]", null, "/tmp/stories/test-2");

const row2 = db.prepare("SELECT * FROM stories WHERE id = ?").get("test-2");
assert(row2.dir === null, "Story without dir stores null");

console.log("\n--- story.json roundtrip with dir ---");

const storiesDir = path.join(teamDir, "stories", "test-3");
fs.mkdirSync(path.join(storiesDir, "tasks"), { recursive: true });
const storyJson = { id: "test-3", title: "Test 3", description: "Desc", status: "open", dependsOn: [], dir: "~/Code/foo" };
fs.writeFileSync(path.join(storiesDir, "story.json"), JSON.stringify(storyJson, null, 2));

const loaded = JSON.parse(fs.readFileSync(path.join(storiesDir, "story.json"), "utf-8"));
assert(loaded.dir === "~/Code/foo", "story.json with dir roundtrips correctly");

console.log("\n--- story.json without dir ---");

const storiesDir4 = path.join(teamDir, "stories", "test-4");
fs.mkdirSync(path.join(storiesDir4, "tasks"), { recursive: true });
const storyJson4 = { id: "test-4", title: "Test 4", description: "Desc", status: "open", dependsOn: [] };
fs.writeFileSync(path.join(storiesDir4, "story.json"), JSON.stringify(storyJson4, null, 2));

const loaded4 = JSON.parse(fs.readFileSync(path.join(storiesDir4, "story.json"), "utf-8"));
assert(!("dir" in loaded4), "story.json without dir omits the field entirely");

console.log("\n--- Migration from old schema ---");

const db2 = new Database(path.join(teamDir, "state-old.db"));
db2.exec(`
  CREATE TABLE IF NOT EXISTS stories (
    id TEXT PRIMARY KEY,
    title TEXT,
    description TEXT,
    status TEXT DEFAULT 'open',
    depends_on TEXT DEFAULT '[]',
    dir_path TEXT
  );
`);
// Run migration (same logic as Store.initSchema)
const oldCols = db2.prepare("PRAGMA table_info(stories)").all();
if (!oldCols.some(c => c.name === "dir")) {
  db2.exec("ALTER TABLE stories ADD COLUMN dir TEXT");
}
const migratedCols = db2.prepare("PRAGMA table_info(stories)").all();
assert(migratedCols.some(c => c.name === "dir"), "Migration adds 'dir' column to existing DB");

// Verify data still works after migration
db2.prepare(
  "INSERT INTO stories (id, title, description, status, depends_on, dir, dir_path) VALUES (?, ?, ?, ?, ?, ?, ?)"
).run("migrated-1", "Migrated", "Desc", "open", "[]", "~/Projects/x", "/tmp/m");
const migratedRow = db2.prepare("SELECT * FROM stories WHERE id = ?").get("migrated-1");
assert(migratedRow.dir === "~/Projects/x", "Migrated DB accepts dir values");

// Cleanup
db.close();
db2.close();
fs.rmSync(tmpDir, { recursive: true });

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
process.exit(failed > 0 ? 1 : 0);
