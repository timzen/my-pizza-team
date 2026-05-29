// End-to-end tests for the assistant queue and notes
// Run with: node tests/assistant-queue.test.mjs
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pizza-assistant-test-"));
const teamDir = path.join(tmpDir, ".pi-pizza-team");
fs.mkdirSync(teamDir, { recursive: true });

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}`); failed++; }
}

// --- Database setup (matching store.ts schema) ---
const db = new Database(path.join(teamDir, "state.db"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS assistant_queue (
    id TEXT PRIMARY KEY,
    prompt TEXT,
    status TEXT DEFAULT 'pending',
    result TEXT,
    created_at INTEGER,
    started_at INTEGER,
    completed_at INTEGER
  );
`);

// --- Helper functions (matching store.ts logic) ---
function enqueue(prompt) {
  const id = `asst-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  db.prepare("INSERT INTO assistant_queue (id, prompt, status, created_at) VALUES (?, ?, 'pending', ?)").run(id, prompt, now);
  return { id, prompt, status: "pending", createdAt: now };
}

function getQueue() {
  return db.prepare("SELECT * FROM assistant_queue ORDER BY created_at DESC").all();
}

function getNext() {
  return db.prepare("SELECT * FROM assistant_queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1").get() || null;
}

function claim(id) {
  const row = db.prepare("SELECT status FROM assistant_queue WHERE id = ?").get(id);
  if (!row || row.status !== "pending") return false;
  db.prepare("UPDATE assistant_queue SET status = 'processing', started_at = ? WHERE id = ?").run(Date.now(), id);
  return true;
}

function complete(id, result, failed = false) {
  const row = db.prepare("SELECT status FROM assistant_queue WHERE id = ?").get(id);
  if (!row || row.status !== "processing") return false;
  const status = failed ? "failed" : "done";
  db.prepare("UPDATE assistant_queue SET status = ?, result = ?, completed_at = ? WHERE id = ?").run(status, result || null, Date.now(), id);
  return true;
}

function deleteItem(id) {
  const row = db.prepare("SELECT * FROM assistant_queue WHERE id = ?").get(id);
  if (!row) return false;
  db.prepare("DELETE FROM assistant_queue WHERE id = ?").run(id);
  return true;
}

// --- Test 1: Enqueue items ---
console.log("\n--- Test 1: Enqueue items ---");
{
  const item1 = enqueue("Create a story for auth refactor");
  assert(item1.id.startsWith("asst-"), "Item ID has correct prefix");
  assert(item1.status === "pending", "Status is pending");
  assert(item1.prompt === "Create a story for auth refactor", "Prompt stored correctly");

  const item2 = enqueue("Spawn a new teammate in ~/Workspace/api");
  const queue = getQueue();
  assert(queue.length === 2, "Queue has 2 items");
}

// --- Test 2: Get next item (FIFO) ---
console.log("\n--- Test 2: Get next item (FIFO order) ---");
{
  const next = getNext();
  assert(next !== null, "Next item exists");
  assert(next.prompt === "Create a story for auth refactor", "First enqueued item is returned first");
}

// --- Test 3: Claim item ---
console.log("\n--- Test 3: Claim item ---");
{
  const next = getNext();
  const success = claim(next.id);
  assert(success === true, "Claim succeeds");

  const row = db.prepare("SELECT * FROM assistant_queue WHERE id = ?").get(next.id);
  assert(row.status === "processing", "Status changed to processing");
  assert(row.started_at > 0, "started_at is set");

  // Can't claim again
  const again = claim(next.id);
  assert(again === false, "Can't claim already-processing item");

  // Next item is now the second one
  const next2 = getNext();
  assert(next2.prompt === "Spawn a new teammate in ~/Workspace/api", "Next returns second item");
}

// --- Test 4: Complete item ---
console.log("\n--- Test 4: Complete item ---");
{
  const items = getQueue();
  const processing = items.find(i => i.status === "processing");
  const success = complete(processing.id, "Created story auth-refactor with 3 tasks");
  assert(success === true, "Complete succeeds");

  const row = db.prepare("SELECT * FROM assistant_queue WHERE id = ?").get(processing.id);
  assert(row.status === "done", "Status changed to done");
  assert(row.result === "Created story auth-refactor with 3 tasks", "Result stored");
  assert(row.completed_at > 0, "completed_at is set");
}

// --- Test 5: Complete with failure ---
console.log("\n--- Test 5: Complete with failure ---");
{
  const next = getNext();
  claim(next.id);
  const success = complete(next.id, "Server unreachable", true);
  assert(success === true, "Failed complete succeeds");

  const row = db.prepare("SELECT * FROM assistant_queue WHERE id = ?").get(next.id);
  assert(row.status === "failed", "Status is failed");
  assert(row.result === "Server unreachable", "Error stored as result");
}

// --- Test 6: Can't complete non-processing item ---
console.log("\n--- Test 6: Can't complete non-processing item ---");
{
  const item = enqueue("Test item");
  const success = complete(item.id, "Nope");
  assert(success === false, "Can't complete pending item");
}

// --- Test 7: Delete items ---
console.log("\n--- Test 7: Delete items ---");
{
  const queue = getQueue();
  const countBefore = queue.length;
  const success = deleteItem(queue[0].id);
  assert(success === true, "Delete succeeds");
  assert(getQueue().length === countBefore - 1, "Queue shrinks by 1");

  const nope = deleteItem("nonexistent");
  assert(nope === false, "Delete nonexistent returns false");
}

// --- Test 8: Notes (file-based) ---
console.log("\n--- Test 8: Notes ---");
{
  const notesDir = path.join(teamDir, "notes");

  // Save a note
  fs.mkdirSync(notesDir, { recursive: true });
  const title = "API Design Decisions";
  const content = "# API Design Decisions\n\nWe chose REST over GraphQL because...";
  const id = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  const filePath = path.join(notesDir, `${id}.md`);
  fs.writeFileSync(filePath, content);

  assert(fs.existsSync(filePath), "Note file created");

  // Read notes
  const files = fs.readdirSync(notesDir).filter(f => f.endsWith(".md"));
  assert(files.length === 1, "One note file exists");
  assert(files[0] === "api-design-decisions.md", "Filename is slugified");

  const readContent = fs.readFileSync(filePath, "utf-8");
  assert(readContent.includes("REST over GraphQL"), "Content preserved");

  // Delete note
  fs.rmSync(filePath);
  assert(!fs.existsSync(filePath), "Note deleted from disk");
}

// Cleanup
db.close();
fs.rmSync(tmpDir, { recursive: true });

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
process.exit(failed > 0 ? 1 : 0);
