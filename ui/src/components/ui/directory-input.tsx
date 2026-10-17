/**
 * DirectoryInput — A text input with a dropdown of suggested working
 * directories. Allows typing a custom path or picking a suggestion. The
 * dropdown lists the team's **favorite** directories first, then recently used
 * ones (both from `GET /api/directories`), then any caller-supplied extras.
 * Each row has a star to add/remove it as a favorite, and the star next to the
 * input favorites whatever path is typed — so favorites can be managed right
 * where they're used, not only on the Config page. See docs/DESIGN.md
 * "Favorite Directories".
 */

import { useState, useRef, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { ChevronDown, Star } from "lucide-react";
import { useApi, apiPost, apiDelete } from "@/hooks/useApi";
import { orderDirectorySuggestions, notifyFavoritesChanged, FAVORITES_CHANGED_EVENT } from "@/lib/directories";

interface DirectoriesData {
  favorites: string[];
  recent: string[];
}

interface DirectoryInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  id?: string;
  /** Additional directories to include in the dropdown (after favorites and recent) */
  extraDirectories?: string[];
}

/** Add or remove a favorite; resolves to the daemon's updated list (or null on failure). */
async function toggleFavorite(dir: string, isFavorite: boolean): Promise<string[] | null> {
  const res = isFavorite
    ? await apiDelete<{ success: boolean; favorites?: string[] }>(`/api/directories/favorites?directory=${encodeURIComponent(dir)}`)
    : await apiPost<{ success: boolean; favorites?: string[] }>("/api/directories/favorites", { directory: dir });
  return res.success ? res.favorites ?? [] : null;
}

export function DirectoryInput({ value, onChange, placeholder, id, extraDirectories }: DirectoryInputProps) {
  const { data, refetch } = useApi<DirectoriesData>("/api/directories");
  const favorites = data?.favorites ?? [];
  const recent = data?.recent ?? [];
  const extras = extraDirectories ?? [];
  const hasAny = favorites.length + recent.length + extras.length > 0;
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Stay in sync with stars clicked in other pickers / the Config page.
  useEffect(() => {
    const handler = () => { refetch(); };
    globalThis.addEventListener(FAVORITES_CHANGED_EVENT, handler);
    return () => globalThis.removeEventListener(FAVORITES_CHANGED_EVENT, handler);
  }, [refetch]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // A selected suggestion matches exactly, so show the full list rather than
  // filtering down to that one entry.
  const exact = favorites.includes(value) || recent.includes(value) || extras.includes(value);
  const suggestions = orderDirectorySuggestions(favorites, recent, extras, exact ? "" : value);
  const firstNonFavorite = suggestions.findIndex((s) => !s.favorite);
  // The daemon normalizes paths, so a typed `~/x` may already be favorited as
  // `/home/u/x`; the input's star only reflects an exact match.
  const typed = value.trim();
  const typedIsFavorite = favorites.includes(typed);

  const onStar = async (dir: string, isFavorite: boolean) => {
    if (await toggleFavorite(dir, isFavorite)) notifyFavoritesChanged();
  };

  return (
    <div ref={wrapperRef} className="relative">
      <div className="relative">
        <Input
          id={id}
          value={value}
          onChange={e => { onChange(e.target.value); setOpen(true); }}
          onFocus={() => { if (hasAny) setOpen(true); }}
          placeholder={placeholder || "~/projects/foo"}
          className="pr-14"
        />
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
          {typed && (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              title={typedIsFavorite ? "Remove from favorite directories" : "Add to favorite directories"}
              aria-label={typedIsFavorite ? "Remove from favorite directories" : "Add to favorite directories"}
              onClick={() => onStar(typed, typedIsFavorite)}
              tabIndex={-1}
            >
              <Star className={`h-4 w-4 ${typedIsFavorite ? "fill-yellow-400 text-yellow-500" : ""}`} />
            </button>
          )}
          {hasAny && (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => setOpen(!open)}
              tabIndex={-1}
              aria-label="Show suggested directories"
            >
              <ChevronDown className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
      {open && suggestions.length > 0 && (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-md max-h-72 overflow-y-auto">
          {suggestions.map(({ dir, favorite }, i) => (
            <div key={dir}>
              {i === 0 && favorite && <SectionLabel>Favorites</SectionLabel>}
              {i === firstNonFavorite && <SectionLabel>Recent</SectionLabel>}
              <div className="flex items-center hover:bg-accent hover:text-accent-foreground">
                <button
                  type="button"
                  className="flex-1 min-w-0 px-3 py-2 text-left text-sm truncate"
                  onClick={() => { onChange(dir); setOpen(false); }}
                >
                  {dir}
                </button>
                <button
                  type="button"
                  className="px-2 text-muted-foreground hover:text-foreground"
                  title={favorite ? "Remove from favorites" : "Add to favorites"}
                  aria-label={favorite ? `Remove ${dir} from favorites` : `Add ${dir} to favorites`}
                  onClick={() => onStar(dir, favorite)}
                >
                  <Star className={`h-3.5 w-3.5 ${favorite ? "fill-yellow-400 text-yellow-500" : ""}`} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A small heading row between dropdown groups. */
function SectionLabel({ children }: { children: string }) {
  return <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground">{children}</div>;
}
