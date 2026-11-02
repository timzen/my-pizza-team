/**
 * tests/contrast-ui.test.ts — The theme's colors meet WCAG 2.2 AA contrast in
 * light and dark (docs/ACCESSIBILITY.md "Contrast"): text 4.5:1 on every
 * surface it sits on in the default palette, and the focus ring 3:1 against
 * every surface in every palette. (Solarized keeps Ethan Schoonover's colors,
 * whose secondary text is below 4.5:1 by design — a documented gap in
 * docs/ACCESSIBILITY.md; its ring is tuned like the default's.) Reads the real ui/src/index.css (ui/src/lib/contrast.ts parses it),
 * so a palette edit that drops a pairing below the line fails here — the axe
 * scan only sees the colors a fixture page happens to show, in light only.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertEquals } from "./_assert.ts";
import { composite, contrastRatio, parseColor, themeVariables, type Rgba } from "../ui/src/lib/contrast.ts";

const CSS = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ui", "src", "index.css"), "utf8");

/** The palettes: the default pair, and Solarized's (which inherit nothing from :root but the radius). */
const THEMES: Array<{ name: string; selector: string; base?: string }> = [
  { name: "default light", selector: ":root" },
  { name: "default dark", selector: ".dark", base: ":root" },
  { name: "solarized light", selector: 'html[data-theme="solarized"]', base: ":root" },
  { name: "solarized dark", selector: 'html.dark[data-theme="solarized"]', base: ":root" },
];

/** A theme's resolved colors by variable name (its block over its base). */
function palette(t: (typeof THEMES)[number]): (name: string) => Rgba {
  const vars = { ...(t.base ? themeVariables(CSS, t.base) : {}), ...themeVariables(CSS, t.selector) };
  return (name) => {
    const c = vars[name] ? parseColor(vars[name]!) : null;
    if (!c) throw new Error(`${t.name}: --${name} is missing or unparseable (${vars[name]})`);
    return c;
  };
}

/** Every pairing below `min`, as "fg on bg: ratio". */
function failures(color: (n: string) => Rgba, pairs: Array<[string, string]>, min: number): string[] {
  return pairs
    .map(([fg, bg]) => ({ fg, bg, ratio: contrastRatio(color(fg), color(bg)) }))
    .filter((p) => p.ratio < min)
    .map((p) => `--${p.fg} on --${p.bg}: ${p.ratio.toFixed(2)}`);
}

const SURFACES = ["background", "card", "popover", "muted", "secondary", "accent"];

test("contrast helpers: parse, composite, ratio", () => {
  assertEquals(contrastRatio(parseColor("#000")!, parseColor("#ffffff")!).toFixed(1), "21.0");
  assertEquals(contrastRatio(parseColor("oklch(1 0 0)")!, parseColor("oklch(1 0 0)")!), 1);
  assertEquals(parseColor("oklch(0.5 0 0 / 10%)")!.a, 0.1);
  assertEquals(parseColor("rgb(0 0 0)"), null);
  const half = composite({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 1, g: 1, b: 1, a: 1 });
  assertEquals(half.r, 0.5);
  assertEquals(themeVariables(":root { --a: #fff; /* { --b: x } */ }\n.dark { --a: #000; }", ".dark"), { a: "#000" });
});

test("the focus ring is 3:1 against every surface, in every palette", () => {
  for (const t of THEMES) {
    assertEquals(failures(palette(t), SURFACES.map((s) => ["ring", s]), 3), [], t.name);
  }
});

test("default palette: body text is 4.5:1 on every surface, light and dark", () => {
  for (const t of THEMES.slice(0, 2)) {
    assertEquals(failures(palette(t), SURFACES.map((s) => ["foreground", s]), 4.5), [], t.name);
  }
});

test("default palette: muted text, buttons and destructive text are 4.5:1, light and dark", () => {
  for (const t of THEMES.slice(0, 2)) {
    const color = palette(t);
    assertEquals(failures(color, [
      ...SURFACES.map((s): [string, string] => ["muted-foreground", s]),
      ["primary-foreground", "primary"],
      ["secondary-foreground", "secondary"],
      ["accent-foreground", "accent"],
      ["destructive", "background"],
      ["destructive", "card"],
    ], 4.5), [], t.name);
    // The destructive button/badge: its text on its own tint, resting and hovered
    // (light: /10 → /20; dark: /20 → /30 — ui/src/components/ui/button.tsx).
    const d = color("destructive");
    for (const a of t.selector === ".dark" ? [0.2, 0.3] : [0.1, 0.2]) {
      const tint = composite({ ...d, a }, color("background"));
      const ratio = contrastRatio(d, tint);
      assertEquals(ratio >= 4.5, true, `${t.name}: destructive on its ${a * 100}% tint is ${ratio.toFixed(2)}`);
    }
  }
});
