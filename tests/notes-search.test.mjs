// Tests for the BM25 notes search engine
// Run with: node tests/notes-search.test.mjs

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}`); failed++; }
}

// --- Inline implementation of search.ts for testing ---

function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { categories: [], body: raw };
  const frontmatter = match[1];
  const body = match[2];
  const catMatch = frontmatter.match(/categories:\s*\[([^\]]*)\]/);
  if (!catMatch) return { categories: [], body };
  const categories = catMatch[1].split(",").map(c => c.trim().replace(/['"]/g, "")).filter(Boolean);
  return { categories, body };
}

function serializeFrontmatter(categories, body) {
  if (categories.length === 0) return body;
  return `---\ncategories: [${categories.join(", ")}]\n---\n${body}`;
}

function tokenize(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(t => t.length > 1);
}

class CategoryIndex {
  constructor() { this.docs = []; this.df = new Map(); this.avgDl = 0; this.k1 = 1.5; this.b = 0.75; }
  rebuild(documents) {
    this.docs = []; this.df = new Map();
    for (const doc of documents) {
      const tokens = tokenize(doc.title + " " + doc.title + " " + doc.content);
      this.docs.push({ id: doc.id, title: doc.title, tokens, length: tokens.length });
      const seen = new Set();
      for (const token of tokens) { if (!seen.has(token)) { seen.add(token); this.df.set(token, (this.df.get(token) || 0) + 1); } }
    }
    this.avgDl = this.docs.length > 0 ? this.docs.reduce((s, d) => s + d.length, 0) / this.docs.length : 0;
  }
  search(query, limit = 5) {
    if (this.docs.length === 0) return [];
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];
    const N = this.docs.length;
    const scores = [];
    for (const doc of this.docs) {
      let score = 0;
      const tf = new Map();
      for (const token of doc.tokens) tf.set(token, (tf.get(token) || 0) + 1);
      for (const term of queryTokens) {
        const termFreq = tf.get(term) || 0;
        if (termFreq === 0) continue;
        const docFreq = this.df.get(term) || 0;
        const idf = Math.log((N - docFreq + 0.5) / (docFreq + 0.5) + 1);
        const tfNorm = (termFreq * (this.k1 + 1)) / (termFreq + this.k1 * (1 - this.b + this.b * (doc.length / this.avgDl)));
        score += idf * tfNorm;
      }
      if (score > 0) scores.push({ doc, score });
    }
    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, limit).map(({ doc, score }) => ({ id: doc.id, title: doc.title, score: Math.round(score * 1000) / 1000, snippet: doc.tokens.slice(0, 30).join(" ") + "..." }));
  }
  get size() { return this.docs.length; }
}

class NotesSearchEngine {
  constructor() { this.categoryIndexes = new Map(); this.allIndex = new CategoryIndex(); this.notes = new Map(); }
  rebuild(notes) {
    this.notes.clear(); this.categoryIndexes.clear();
    const byCat = new Map(); const allDocs = [];
    for (const note of notes) {
      this.notes.set(note.id, note);
      const doc = { id: note.id, title: note.title, content: note.content };
      allDocs.push(doc);
      for (const cat of note.categories) { if (!byCat.has(cat)) byCat.set(cat, []); byCat.get(cat).push(doc); }
    }
    for (const [cat, docs] of byCat) { const idx = new CategoryIndex(); idx.rebuild(docs); this.categoryIndexes.set(cat, idx); }
    this.allIndex.rebuild(allDocs);
  }
  search(query, category, limit = 5) {
    if (category) { const idx = this.categoryIndexes.get(category); return idx ? idx.search(query, limit) : []; }
    return this.allIndex.search(query, limit);
  }
  getCategories() {
    const result = [];
    for (const [name, idx] of this.categoryIndexes) result.push({ name, count: idx.size });
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }
  get totalNotes() { return this.notes.size; }
}

// --- Test 1: Frontmatter parsing ---
console.log("\n--- Test 1: Frontmatter parsing ---");
{
  const raw = `---\ncategories: [coding, research]\n---\n# My Note\n\nSome content here.`;
  const { categories, body } = parseFrontmatter(raw);
  assert(categories.length === 2, "Parses 2 categories");
  assert(categories[0] === "coding", "First category is coding");
  assert(categories[1] === "research", "Second category is research");
  assert(body.startsWith("# My Note"), "Body starts with title");
  assert(!body.includes("---"), "Body doesn't include frontmatter markers");
}

// --- Test 2: Frontmatter with no categories ---
console.log("\n--- Test 2: No frontmatter ---");
{
  const raw = "# Plain Note\n\nJust content.";
  const { categories, body } = parseFrontmatter(raw);
  assert(categories.length === 0, "No categories for plain content");
  assert(body === raw, "Body is the full content");
}

// --- Test 3: Serialization ---
console.log("\n--- Test 3: Serialize frontmatter ---");
{
  const result = serializeFrontmatter(["coding", "docs"], "# Title\n\nContent");
  assert(result.startsWith("---\n"), "Starts with frontmatter");
  assert(result.includes("categories: [coding, docs]"), "Contains categories");
  assert(result.includes("# Title"), "Contains body");
}

// --- Test 4: Serialize empty categories ---
console.log("\n--- Test 4: Serialize no categories ---");
{
  const result = serializeFrontmatter([], "# Title\n\nContent");
  assert(!result.includes("---"), "No frontmatter when no categories");
  assert(result === "# Title\n\nContent", "Just the body");
}

// --- Test 5: Search engine basic ---
console.log("\n--- Test 5: Basic search ---");
{
  const engine = new NotesSearchEngine();
  engine.rebuild([
    { id: "auth", title: "Authentication Guide", content: "How to implement JWT authentication with middleware", categories: ["coding"], rawContent: "" },
    { id: "db", title: "Database Setup", content: "PostgreSQL configuration and connection pooling", categories: ["coding"], rawContent: "" },
    { id: "competitors", title: "Competitor Analysis", content: "Comparison of authentication providers and pricing", categories: ["research"], rawContent: "" },
  ]);

  const results = engine.search("authentication");
  assert(results.length >= 1, "Found results for 'authentication'");
  assert(results[0].id === "auth", "Top result is the auth guide");
}

// --- Test 6: Category-specific search ---
console.log("\n--- Test 6: Category-specific search ---");
{
  const engine = new NotesSearchEngine();
  engine.rebuild([
    { id: "auth", title: "Authentication Guide", content: "How to implement JWT authentication", categories: ["coding"], rawContent: "" },
    { id: "auth-research", title: "Auth Providers", content: "Comparing authentication services", categories: ["research"], rawContent: "" },
  ]);

  const codingResults = engine.search("authentication", "coding");
  assert(codingResults.length === 1, "One result in coding category");
  assert(codingResults[0].id === "auth", "Correct coding result");

  const researchResults = engine.search("authentication", "research");
  assert(researchResults.length === 1, "One result in research category");
  assert(researchResults[0].id === "auth-research", "Correct research result");

  const allResults = engine.search("authentication");
  assert(allResults.length === 2, "Both results when no category filter");
}

// --- Test 7: No results ---
console.log("\n--- Test 7: No results for unrelated query ---");
{
  const engine = new NotesSearchEngine();
  engine.rebuild([
    { id: "auth", title: "Auth", content: "JWT tokens", categories: ["coding"], rawContent: "" },
  ]);

  const results = engine.search("dinosaur");
  assert(results.length === 0, "No results for unrelated query");
}

// --- Test 8: Get categories with counts ---
console.log("\n--- Test 8: Category counts ---");
{
  const engine = new NotesSearchEngine();
  engine.rebuild([
    { id: "a", title: "A", content: "x", categories: ["coding"], rawContent: "" },
    { id: "b", title: "B", content: "y", categories: ["coding", "research"], rawContent: "" },
    { id: "c", title: "C", content: "z", categories: ["research"], rawContent: "" },
  ]);

  const cats = engine.getCategories();
  assert(cats.length === 2, "Two categories indexed");
  const coding = cats.find(c => c.name === "coding");
  const research = cats.find(c => c.name === "research");
  assert(coding && coding.count === 2, "Coding has 2 notes");
  assert(research && research.count === 2, "Research has 2 notes");
}

// --- Test 9: Multi-word query ---
console.log("\n--- Test 9: Multi-word query ---");
{
  const engine = new NotesSearchEngine();
  engine.rebuild([
    { id: "api", title: "API Design", content: "REST API design patterns with error handling middleware", categories: ["coding"], rawContent: "" },
    { id: "errors", title: "Error Handling", content: "Centralized error handling strategies for Node.js applications", categories: ["coding"], rawContent: "" },
    { id: "deploy", title: "Deployment", content: "Docker deployment and CI/CD pipeline setup", categories: ["coding"], rawContent: "" },
  ]);

  const results = engine.search("error handling");
  assert(results.length >= 2, "Found multiple results");
  assert(results[0].id === "errors", "Best match is the error handling note");
}

// --- Test 10: Roundtrip frontmatter ---
console.log("\n--- Test 10: Frontmatter roundtrip ---");
{
  const original = "# My Note\n\nContent here.";
  const withCats = serializeFrontmatter(["coding", "research"], original);
  const parsed = parseFrontmatter(withCats);
  assert(parsed.categories.length === 2, "Categories survive roundtrip");
  assert(parsed.categories[0] === "coding", "First cat preserved");
  assert(parsed.body.trim().startsWith("# My Note"), "Body preserved");
}

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
process.exit(failed > 0 ? 1 : 0);
