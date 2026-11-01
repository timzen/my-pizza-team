/**
 * FavoriteDirectories — Config → General's **Favorite Directories** card
 * (docs/DESIGN.md "Favorite Directories"). Saves immediately through
 * /api/directories/favorites, not with the page's Save button.
 */

import { useState, useEffect } from "react";
import { useApi, apiPost, apiDelete } from "@/hooks/useApi";
import { DirectoryInput } from "@/components/ui/directory-input";
import { FAVORITES_CHANGED_EVENT, notifyFavoritesChanged } from "@/lib/directories";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, X, Star } from "lucide-react";

/**
 * The team's favorite directories, offered first by every directory picker.
 * Edits apply immediately through `/api/directories/favorites` rather than
 * riding the page's Save button, so a star clicked in some picker meanwhile is
 * never overwritten by this page's stale draft.
 */
export function FavoriteDirectories() {
  const { data, refetch } = useApi<{ favorites: string[] }>("/api/directories");
  const favorites = data?.favorites ?? [];
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Stars clicked in the picker below change the list too.
  useEffect(() => {
    const handler = () => { refetch(); };
    globalThis.addEventListener(FAVORITES_CHANGED_EVENT, handler);
    return () => globalThis.removeEventListener(FAVORITES_CHANGED_EVENT, handler);
  }, [refetch]);

  const add = async () => {
    if (!draft.trim()) return;
    const res = await apiPost<{ success: boolean; error?: string }>("/api/directories/favorites", { directory: draft.trim() });
    if (res.success) { setDraft(""); setError(null); notifyFavoritesChanged(); } else setError(res.error || "Could not add");
  };
  const remove = async (dir: string) => {
    await apiDelete(`/api/directories/favorites?directory=${encodeURIComponent(dir)}`);
    notifyFavoritesChanged();
  };

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <h2 className="font-semibold flex items-center gap-2"><Star className="h-4 w-4" /> Favorite Directories</h2>
        <p className="text-xs text-muted-foreground">
          Listed first in every directory picker (new story, task, template, Spawn…), ahead of recently
          used directories. You can also star a directory right in a picker. Paths are stored resolved
          (<code>~</code> expanded, symlinks followed). Changes save immediately.
        </p>
        {favorites.length === 0 && <p className="text-xs text-muted-foreground italic">No favorites yet.</p>}
        <ul className="space-y-1">
          {favorites.map((d) => (
            <li key={d} className="flex items-center justify-between gap-2 text-sm font-mono">
              <span className="truncate">{d}</span>
              <button onClick={() => remove(d)} className="text-muted-foreground hover:text-destructive" aria-label={`Remove ${d}`}>
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
        <div className="flex gap-2 items-start">
          <div className="flex-1" onKeyDown={(e) => e.key === "Enter" && add()}>
            <DirectoryInput id="favorite-directory" value={draft} onChange={setDraft} placeholder="Add a directory..." />
          </div>
          <Button variant="outline" size="sm" onClick={add}><Plus className="h-3.5 w-3.5" /></Button>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
