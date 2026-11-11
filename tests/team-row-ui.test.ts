/**
 * tests/team-row-ui.test.ts — The Team tab rows' layout (ui/src/components/team/TeamParts.tsx;
 * docs/DESIGN.md "Teammate Status: Shape, not Color"): the status icon sits in a
 * left column of its own, a circle as tall as the row's lines, with the text
 * stacked to its right. The fast suite has no DOM, so these are source checks
 * of each row's structure, plus that what the redesign must not lose is still
 * there: the icon named by its status, gray (no status colors), the working
 * spin's reduced-motion guard, the stretched link and the action buttons above it.
 * (The rendered rows are covered by the a11y scan and the UI smoke test.)
 */

import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { assert, assertEquals } from "./_assert.ts";

const SRC = fs.readFileSync(path.resolve(import.meta.dirname, "../ui/src/components/team/TeamParts.tsx"), "utf8");

/** The source of the exported component `name`, up to the next top-level export. */
function component(name: string): string {
  const start = SRC.indexOf(`export function ${name}(`);
  assert(start >= 0, `${name} not found`);
  const next = SRC.indexOf("\nexport function ", start + 1);
  return SRC.slice(start, next < 0 ? undefined : next);
}

/** What comes before `needle` in `src` (asserting it's there). */
function before(src: string, needle: string): string {
  const at = src.indexOf(needle);
  assert(at >= 0, `${needle} not found`);
  return src.slice(0, at);
}

test("TeammateRow: a flex row whose first column is the status in the row circle, then a min-w-0 text column", () => {
  const row = component("TeammateRow");
  assert(/className=\{`group relative flex items-center /.test(row), "the card is a centered flex row (and still relative, for the stretched link)");
  const lead = before(row, `<div className="min-w-0 flex-1">`);
  assert(lead.includes("<IconCircle className={ROW_CIRCLE}>"), "the status sits in the row-sized circle");
  assert(lead.includes(`<StatusIcon teammate={teammate} className={cn(ROW_ICON, "text-muted-foreground")} />`), "the icon is row-sized and gray");
  assert(lead.includes("<Tooltip content={statusLabel(teammate.status)}"), "the status tooltip stays");
  // Everything else — name, skew, model, harness, actions, work, persona, folder, stats — is in the text column.
  const text = row.slice(row.indexOf(`<div className="min-w-0 flex-1">`));
  for (const part of ["skewReason &&", "<Link to={to}", "<ModelName", "teammate.harness", "onReset(teammate)", "onDismiss(teammate.id)", "teammate.currentWork", "<PersonaChip", "<FolderOpen", "<SessionStats"]) {
    assert(text.includes(part), `${part} is in the text column`);
    assert(!lead.includes(part), `${part} isn't in the icon column`);
  }
});

test("TeammateRow: the stretched link and the controls above it survive", () => {
  const row = component("TeammateRow");
  assert(row.includes("after:absolute after:inset-0 after:content-['']"), "the name's link still covers the card");
  assert(row.includes("aria-label={`Watch ${teammateSummary(teammate)}`}"), "the link is named by the row's summary");
  assert(row.includes(`<div className="relative z-10 hidden items-center gap-0.5 group-hover:flex group-focus-within:flex">`), "the actions stay above the link");
  assert(row.includes(`<PersonaChip persona={teammate.persona} className="relative z-10`), "the persona chip stays above the link");
  assert(row.includes("aria-label={`Reset ${teammate.name}'s session`}") && row.includes("aria-label={`Dismiss ${teammate.name}`}"), "the buttons keep their names");
  // Only the card is positioned: a `relative` text column would shrink the stretched link to itself.
  assert(!row.includes(`<div className="relative min-w-0 flex-1">`), "the text column isn't a positioning context");
});

test("StatusIcon: still an image named by its status, with the reduced-motion spin, and no colors of its own", () => {
  const icon = component("StatusIcon");
  assert(icon.includes(`role: "img", "aria-label": label`), "named by statusLabel");
  assert(icon.includes("motion-safe:animate-[spin_2.5s_linear_infinite]"), "working spins only for motion-safe users");
  assertEquals(/text-(red|green|blue|amber|emerald|sky|yellow)-/.test(icon), false);
});

test("the rail avatar and the rows share one circle; the avatar keeps its size", () => {
  assert(SRC.includes(`function IconCircle(`), "the shared circle helper");
  assert(SRC.includes(`"flex shrink-0 items-center justify-center rounded-full border border-border bg-background"`), "rounded, bordered, on the background");
  const avatar = component("TeammateAvatar");
  assert(avatar.includes(`<IconCircle className={cn("h-8 w-8"`), "the avatar is still h-8 w-8");
  assert(avatar.includes(`<StatusIcon teammate={teammate} className="h-4 w-4" />`), "with its h-4 icon");
  assert(/const ROW_CIRCLE = "h-9 w-9"/.test(SRC) && /const ROW_ICON = "h-5 w-5/.test(SRC), "the rows' circle is a little larger");
});

test("spawn rows use the same left column, keeping their icons' colors", () => {
  for (const [name, icon] of [["SpawnRequestRow", `<Clock className={cn(ROW_ICON, "text-amber-600 animate-pulse")} />`], ["FailedSpawnRow", `<AlertTriangle className={cn(ROW_ICON, "text-destructive")} role="img" aria-label="Spawn failed" />`]] as const) {
    const row = component(name);
    assert(/<div className="group flex items-center gap-2\.5 /.test(row), `${name} is a flex row`);
    const lead = before(row, `<div className="min-w-0 flex-1">`);
    assert(lead.includes("<IconCircle className={ROW_CIRCLE}>") && lead.includes(icon), `${name}'s icon is in the left circle`);
    assert(!lead.includes("<button"), `${name}'s button is in the text column`);
  }
});
