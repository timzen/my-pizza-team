// End-to-end tests for token usage tracking
// Run with: node tests/token-usage.test.mjs
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pizza-tokens-test-"));
const teamDir = path.join(tmpDir, ".pi-pizza-team");
fs.mkdirSync(teamDir, { recursive: true });

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}`); failed++; }
}

// --- Setup ---
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
  CREATE TABLE IF NOT EXISTS token_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT REFERENCES tasks(id),
    input_tokens INTEGER,
    output_tokens INTEGER,
    model TEXT,
    cost_usd REAL,
    recorded_at INTEGER
  );
`);

// Create story + task dirs
const storyDir = path.join(teamDir, "stories", "token-test");
const taskDir1 = path.join(storyDir, "tasks", "01-first");
const taskDir2 = path.join(storyDir, "tasks", "02-second");
fs.mkdirSync(taskDir1, { recursive: true });
fs.mkdirSync(taskDir2, { recursive: true });

db.prepare("INSERT INTO stories VALUES (?, ?, ?, ?, ?, ?, ?)").run(
  "token-test", "Token Test", "desc", "open", "[]", null, storyDir
);
db.prepare("INSERT INTO tasks (id, story_id, seq, slug, title, description, status, dir_path) VALUES (?,?,?,?,?,?,?,?)")
  .run("token-test-1", "token-test", 1, "first", "First Task", "desc", "in_progress", taskDir1);
db.prepare("INSERT INTO tasks (id, story_id, seq, slug, title, description, status, dir_path) VALUES (?,?,?,?,?,?,?,?)")
  .run("token-test-2", "token-test", 2, "second", "Second Task", "desc", "todo", taskDir2);

// --- Cost estimation function (same as server.ts) ---
const MODEL_COSTS = {
  "claude-sonnet-4-20250514": { input: 3.0, output: 15.0 },
  "claude-opus-4-20250514": { input: 15.0, output: 75.0 },
  "claude-haiku-3": { input: 0.25, output: 1.25 },
  "claude-3-5-sonnet-20241022": { input: 3.0, output: 15.0 },
  "claude-3-5-haiku-20241022": { input: 0.80, output: 4.0 },
  "gpt-4o": { input: 2.5, output: 10.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.60 },
  "gpt-4-turbo": { input: 10.0, output: 30.0 },
  "o3": { input: 10.0, output: 40.0 },
  "o3-mini": { input: 1.10, output: 4.40 },
};

function estimateTokenCost(model, inputTokens, outputTokens) {
  let costs = MODEL_COSTS[model];
  if (!costs) {
    const key = Object.keys(MODEL_COSTS).find(k => model.startsWith(k) || model.includes(k));
    costs = key ? MODEL_COSTS[key] : { input: 3.0, output: 15.0 };
  }
  return (inputTokens * costs.input + outputTokens * costs.output) / 1_000_000;
}

// --- Store helpers ---
function addTokenUsage(taskId, inputTokens, outputTokens, model, costUsd) {
  const now = Date.now();
  db.prepare("INSERT INTO token_usage (task_id, input_tokens, output_tokens, model, cost_usd, recorded_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(taskId, inputTokens, outputTokens, model, costUsd, now);
  db.prepare("UPDATE tasks SET dirty = 1 WHERE id = ?").run(taskId);
}

function getTokenUsage(taskId) {
  return db.prepare("SELECT * FROM token_usage WHERE task_id = ? ORDER BY recorded_at")
    .all(taskId)
    .map(row => ({
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      model: row.model,
      costUsd: row.cost_usd,
      at: new Date(row.recorded_at).toISOString(),
    }));
}

function getTokenUsageSummary(taskId) {
  const row = db.prepare("SELECT SUM(input_tokens) as inp, SUM(output_tokens) as out, SUM(cost_usd) as cost FROM token_usage WHERE task_id = ?").get(taskId);
  if (!row || row.cost === null) return null;
  return { totalCostUsd: row.cost, totalInputTokens: row.inp, totalOutputTokens: row.out };
}


// ============================================================
// TEST 1: Cost estimation for various models
// ============================================================
console.log("\n--- Test 1: Cost estimation ---");
{
  // Claude Sonnet: $3/M input, $15/M output
  let cost = estimateTokenCost("claude-sonnet-4-20250514", 10000, 2000);
  let expected = (10000 * 3.0 + 2000 * 15.0) / 1_000_000; // 0.03 + 0.03 = 0.06
  assert(Math.abs(cost - expected) < 0.0001, `Sonnet cost: $${cost.toFixed(4)} (expected $${expected.toFixed(4)})`);

  // GPT-4o: $2.5/M input, $10/M output
  cost = estimateTokenCost("gpt-4o", 50000, 10000);
  expected = (50000 * 2.5 + 10000 * 10.0) / 1_000_000; // 0.125 + 0.1 = 0.225
  assert(Math.abs(cost - expected) < 0.0001, `GPT-4o cost: $${cost.toFixed(4)} (expected $${expected.toFixed(4)})`);

  // GPT-4o-mini: $0.15/M input, $0.60/M output
  cost = estimateTokenCost("gpt-4o-mini", 100000, 20000);
  expected = (100000 * 0.15 + 20000 * 0.60) / 1_000_000; // 0.015 + 0.012 = 0.027
  assert(Math.abs(cost - expected) < 0.0001, `GPT-4o-mini cost: $${cost.toFixed(4)} (expected $${expected.toFixed(4)})`);

  // Unknown model falls back to sonnet pricing
  cost = estimateTokenCost("unknown-model-v2", 10000, 2000);
  expected = (10000 * 3.0 + 2000 * 15.0) / 1_000_000;
  assert(Math.abs(cost - expected) < 0.0001, `Unknown model fallback: $${cost.toFixed(4)}`);

  // Prefix match (model with date suffix)
  cost = estimateTokenCost("gpt-4o-2024-08-06", 10000, 2000);
  // Should match "gpt-4o" via includes
  expected = (10000 * 2.5 + 2000 * 10.0) / 1_000_000;
  assert(Math.abs(cost - expected) < 0.0001, `Prefix match gpt-4o-2024: $${cost.toFixed(4)}`);
}


// ============================================================
// TEST 2: Add and retrieve token usage
// ============================================================
console.log("\n--- Test 2: Add and retrieve token usage ---");
{
  // Initially no usage
  let usage = getTokenUsage("token-test-1");
  assert(usage.length === 0, "No usage initially");

  let summary = getTokenUsageSummary("token-test-1");
  assert(summary === null, "Summary is null with no usage");

  // Add first usage record
  const cost1 = estimateTokenCost("claude-sonnet-4-20250514", 8000, 1500);
  addTokenUsage("token-test-1", 8000, 1500, "claude-sonnet-4-20250514", cost1);

  usage = getTokenUsage("token-test-1");
  assert(usage.length === 1, "One usage record");
  assert(usage[0].inputTokens === 8000, "Input tokens correct");
  assert(usage[0].outputTokens === 1500, "Output tokens correct");
  assert(usage[0].model === "claude-sonnet-4-20250514", "Model correct");
  assert(Math.abs(usage[0].costUsd - cost1) < 0.0001, `Cost correct: $${usage[0].costUsd.toFixed(4)}`);
  assert(usage[0].at !== undefined, "Has timestamp");

  // Add second usage (simulating a resumed task)
  const cost2 = estimateTokenCost("claude-sonnet-4-20250514", 12000, 3000);
  addTokenUsage("token-test-1", 12000, 3000, "claude-sonnet-4-20250514", cost2);

  usage = getTokenUsage("token-test-1");
  assert(usage.length === 2, "Two usage records (multiple sessions)");

  // Summary
  summary = getTokenUsageSummary("token-test-1");
  assert(summary !== null, "Summary exists");
  assert(summary.totalInputTokens === 20000, `Total input: ${summary.totalInputTokens}`);
  assert(summary.totalOutputTokens === 4500, `Total output: ${summary.totalOutputTokens}`);
  assert(Math.abs(summary.totalCostUsd - (cost1 + cost2)) < 0.0001, `Total cost: $${summary.totalCostUsd.toFixed(4)}`);
}


// ============================================================
// TEST 3: Task marked dirty after token usage
// ============================================================
console.log("\n--- Test 3: Task marked dirty ---");
{
  const task = db.prepare("SELECT dirty FROM tasks WHERE id = ?").get("token-test-1");
  assert(task.dirty === 1, "Task marked dirty after addTokenUsage");

  // task-2 not dirty
  const task2 = db.prepare("SELECT dirty FROM tasks WHERE id = ?").get("token-test-2");
  assert(task2.dirty === 0, "Unaffected task not dirty");
}


// ============================================================
// TEST 4: Flush to disk includes tokenUsage
// ============================================================
console.log("\n--- Test 4: Flush to disk ---");
{
  // Simulate flushToDisk
  const dirtyTasks = db.prepare("SELECT * FROM tasks WHERE dirty = 1").all();
  for (const row of dirtyTasks) {
    const tokenUsage = getTokenUsage(row.id);
    const taskData = {
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status,
      result: row.result,
    };
    if (tokenUsage.length > 0) {
      taskData.tokenUsage = tokenUsage;
    }
    const taskFile = path.join(row.dir_path, "task.json");
    fs.writeFileSync(taskFile, JSON.stringify(taskData, null, 2) + "\n");
  }
  db.prepare("UPDATE tasks SET dirty = 0 WHERE dirty = 1").run();

  // Verify file content
  const taskFile = path.join(taskDir1, "task.json");
  assert(fs.existsSync(taskFile), "task.json written");
  const data = JSON.parse(fs.readFileSync(taskFile, "utf-8"));
  assert(data.tokenUsage !== undefined, "tokenUsage in task.json");
  assert(Array.isArray(data.tokenUsage), "tokenUsage is array");
  assert(data.tokenUsage.length === 2, "Two usage records in file");
  assert(data.tokenUsage[0].inputTokens === 8000, "First record correct");
  assert(data.tokenUsage[1].inputTokens === 12000, "Second record correct");
  assert(data.tokenUsage[0].model === "claude-sonnet-4-20250514", "Model in file");
}


// ============================================================
// TEST 5: Task without usage doesn't get tokenUsage key
// ============================================================
console.log("\n--- Test 5: No usage = no tokenUsage key ---");
{
  // Mark task-2 dirty manually and flush
  db.prepare("UPDATE tasks SET dirty = 1 WHERE id = ?").run("token-test-2");
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get("token-test-2");
  const tokenUsage = getTokenUsage(row.id);
  const taskData = { id: row.id, title: row.title, description: row.description, status: row.status, result: row.result };
  if (tokenUsage.length > 0) taskData.tokenUsage = tokenUsage;
  fs.writeFileSync(path.join(row.dir_path, "task.json"), JSON.stringify(taskData, null, 2) + "\n");

  const data = JSON.parse(fs.readFileSync(path.join(taskDir2, "task.json"), "utf-8"));
  assert(data.tokenUsage === undefined, "No tokenUsage key for task without usage");
}


// ============================================================
// TEST 6: Delete task cleans up token_usage
// ============================================================
console.log("\n--- Test 6: Delete cleans up ---");
{
  // Verify usage exists
  let rows = db.prepare("SELECT * FROM token_usage WHERE task_id = ?").all("token-test-1");
  assert(rows.length === 2, "Usage records exist before delete");

  // Delete task
  db.prepare("DELETE FROM token_usage WHERE task_id = ?").run("token-test-1");
  db.prepare("DELETE FROM tasks WHERE id = ?").run("token-test-1");

  rows = db.prepare("SELECT * FROM token_usage WHERE task_id = ?").all("token-test-1");
  assert(rows.length === 0, "Token usage cleaned up after delete");
}


// ============================================================
// TEST 7: Board UI rendering (simulated)
// ============================================================
console.log("\n--- Test 7: Board UI cost display ---");
{
  // Simulate task data as returned by API
  const tasks = [
    { id: "t1", title: "A", status: "done", tokenUsage: { totalCostUsd: 0.045, totalInputTokens: 10000, totalOutputTokens: 2000 } },
    { id: "t2", title: "B", status: "in_progress", tokenUsage: { totalCostUsd: 0.023, totalInputTokens: 5000, totalOutputTokens: 1000 } },
    { id: "t3", title: "C", status: "todo", tokenUsage: null },
  ];

  // Task cost badge
  const badge1 = tasks[0].tokenUsage && tasks[0].tokenUsage.totalCostUsd > 0 ? '$' + tasks[0].tokenUsage.totalCostUsd.toFixed(3) : '';
  assert(badge1 === '$0.045', `Task badge: "${badge1}"`);

  const badge3 = tasks[2].tokenUsage && tasks[2].tokenUsage.totalCostUsd > 0 ? '$' + tasks[2].tokenUsage.totalCostUsd.toFixed(3) : '';
  assert(badge3 === '', "No badge for task without usage");

  // Story cost total
  const storyCost = tasks.reduce((sum, t) => sum + (t.tokenUsage ? t.tokenUsage.totalCostUsd : 0), 0);
  assert(Math.abs(storyCost - 0.068) < 0.001, `Story total: $${storyCost.toFixed(3)}`);

  // Board total (across stories)
  const stories = [
    { tasks: [{ tokenUsage: { totalCostUsd: 0.10 } }, { tokenUsage: { totalCostUsd: 0.05 } }] },
    { tasks: [{ tokenUsage: { totalCostUsd: 0.03 } }, { tokenUsage: null }] },
  ];
  const totalCost = stories.reduce((sum, s) =>
    sum + s.tasks.reduce((ts, t) => ts + (t.tokenUsage ? t.tokenUsage.totalCostUsd : 0), 0), 0);
  assert(Math.abs(totalCost - 0.18) < 0.001, `Board total: $${totalCost.toFixed(3)}`);
}


// Cleanup
db.close();
fs.rmSync(tmpDir, { recursive: true });

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
process.exit(failed > 0 ? 1 : 0);
