/**
 * DirectoryInput — A text input with a dropdown of favorite directories.
 * Allows typing a custom path or selecting from saved favorites.
 * Fetches favorite directories from /api/config.
 */

import { useState, useRef, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { ChevronDown } from "lucide-react";
import { useApi } from "@/hooks/useApi";

interface ConfigData {
  teammates?: { favoriteDirectories?: string[] };
}

interface DirectoryInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  id?: string;
  /** Additional directories to include in the dropdown (merged with favorites) */
  extraDirectories?: string[];
}

export function DirectoryInput({ value, onChange, placeholder, id, extraDirectories }: DirectoryInputProps) {
  const { data: config } = useApi<ConfigData>("/api/config");
  const favorites = config?.teammates?.favoriteDirectories || [];
  // Merge favorites and extras, deduplicate
  const allDirs = [...new Set([...favorites, ...(extraDirectories || [])])];
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

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

  // Filter directories based on current input
  const filtered = value
    ? allDirs.filter(d => d.toLowerCase().includes(value.toLowerCase()))
    : allDirs;

  return (
    <div ref={wrapperRef} className="relative">
      <div className="relative">
        <Input
          id={id}
          value={value}
          onChange={e => { onChange(e.target.value); setOpen(true); }}
          onFocus={() => { if (allDirs.length > 0) setOpen(true); }}
          placeholder={placeholder || "~/projects/foo"}
          className="pr-8"
        />
        {allDirs.length > 0 && (
          <button
            type="button"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            onClick={() => setOpen(!open)}
            tabIndex={-1}
          >
            <ChevronDown className="h-4 w-4" />
          </button>
        )}
      </div>
      {open && filtered.length > 0 && (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-md">
          {filtered.map(dir => (
            <button
              key={dir}
              type="button"
              className="w-full px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground truncate"
              onClick={() => { onChange(dir); setOpen(false); }}
            >
              {dir}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
