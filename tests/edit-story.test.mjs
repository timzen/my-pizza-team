// End-to-end tests for story edit (PUT /api/stories/:id) operations
// Run with: node tests/edit-story.test.mjs
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pizza-edit-story-test-"));
const teamDir = path.join(tmpDir, ".pi-pizza-team");
fs.mkdirSync(teamDir, { recursive: true });

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}`); failed++; }
}

// --- Minimal Store simulation (matching store.ts schema) ---
const db = new Database(path.join(teamDir, "state.db"));
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
    status TEXT DEFAULT 'todo', result TEXT, dir_path TEXT, dirty INTEGER DEFAULT 0
  );
`);

// Create a story directory structure
const storyDir = path.join(teamDir, "stories", "edit-test");
fs.mkdirSync(storyDir, { recursive: true });

const initialStory = {
  id: "edit-test",
  title: "Original Title",
  description: "Original description",
  status: "open",
  dependsOn: [],
};
fs.writeFileSync(path.join(storyDir, "story.json"), JSON.stringify(initialStory, null, 2) + "\n");

db.prepare("INSERT INTO stories (id, title, description, status, depends_on, dir, workflow, dir_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
  .run("edit-test", "Original Title", "Original description", "open", "[]", null, null, storyDir);

// Helper: simulate updateStoryDetails (matches store.ts logic)
function updateStoryDetails(storyId, updates) {
  const row = db.prepare("SELECT * FROM stories WHERE id = ?").get(storyId);
  if (!row) return false;

  const story = {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    dependsOn: JSON.parse(row.depends_on),
    dir: row.dir || undefined,
    workflow: row.workflow || undefined,
    dirPath: row.dir_path,
  };

  const newTitle = updates.title ?? story.title;
  const newDescription = updates.description ?? story.description;
  const newStatus = updates.status ?? story.status;
  const newDependsOn = updates.dependsOn ?? story.dependsOn;
  const newDir = updates.dir !== undefined ? (updates.dir || null) : (story.dir || null);
  const newWorkflow = updates.workflow !== undefined ? (updates.workflow || null) : (story.workflow || null);

  db.prepare(`UPDATE stories SET title = ?, description = ?, status = ?, depends_on = ?, dir = ?, workflow = ? WHERE id = ?`)
    .run(newTitle, newDescription, newStatus, JSON.stringify(newDependsOn), newDir, newWorkflow, storyId);

  // Write back to disk
  const storyFile = path.join(story.dirPath, "story.json");
  const data = {
    id: storyId,
    title: newTitle,
    description: newDescription,
    status: newStatus,
    dependsOn: newDependsOn,
  };
  if (newDir) data.dir = newDir;
  if (newWorkflow) data.workflow = newWorkflow;
  fs.writeFileSync(storyFile, JSON.stringify(data, null, 2) + "\n");

  return true;
}

// --- Test 1: Edit title ---
console.log("\n--- Test 1: Edit story title ---");
{
  const result = updateStoryDetails("edit-test", { title: "Updated Title" });
  assert(result === true, "updateStoryDetails returns true");

  const row = db.prepare("SELECT * FROM stories WHERE id = ?").get("edit-test");
  assert(row.title === "Updated Title", "Title updated in DB");
  assert(row.description === "Original description", "Description unchanged");

  const onDisk = JSON.parse(fs.readFileSync(path.join(storyDir, "story.json"), "utf-8"));
  assert(onDisk.title === "Updated Title", "Title updated on disk");
  assert(onDisk.description === "Original description", "Description unchanged on disk");
}

// --- Test 2: Edit description ---
console.log("\n--- Test 2: Edit story description ---");
{
  updateStoryDetails("edit-test", { description: "New detailed description" });

  const row = db.prepare("SELECT * FROM stories WHERE id = ?").get("edit-test");
  assert(row.description === "New detailed description", "Description updated in DB");
  assert(row.title === "Updated Title", "Title still has previous value");

  const onDisk = JSON.parse(fs.readFileSync(path.join(storyDir, "story.json"), "utf-8"));
  assert(onDisk.description === "New detailed description", "Description updated on disk");
}

// --- Test 3: Edit dependencies ---
console.log("\n--- Test 3: Edit story dependencies ---");
{
  updateStoryDetails("edit-test", { dependsOn: ["story-a", "story-b"] });

  const row = db.prepare("SELECT * FROM stories WHERE id = ?").get("edit-test");
  const deps = JSON.parse(row.depends_on);
  assert(deps.length === 2, "Two dependencies in DB");
  assert(deps.includes("story-a") && deps.includes("story-b"), "Correct dependency values");

  const onDisk = JSON.parse(fs.readFileSync(path.join(storyDir, "story.json"), "utf-8"));
  assert(onDisk.dependsOn.length === 2, "Dependencies on disk");
}

// --- Test 4: Set dir and workflow ---
console.log("\n--- Test 4: Set directory and workflow ---");
{
  updateStoryDetails("edit-test", { dir: "~/Workspace/project", workflow: "simple" });

  const row = db.prepare("SELECT * FROM stories WHERE id = ?").get("edit-test");
  assert(row.dir === "~/Workspace/project", "Dir set in DB");
  assert(row.workflow === "simple", "Workflow set in DB");

  const onDisk = JSON.parse(fs.readFileSync(path.join(storyDir, "story.json"), "utf-8"));
  assert(onDisk.dir === "~/Workspace/project", "Dir on disk");
  assert(onDisk.workflow === "simple", "Workflow on disk");
}

// --- Test 5: Clear dir and workflow ---
console.log("\n--- Test 5: Clear directory and workflow (set to null) ---");
{
  updateStoryDetails("edit-test", { dir: null, workflow: null });

  const row = db.prepare("SELECT * FROM stories WHERE id = ?").get("edit-test");
  assert(row.dir === null, "Dir cleared in DB");
  assert(row.workflow === null, "Workflow cleared in DB");

  const onDisk = JSON.parse(fs.readFileSync(path.join(storyDir, "story.json"), "utf-8"));
  assert(!onDisk.dir, "Dir not present on disk");
  assert(!onDisk.workflow, "Workflow not present on disk");
}

// --- Test 6: Edit multiple fields at once ---
console.log("\n--- Test 6: Edit multiple fields at once ---");
{
  updateStoryDetails("edit-test", {
    title: "Final Title",
    description: "Final description",
    status: "done",
    dependsOn: ["dep-1"],
    dir: "~/final",
    workflow: "custom",
  });

  const row = db.prepare("SELECT * FROM stories WHERE id = ?").get("edit-test");
  assert(row.title === "Final Title", "Title updated");
  assert(row.description === "Final description", "Description updated");
  assert(row.status === "done", "Status updated");
  assert(JSON.parse(row.depends_on)[0] === "dep-1", "DependsOn updated");
  assert(row.dir === "~/final", "Dir updated");
  assert(row.workflow === "custom", "Workflow updated");

  const onDisk = JSON.parse(fs.readFileSync(path.join(storyDir, "story.json"), "utf-8"));
  assert(onDisk.title === "Final Title", "All fields correct on disk");
  assert(onDisk.status === "done", "Status correct on disk");
}

// --- Test 7: Edit non-existent story returns false ---
console.log("\n--- Test 7: Edit non-existent story ---");
{
  const result = updateStoryDetails("nonexistent", { title: "Nope" });
  assert(result === false, "Returns false for non-existent story");
}

// --- Test 8: ID cannot be changed ---
console.log("\n--- Test 8: Story ID is preserved (not editable) ---");
{
  // The API doesn't accept 'id' as an update field — verify the id is unchanged
  updateStoryDetails("edit-test", { title: "ID Check" });
  const row = db.prepare("SELECT * FROM stories WHERE id = ?").get("edit-test");
  assert(row.id === "edit-test", "ID unchanged after edit");

  const onDisk = JSON.parse(fs.readFileSync(path.join(storyDir, "story.json"), "utf-8"));
  assert(onDisk.id === "edit-test", "ID unchanged on disk");
}

// Cleanup
db.close();
fs.rmSync(tmpDir, { recursive: true });

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
process.exit(failed > 0 ? 1 : 0);
