/**
 * contrast.ts — WCAG 2.x contrast ratios for the theme's CSS colors
 * (docs/ACCESSIBILITY.md "Contrast").
 *
 * The palette in index.css is written in `oklch(...)` (the default palette) and
 * `#rrggbb` (Solarized). This module parses those two forms, converts them to
 * sRGB, and computes the WCAG relative-luminance contrast ratio, so a unit test
 * (tests/contrast-ui.test.ts) can hold the theme's text, icon and focus-ring
 * colors to 4.5:1 / 3:1 in both light and dark — a check the axe scan, which
 * only sees colors that happen to be on screen, can't make for every pairing.
 *
 * `themeVariables` pulls a palette's custom properties out of the stylesheet's
 * text, so the test reads the real index.css rather than a copy of it.
 */

/** An sRGB color, each channel 0–1, with alpha 0–1. */
export interface Rgba { r: number; g: number; b: number; a: number }

/** Parse `#rgb`, `#rrggbb`, or `oklch(L C H [/ A])` (L as 0–1 or a percentage). Null otherwise. */
export function parseColor(text: string): Rgba | null {
  const s = text.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (hex) {
    const digits = hex[1]!;
    const h = digits.length === 3 ? digits.split("").map((c) => c + c).join("") : digits;
    return { r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255, a: 1 };
  }
  const ok = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)(%?))?\s*\)$/.exec(s);
  if (!ok) return null;
  const l = Number(ok[1]!) / (ok[2] ? 100 : 1);
  const alpha = ok[5] === undefined ? 1 : Number(ok[5]) / (ok[6] ? 100 : 1);
  return { ...oklchToSrgb(l, Number(ok[3]), Number(ok[4])), a: alpha };
}

/** OKLCH → gamma-encoded sRGB (clamped to the gamut), via OKLab and linear sRGB. */
function oklchToSrgb(l: number, c: number, hDeg: number): { r: number; g: number; b: number } {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  const gamma = (v: number) => {
    const x = Math.min(1, Math.max(0, v));
    return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  };
  return { r: gamma(lin[0]!), g: gamma(lin[1]!), b: gamma(lin[2]!) };
}

/** A translucent color painted over an opaque one (what the eye — and axe — sees). */
export function composite(top: Rgba, bottom: Rgba): Rgba {
  const mix = (t: number, u: number) => t * top.a + u * (1 - top.a);
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

/** WCAG relative luminance of an opaque sRGB color. */
export function relativeLuminance({ r, g, b }: Rgba): number {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * The WCAG contrast ratio (1–21) of `fg` over `bg`. A translucent `fg` is
 * composited over `bg` first; `bg` must be opaque (composite it yourself).
 */
export function contrastRatio(fg: Rgba, bg: Rgba): number {
  const f = relativeLuminance(fg.a < 1 ? composite(fg, bg) : fg);
  const k = relativeLuminance(bg);
  const [hi, lo] = f > k ? [f, k] : [k, f];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The custom properties (`--name: value;`) declared directly in the first
 * rule whose selector is exactly `selector` (e.g. `:root`, `.dark`,
 * `html[data-theme="solarized"]`), keyed without the leading `--`.
 */
export function themeVariables(css: string, selector: string): Record<string, string> {
  const vars: Record<string, string> = {};
  // Comments could hold braces or `--x:` text; drop them first.
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(clean); m; m = re.exec(clean)) {
    if (m[1]!.trim() !== selector) continue;
    for (const decl of m[2]!.split(";")) {
      const d = /^\s*--([\w-]+)\s*:\s*(.+?)\s*$/.exec(decl);
      if (d) vars[d[1]!] = d[2]!;
    }
    return vars;
  }
  return vars;
}
