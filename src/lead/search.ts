// BM25 search index for memories
//
// Provides keyword-based search over notes, organized by category.
// Each category maintains its own index for targeted retrieval.
// The index is rebuilt from note files on startup and updated when notes change.
//
// BM25 parameters:
//   k1 = 1.5 (term frequency saturation)
//   b = 0.75 (document length normalization)

/** A single document in the index */
interface IndexedDoc {
  id: string;
  title: string;
  tokens: string[];
  length: number;
}

/** BM25 search result */
export interface SearchResult {
  id: string;
  title: string;
  score: number;
  snippet: string;
}

/** Tokenize text into searchable terms */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/** A single-category BM25 index */
class CategoryIndex {
  private docs: IndexedDoc[] = [];
  private df: Map<string, number> = new Map(); // document frequency per term
  private avgDl = 0; // average document length
  private k1 = 1.5;
  private b = 0.75;

  /** Clear and rebuild from a set of documents */
  rebuild(documents: Array<{ id: string; title: string; content: string }>): void {
    this.docs = [];
    this.df = new Map();

    for (const doc of documents) {
      const tokens = tokenize(doc.title + " " + doc.title + " " + doc.content); // title weighted 2x
      this.docs.push({ id: doc.id, title: doc.title, tokens, length: tokens.length });

      // Count unique terms per doc for DF
      const seen = new Set<string>();
      for (const token of tokens) {
        if (!seen.has(token)) {
          seen.add(token);
          this.df.set(token, (this.df.get(token) || 0) + 1);
        }
      }
    }

    // Calculate average document length
    this.avgDl = this.docs.length > 0
      ? this.docs.reduce((sum, d) => sum + d.length, 0) / this.docs.length
      : 0;
  }

  /** Search for query, return ranked results */
  search(query: string, limit = 5): SearchResult[] {
    if (this.docs.length === 0) return [];

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const N = this.docs.length;
    const scores: Array<{ doc: IndexedDoc; score: number }> = [];

    for (const doc of this.docs) {
      let score = 0;

      // Build term frequency map for this doc
      const tf = new Map<string, number>();
      for (const token of doc.tokens) {
        tf.set(token, (tf.get(token) || 0) + 1);
      }

      for (const term of queryTokens) {
        const termFreq = tf.get(term) || 0;
        if (termFreq === 0) continue;

        const docFreq = this.df.get(term) || 0;
        // IDF with smoothing
        const idf = Math.log((N - docFreq + 0.5) / (docFreq + 0.5) + 1);
        // BM25 term score
        const tfNorm = (termFreq * (this.k1 + 1)) /
          (termFreq + this.k1 * (1 - this.b + this.b * (doc.length / this.avgDl)));
        score += idf * tfNorm;
      }

      if (score > 0) {
        scores.push({ doc, score });
      }
    }

    // Sort by score descending and limit
    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, limit).map(({ doc, score }) => ({
      id: doc.id,
      title: doc.title,
      score: Math.round(score * 1000) / 1000,
      snippet: doc.tokens.slice(0, 30).join(" ") + "...",
    }));
  }

  get size(): number {
    return this.docs.length;
  }
}

/** Memory item with parsed frontmatter */
export interface ParsedNote {
  id: string;
  title: string;
  content: string;
  categories: string[];
  rawContent: string; // full file content including frontmatter
}

/** Parse frontmatter from a memory's content */
export function parseFrontmatter(raw: string): { categories: string[]; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { categories: [], body: raw };

  const frontmatter = match[1];
  const body = match[2];

  // Parse categories line
  const catMatch = frontmatter.match(/categories:\s*\[([^\]]*)\]/);
  if (!catMatch) return { categories: [], body };

  const categories = catMatch[1]
    .split(",")
    .map((c) => c.trim().replace(/['"]/g, ""))
    .filter(Boolean);

  return { categories, body };
}

/** Serialize frontmatter into a memory file */
export function serializeFrontmatter(categories: string[], body: string): string {
  if (categories.length === 0) return body;
  return `---\ncategories: [${categories.join(", ")}]\n---\n${body}`;
}

/**
 * Multi-category BM25 search engine for memories.
 * Maintains one index per category + an "all" index for global search.
 */
export class NotesSearchEngine {
  private categoryIndexes: Map<string, CategoryIndex> = new Map();
  private allIndex: CategoryIndex = new CategoryIndex();
  private notes: Map<string, ParsedNote> = new Map();

  /** Rebuild all indexes from a list of parsed memories */
  rebuild(notes: ParsedNote[]): void {
    this.notes.clear();
    this.categoryIndexes.clear();

    // Group notes by category
    const byCat: Map<string, Array<{ id: string; title: string; content: string }>> = new Map();
    const allDocs: Array<{ id: string; title: string; content: string }> = [];

    for (const note of notes) {
      this.notes.set(note.id, note);
      const doc = { id: note.id, title: note.title, content: note.content };
      allDocs.push(doc);

      for (const cat of note.categories) {
        if (!byCat.has(cat)) byCat.set(cat, []);
        byCat.get(cat)!.push(doc);
      }

      // Notes without categories go into "all" only
    }

    // Build per-category indexes
    for (const [cat, docs] of byCat) {
      const idx = new CategoryIndex();
      idx.rebuild(docs);
      this.categoryIndexes.set(cat, idx);
    }

    // Build global index
    this.allIndex.rebuild(allDocs);
  }

  /** Search within a specific category (or all if no category specified) */
  search(query: string, category?: string, limit = 5): SearchResult[] {
    if (category) {
      const idx = this.categoryIndexes.get(category);
      if (!idx) return [];
      return idx.search(query, limit);
    }
    return this.allIndex.search(query, limit);
  }

  /** Get a memory by ID */
  getNote(id: string): ParsedNote | undefined {
    return this.notes.get(id);
  }

  /** Get available categories with counts */
  getCategories(): Array<{ name: string; count: number }> {
    const result: Array<{ name: string; count: number }> = [];
    for (const [name, idx] of this.categoryIndexes) {
      result.push({ name, count: idx.size });
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  get totalNotes(): number {
    return this.notes.size;
  }
}
