/**
 * tests/search.test.ts — Verifies the BM25 search engine for memory notes.
 */

import { assertEquals } from "@std/assert";
import { NotesSearchEngine, type ParsedNote } from "../shared/search.ts";

const SAMPLE_NOTES: ParsedNote[] = [
  { id: "git-workflow", title: "Git Workflow", content: "Always commit with descriptive messages. Use feature branches.", categories: ["coding"], rawContent: "" },
  { id: "api-design", title: "API Design Patterns", content: "RESTful APIs should use proper HTTP methods. Use JSON responses.", categories: ["coding", "research"], rawContent: "" },
  { id: "project-setup", title: "Project Setup Guide", content: "Initialize with deno.json. Configure import maps for dependencies.", categories: ["coding"], rawContent: "" },
  { id: "meeting-notes", title: "Team Meeting Notes", content: "Discussed sprint planning and backlog prioritization.", categories: ["doc-writing"], rawContent: "" },
  { id: "research-llm", title: "LLM Cost Analysis", content: "Claude Sonnet costs $3 per million input tokens. GPT-4o costs $2.50.", categories: ["research"], rawContent: "" },
];

Deno.test("Search: returns relevant results for a query", () => {
  const engine = new NotesSearchEngine();
  engine.rebuild(SAMPLE_NOTES);

  const results = engine.search("git commit branches");
  assertEquals(results.length > 0, true);
  assertEquals(results[0]!.id, "git-workflow");
});

Deno.test("Search: category filter restricts results", () => {
  const engine = new NotesSearchEngine();
  engine.rebuild(SAMPLE_NOTES);

  const codingResults = engine.search("API design", "coding");
  assertEquals(codingResults.length > 0, true);
  assertEquals(codingResults[0]!.id, "api-design");

  // "meeting-notes" is in doc-writing, not coding
  const meetingInCoding = codingResults.find(r => r.id === "meeting-notes");
  assertEquals(meetingInCoding, undefined);
});

Deno.test("Search: returns empty for unknown category", () => {
  const engine = new NotesSearchEngine();
  engine.rebuild(SAMPLE_NOTES);

  const results = engine.search("git", "nonexistent-category");
  assertEquals(results.length, 0);
});

Deno.test("Search: returns empty for empty query", () => {
  const engine = new NotesSearchEngine();
  engine.rebuild(SAMPLE_NOTES);

  const results = engine.search("");
  assertEquals(results.length, 0);
});

Deno.test("Search: getCategories returns all indexed categories", () => {
  const engine = new NotesSearchEngine();
  engine.rebuild(SAMPLE_NOTES);

  const cats = engine.getCategories();
  assertEquals(cats.length, 3);
  assertEquals(cats.map(c => c.name).sort(), ["coding", "doc-writing", "research"]);
});

Deno.test("Search: totalNotes reflects indexed count", () => {
  const engine = new NotesSearchEngine();
  engine.rebuild(SAMPLE_NOTES);
  assertEquals(engine.totalNotes, 5);
});

Deno.test("Search: getNote retrieves by ID", () => {
  const engine = new NotesSearchEngine();
  engine.rebuild(SAMPLE_NOTES);

  const note = engine.getNote("research-llm");
  assertEquals(note?.title, "LLM Cost Analysis");
  assertEquals(note?.categories, ["research"]);
});

Deno.test("Search: scores are ordered by relevance", () => {
  const engine = new NotesSearchEngine();
  engine.rebuild(SAMPLE_NOTES);

  const results = engine.search("deno import dependencies project");
  assertEquals(results.length > 0, true);
  // project-setup should rank highest for this query
  assertEquals(results[0]!.id, "project-setup");
  // Scores should be descending
  for (let i = 1; i < results.length; i++) {
    assertEquals(results[i]!.score <= results[i - 1]!.score, true);
  }
});
