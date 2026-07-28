/**
 * theme.ts — Client-side palette preference (the `data-theme` attribute on
 * <html>). Orthogonal to light/dark mode (the `dark` class, owned by
 * ThemeToggle). Palettes are CSS variable blocks in index.css; adding one
 * there plus an entry in PALETTES here is all it takes to offer it.
 *
 * Applied at startup by main.tsx and changed from the Config page's Theme
 * tab. Persisted to localStorage.
 */

export const PALETTE_KEY = "mpt.palette";

/** Available palettes: value is the html[data-theme] attribute ("" = default). */
export const PALETTES = [
  { value: "", label: "Default" },
  { value: "solarized", label: "Solarized" },
];

/** Read the persisted palette (unknown values fall back to default). */
export function getStoredPalette(): string {
  const stored = localStorage.getItem(PALETTE_KEY);
  return PALETTES.some(p => p.value === stored) ? stored! : "";
}

/** Apply a palette to <html> and persist it. */
export function applyPalette(palette: string): void {
  if (palette) document.documentElement.dataset.theme = palette;
  else delete document.documentElement.dataset.theme;
  localStorage.setItem(PALETTE_KEY, palette);
}
