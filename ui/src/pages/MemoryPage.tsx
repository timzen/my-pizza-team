/**
 * MemoryPage — Knowledge base with category tabs and BM25 search.
 */

import { useState } from "react";
import { useApi, apiPost, apiDelete } from "@/hooks/useApi";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { MarkdownView } from "@/components/ui/markdown-view";
import { MarkdownField } from "@/components/ui/markdown-field";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Plus, Search, Trash2 } from "lucide-react";

interface Note {
  id: string;
  title: string;
  content: string;
  categories: string[];
  createdAt: string;
  updatedAt: string;
}

interface SearchResult {
  id: string;
  title: string;
  score: number;
  snippet: string;
}

export function MemoryPage() {
  const { data: notesData, refetch } = useApi<{ notes: Note[] }>("/api/assistant/notes");
  const { data: catData } = useApi<{ configured: string[]; indexed: Array<{ name: string; count: number }> }>("/api/assistant/categories");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newContent, setNewContent] = useState("");
  const [newCategories, setNewCategories] = useState("");

  const notes = notesData?.notes || [];
  const categories = catData?.indexed || [];

  const filteredNotes = activeCategory
    ? notes.filter(n => n.categories.includes(activeCategory))
    : notes;

  const handleSearch = async () => {
    if (!searchQuery.trim()) { setSearchResults(null); return; }
    const params = new URLSearchParams({ q: searchQuery, limit: "10" });
    if (activeCategory) params.set("category", activeCategory);
    const res = await fetch(`/api/assistant/notes/search?${params}`);
    const data = await res.json();
    setSearchResults(data.results);
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const cats = newCategories.split(",").map(c => c.trim()).filter(Boolean);
    await apiPost("/api/assistant/notes", { title: newTitle, content: newContent, categories: cats });
    setShowAdd(false); setNewTitle(""); setNewContent(""); setNewCategories("");
    refetch();
  };

  const handleDelete = async (id: string) => {
    if (!confirm(`Delete note "${id}"?`)) return;
    await apiDelete(`/api/assistant/notes/${id}`);
    refetch();
  };

  return (
    <div className="container mx-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Memory</h1>
        <Button size="sm" onClick={() => setShowAdd(true)}><Plus className="h-4 w-4 mr-1" />Add Note</Button>
      </div>

      {/* Category tabs */}
      <div className="flex gap-2 flex-wrap">
        <Button variant={activeCategory === null ? "default" : "outline"} size="sm" onClick={() => setActiveCategory(null)}>
          All ({notes.length})
        </Button>
        {categories.map(cat => (
          <Button key={cat.name} variant={activeCategory === cat.name ? "default" : "outline"} size="sm" onClick={() => setActiveCategory(cat.name)}>
            {cat.name} ({cat.count})
          </Button>
        ))}
      </div>

      {/* Search */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search notes..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") handleSearch(); }}
            className="pl-9"
          />
        </div>
        <Button onClick={handleSearch}>Search</Button>
      </div>

      {/* Search results */}
      {searchResults && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">{searchResults.length} results</p>
          {searchResults.map(r => (
            <Card key={r.id}>
              <CardContent className="p-3">
                <div className="flex items-center justify-between">
                  <p className="font-medium text-sm">{r.title}</p>
                  <Badge variant="outline" className="text-xs">score: {r.score}</Badge>
                </div>
                <p className="text-xs text-muted-foreground mt-1">{r.snippet}</p>
              </CardContent>
            </Card>
          ))}
          <Button variant="ghost" size="sm" onClick={() => setSearchResults(null)}>Clear results</Button>
        </div>
      )}

      {/* Notes list */}
      {!searchResults && (
        <div className="space-y-2">
          {filteredNotes.map(note => (
            <Card key={note.id}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium">{note.title}</p>
                    <div className="mt-1"><MarkdownView content={note.content} /></div>
                    <div className="flex gap-1 mt-2">
                      {note.categories.map(c => <Badge key={c} variant="secondary" className="text-xs">{c}</Badge>)}
                    </div>
                  </div>
                  <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => handleDelete(note.id)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
          {filteredNotes.length === 0 && <p className="text-center text-muted-foreground py-8">No notes yet.</p>}
        </div>
      )}

      {/* Add note dialog */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add Note</DialogTitle></DialogHeader>
          <form onSubmit={handleAdd} className="space-y-4">
            <div><Label>Title</Label><Input value={newTitle} onChange={e => setNewTitle(e.target.value)} required /></div>
            <MarkdownField label="Content" value={newContent} onChange={setNewContent} rows={5} required defaultEditing />
            <div><Label>Categories (comma-separated)</Label><Input value={newCategories} onChange={e => setNewCategories(e.target.value)} placeholder="coding, research" /></div>
            <Button type="submit" className="w-full">Save Note</Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
