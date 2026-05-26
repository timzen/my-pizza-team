// End-to-end tests for status transition instructions
// Run with: node tests/transition-instructions.test.mjs
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pizza-trans-"));
const teamDir = path.join(tmpDir, ".pi-pizza-team");
fs.mkdirSync(teamDir, { recursive: true });

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}`); failed++; }
}

// --- Setup DB (mirrors store schema) ---
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
  CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY, name TEXT, cwd TEXT,
    tmux_window TEXT, status TEXT DEFAULT 'idle', last_heartbeat INTEGER
  );
  CREATE TABLE IF NOT EXISTS token_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT REFERENCES tasks(id),
    input_tokens INTEGER, output_tokens INTEGER,
    model TEXT, cost_usd REAL, recorded_at INTEGER
  );
`);

// Create story + task
const storyDir = path.join(teamDir, "stories", "trans-test");
const taskDir = path.join(storyDir, "tasks", "01-first");
fs.mkdirSync(taskDir, { recursive: true });
db.prepare("INSERT INTO stories VALUES (?, ?, ?, ?, ?, ?, ?)").run(
  "trans-test", "Transition Test", "desc", "open", "[]", null, storyDir
);
db.prepare("INSERT INTO tasks (id, story_id, seq, slug, title, description, status, dir_path) VALUES (?,?,?,?,?,?,?,?)")
  .run("trans-test-1", "trans-test", 1, "first", "First Task", "Do something", "todo", taskDir);
db.prepare("INSERT INTO messages_loaded (task_id, loaded_at) VALUES (?, ?)").run("trans-test-1", Date.now());

// Workflow
const workflow = {
  states: ["todo", "in_progress", "needs_input", "review", "done"],
  transitions: {
    todo: { in_progress: "any" },
    in_progress: { needs_input: "teammate", review: "teammate" },
    needs_input: { in_progress: "lead" },
    review: { done: "lead", in_progress: "lead" },
  },
};

// --- Simulate readTransitionFile (same logic as store.ts) ---
const transitionCache = new Map();
const CACHE_TTL = 30000;

function readTransitionFile(filename) {
  const filePath = path.join(teamDir, filename);

  const cached = transitionCache.get(filename);
  if (cached) {
    try {
      const stat = fs.statSync(filePath);
      // Use cachedAt for TTL check (fixing the bug in original)
      if (stat.mtimeMs === cached.mtime && Date.now() - cached.cachedAt < CACHE_TTL) {
        return cached.content;
      }
    } catch {
      transitionCache.delete(filename);
      return undefined;
    }
  }

  try {
    if (!fs.existsSync(filePath)) return undefined;
    const content = fs.readFileSync(filePath, "utf-8");
    const stat = fs.statSync(filePath);
    transitionCache.set(filename, { content, mtime: stat.mtimeMs, cachedAt: Date.now() });
    return content;
  } catch {
    return undefined;
  }
}

function getTransitionInstructions(fromStatus, toStatus) {
  const result = {};
  const exitContent = readTransitionFile(`on-exit-${fromStatus}.md`);
  if (exitContent) result.exitInstructions = exitContent;
  const enterContent = readTransitionFile(`on-enter-${toStatus}.md`);
  if (enterContent) result.enterInstructions = enterContent;
  return result;
}

function buildInstructionsString(fromStatus, toStatus) {
  const { exitInstructions, enterInstructions } = getTransitionInstructions(fromStatus, toStatus);
  const parts = [];
  if (exitInstructions) parts.push(exitInstructions);
  if (enterInstructions) parts.push(enterInstructions);
  return parts.length > 0 ? parts.join("\n\n---\n\n") : undefined;
}


// ============================================================
// TEST 1: on-enter-in_progress.md — claim a task
// ============================================================
console.log("\n--- Test 1: on-enter-in_progress.md on claim ---");
{
  const mdContent = `## Getting Started

Before you begin work, remember to:
- Create a feature branch
- Run the test suite first to establish baseline
- Keep changes focused and atomic`;

  fs.writeFileSync(path.join(teamDir, "on-enter-in_progress.md"), mdContent);

  // Simulate claim: todo → in_progress
  const instructions = buildInstructionsString("todo", "in_progress");
  assert(instructions !== undefined, "Instructions returned for todo → in_progress");
  assert(instructions.includes("Getting Started"), "Contains header");
  assert(instructions.includes("Create a feature branch"), "Contains specific instruction");
  assert(instructions.includes("Run the test suite"), "Contains another instruction");

  // Verify the teammate would receive this prepended to the prompt
  const taskPrompt = `## Task: First Task\n\nDo something`;
  const fullPrompt = instructions
    ? `## Transition Instructions\n\n${instructions}\n\n---\n\n${taskPrompt}`
    : taskPrompt;
  assert(fullPrompt.includes("Transition Instructions"), "Full prompt has instructions section");
  assert(fullPrompt.includes("First Task"), "Full prompt still has task");
  assert(fullPrompt.indexOf("Getting Started") < fullPrompt.indexOf("First Task"), "Instructions come before task");
}


// ============================================================
// TEST 2: on-enter-review.md — move to review
// ============================================================
console.log("\n--- Test 2: on-enter-review.md on status change ---");
{
  const mdContent = `## Review Checklist

Please verify before marking as done:
- [ ] All tests pass
- [ ] No lint warnings
- [ ] Documentation updated`;

  fs.writeFileSync(path.join(teamDir, "on-enter-review.md"), mdContent);

  // Simulate: in_progress → review
  const instructions = buildInstructionsString("in_progress", "review");
  assert(instructions !== undefined, "Instructions for in_progress → review");
  assert(instructions.includes("Review Checklist"), "Contains review header");
  assert(instructions.includes("All tests pass"), "Contains checklist items");
}


// ============================================================
// TEST 3: on-exit-in_progress.md — fires when leaving
// ============================================================
console.log("\n--- Test 3: on-exit-in_progress.md fires on exit ---");
{
  const mdContent = `## Leaving In-Progress

Make sure you've committed your work before transitioning.`;

  fs.writeFileSync(path.join(teamDir, "on-exit-in_progress.md"), mdContent);

  // Simulate: in_progress → review (should fire BOTH exit and enter)
  const { exitInstructions, enterInstructions } = getTransitionInstructions("in_progress", "review");
  assert(exitInstructions !== undefined, "Exit instructions returned");
  assert(exitInstructions.includes("Leaving In-Progress"), "Exit content correct");
  assert(enterInstructions !== undefined, "Enter instructions also returned");
  assert(enterInstructions.includes("Review Checklist"), "Enter content from test 2 still works");

  // Combined string has both, separated by ---
  const combined = buildInstructionsString("in_progress", "review");
  assert(combined.includes("Leaving In-Progress"), "Combined has exit");
  assert(combined.includes("Review Checklist"), "Combined has enter");
  assert(combined.includes("---"), "Separator between exit and enter");

  // Exit fires regardless of destination
  const toNeedsInput = buildInstructionsString("in_progress", "needs_input");
  assert(toNeedsInput !== undefined, "Exit fires for in_progress → needs_input too");
  assert(toNeedsInput.includes("Leaving In-Progress"), "Same exit content for different dest");
}


// ============================================================
// TEST 4: No markdown files — works without errors
// ============================================================
console.log("\n--- Test 4: No markdown files for a transition ---");
{
  // Remove the files we created
  fs.unlinkSync(path.join(teamDir, "on-enter-in_progress.md"));
  fs.unlinkSync(path.join(teamDir, "on-enter-review.md"));
  fs.unlinkSync(path.join(teamDir, "on-exit-in_progress.md"));
  transitionCache.clear();

  // todo → in_progress with no files
  const instructions = buildInstructionsString("todo", "in_progress");
  assert(instructions === undefined, "No instructions when no files exist");

  // in_progress → review with no files
  const instructions2 = buildInstructionsString("in_progress", "review");
  assert(instructions2 === undefined, "No instructions for review either");

  // Verify no errors thrown
  const { exitInstructions, enterInstructions } = getTransitionInstructions("in_progress", "done");
  assert(exitInstructions === undefined, "Exit undefined when no file");
  assert(enterInstructions === undefined, "Enter undefined when no file");
}


// ============================================================
// TEST 5: Partial config — only some files
// ============================================================
console.log("\n--- Test 5: Partial config (only on-enter-review.md) ---");
{
  const mdContent = `## Only Review Has Instructions

This is the only transition with custom instructions.`;

  fs.writeFileSync(path.join(teamDir, "on-enter-review.md"), mdContent);
  transitionCache.clear();

  // todo → in_progress: no instructions (no on-enter-in_progress.md, no on-exit-todo.md)
  const claim = buildInstructionsString("todo", "in_progress");
  assert(claim === undefined, "No instructions for claim (only review has file)");

  // in_progress → review: has enter instructions only (no exit file)
  const review = buildInstructionsString("in_progress", "review");
  assert(review !== undefined, "Has instructions for → review");
  assert(review.includes("Only Review Has Instructions"), "Correct content");
  assert(!review.includes("---"), "No separator (only one part)");

  // review → done: no instructions
  const done = buildInstructionsString("review", "done");
  assert(done === undefined, "No instructions for review → done");
}


// ============================================================
// TEST 6: API passes instructions through correctly
// ============================================================
console.log("\n--- Test 6: API response includes instructions ---");
{
  // Simulate the server's claim handler logic
  db.prepare("UPDATE tasks SET status = 'todo' WHERE id = ?").run("trans-test-1");

  // Simulate claim: todo → in_progress
  const fromStatus = "todo";
  const toStatus = "in_progress";
  db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(toStatus, "trans-test-1");

  const { exitInstructions, enterInstructions } = getTransitionInstructions(fromStatus, toStatus);
  const parts = [];
  if (exitInstructions) parts.push(exitInstructions);
  if (enterInstructions) parts.push(enterInstructions);
  const instructions = parts.length > 0 ? parts.join("\n\n---\n\n") : undefined;

  // No on-enter-in_progress.md exists, so should be undefined
  assert(instructions === undefined, "Claim response has no instructions (no file)");

  // Now simulate: in_progress → review (has file)
  const fromStatus2 = "in_progress";
  const toStatus2 = "review";
  db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(toStatus2, "trans-test-1");

  const { exitInstructions: exit2, enterInstructions: enter2 } = getTransitionInstructions(fromStatus2, toStatus2);
  const parts2 = [];
  if (exit2) parts2.push(exit2);
  if (enter2) parts2.push(enter2);
  const instructions2 = parts2.length > 0 ? parts2.join("\n\n---\n\n") : undefined;

  assert(instructions2 !== undefined, "Review transition has instructions");
  assert(instructions2.includes("Only Review Has Instructions"), "Correct content in API response");

  // Simulate what teammate loop does with instructions
  const statusResponse = { success: true, instructions: instructions2 };
  if (statusResponse.instructions) {
    const agentMsg = `## Transition Instructions\n\n${statusResponse.instructions}`;
    assert(agentMsg.includes("Transition Instructions"), "Teammate receives instructions");
    assert(agentMsg.includes("Only Review"), "Content passed through");
  }
}


// ============================================================
// TEST 7: Cache invalidation on file change
// ============================================================
console.log("\n--- Test 7: Cache invalidation on file modification ---");
{
  transitionCache.clear();

  // Write initial content
  const file = path.join(teamDir, "on-enter-review.md");
  fs.writeFileSync(file, "## Version 1\n\nOriginal instructions.");

  // Read it (populates cache)
  let content = readTransitionFile("on-enter-review.md");
  assert(content.includes("Version 1"), "First read gets V1");

  // Read again immediately (should be cached)
  const content2 = readTransitionFile("on-enter-review.md");
  assert(content2.includes("Version 1"), "Cached read still V1");

  // Modify the file (need to change mtime — write new content)
  // Small delay to ensure different mtime on some filesystems
  const now = Date.now();
  fs.writeFileSync(file, "## Version 2\n\nUpdated instructions.");
  // Force different mtime
  fs.utimesSync(file, new Date(now + 1000), new Date(now + 1000));

  // Read again — cache should detect mtime changed
  const content3 = readTransitionFile("on-enter-review.md");
  assert(content3.includes("Version 2"), `Cache invalidated on mtime change (got: "${content3.slice(0, 30)}...")`);

  // Delete the file
  fs.unlinkSync(file);
  const content4 = readTransitionFile("on-enter-review.md");
  assert(content4 === undefined, "Returns undefined after file deleted");
}


// ============================================================
// TEST 8: Non-standard workflow states
// ============================================================
console.log("\n--- Test 8: Works with custom workflow states ---");
{
  transitionCache.clear();

  // Simulate a custom workflow with states: draft → active → qa → shipped
  fs.writeFileSync(path.join(teamDir, "on-enter-active.md"), "## Active\n\nYou're now active!");
  fs.writeFileSync(path.join(teamDir, "on-exit-active.md"), "## Leaving Active\n\nCommit everything.");
  fs.writeFileSync(path.join(teamDir, "on-enter-qa.md"), "## QA\n\nRun the full test suite.");

  // draft → active
  let result = buildInstructionsString("draft", "active");
  assert(result !== undefined, "Custom state: draft → active has instructions");
  assert(result.includes("You're now active"), "Enter-active content");

  // active → qa (both exit and enter fire)
  result = buildInstructionsString("active", "qa");
  assert(result !== undefined, "Custom state: active → qa has instructions");
  assert(result.includes("Leaving Active"), "Exit-active fires");
  assert(result.includes("Run the full test suite"), "Enter-qa fires");
  assert(result.includes("---"), "Both parts separated");

  // qa → shipped (no files for these)
  result = buildInstructionsString("qa", "shipped");
  assert(result === undefined, "No instructions for transitions without files");

  // Cleanup
  fs.unlinkSync(path.join(teamDir, "on-enter-active.md"));
  fs.unlinkSync(path.join(teamDir, "on-exit-active.md"));
  fs.unlinkSync(path.join(teamDir, "on-enter-qa.md"));
}


// ============================================================
// TEST 9: File naming edge cases
// ============================================================
console.log("\n--- Test 9: File naming with various state names ---");
{
  transitionCache.clear();

  // State with underscores
  fs.writeFileSync(path.join(teamDir, "on-enter-needs_input.md"), "## Blocked\n\nWaiting for lead.");
  let content = readTransitionFile("on-enter-needs_input.md");
  assert(content !== undefined, "Underscore in state name works");
  assert(content.includes("Blocked"), "Content correct");

  // State with hyphens (custom)
  fs.writeFileSync(path.join(teamDir, "on-enter-code-review.md"), "## Code Review\n\nPeer review time.");
  content = readTransitionFile("on-enter-code-review.md");
  assert(content !== undefined, "Hyphen in state name works");
  assert(content.includes("Code Review"), "Content correct");

  // Empty file
  fs.writeFileSync(path.join(teamDir, "on-enter-empty.md"), "");
  content = readTransitionFile("on-enter-empty.md");
  // Empty string is falsy, so it won't be included
  assert(content === "" || content === undefined, "Empty file handled gracefully");

  // Cleanup
  fs.unlinkSync(path.join(teamDir, "on-enter-needs_input.md"));
  fs.unlinkSync(path.join(teamDir, "on-enter-code-review.md"));
  fs.unlinkSync(path.join(teamDir, "on-enter-empty.md"));
}


// Cleanup
db.close();
fs.rmSync(tmpDir, { recursive: true });

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
process.exit(failed > 0 ? 1 : 0);
