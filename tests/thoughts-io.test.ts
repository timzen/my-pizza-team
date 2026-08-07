/**
 * tests/thoughts-io.test.ts — Round-trip tests for the Thoughts on-disk IO
 * module (thoughts/<id>.md + groups.json). Pure file IO, no SQLite/Store.
 */

import { assertEquals } from "@std/assert";
import * as path from "@std/path";
import {
  serializeThought,
  parseThought,
  writeThought,
  getThought,
  listThoughts,
  deleteThoughtFile,
  listThoughtGroups,
  writeThoughtGroups,
} from "../daemon/store/thoughts.ts";
import type { Thought } from "../shared/types.ts";

function tempDir(): string {
  return Deno.makeTempDirSync({ prefix: "mpt-thoughts-io-" });
}
function cleanup(dir: string): void {
  try { Deno.removeSync(dir, { recursive: true }); } catch { /* ignore */ }
}

function sampleThought(over: Partial<Thought> = {}): Thought {
  return {
    id: "th-1",
    content: "Try the new model on triage.",
    color: "yellow",
    status: "active",
    x: 320,
    y: 140,
    w: 240,
    h: null,
    zIndex: 5,
    pinned: false,
    groupId: null,
    createdBy: "human",
    createdAt: "2026-08-06T10:00:00.000Z",
    updatedAt: "2026-08-06T10:05:00.000Z",
    ...over,
  };
}

Deno.test("Thoughts IO: serialize → parse round-trips all fields", () => {
  const t = sampleThought({ pinned: true, groupId: "grp-a", w: 240, h: 160 });
  const parsed = parseThought(t.id, serializeThought(t));
  assertEquals(parsed, t);
});

Deno.test("Thoughts IO: auto-sized (w/h null) round-trips", () => {
  const t = sampleThought({ w: null, h: null });
  const parsed = parseThought(t.id, serializeThought(t));
  assertEquals(parsed!.w, null);
  assertEquals(parsed!.h, null);
});

Deno.test("Thoughts IO: multi-line markdown body with a checklist survives", () => {
  const content = "# Plan\n\n- [ ] draft\n- [x] outline\n\nnotes here";
  const t = sampleThought({ content });
  const parsed = parseThought(t.id, serializeThought(t));
  assertEquals(parsed!.content, content);
});

Deno.test("Thoughts IO: write → get → list on disk", () => {
  const dir = tempDir();
  try {
    writeThought(dir, sampleThought({ id: "th-a" }));
    writeThought(dir, sampleThought({ id: "th-b", status: "archived" }));
    assertEquals(getThought(dir, "th-a")!.id, "th-a");
    assertEquals(getThought(dir, "th-b")!.status, "archived");
    const all = listThoughts(dir);
    assertEquals(all.map((t) => t.id), ["th-a", "th-b"]);
    // The file is really `<id>.md`.
    assertEquals(Deno.statSync(path.join(dir, "thoughts", "th-a.md")).isFile, true);
    assertEquals(deleteThoughtFile(dir, "th-a"), true);
    assertEquals(getThought(dir, "th-a"), null);
    assertEquals(deleteThoughtFile(dir, "th-a"), false);
  } finally { cleanup(dir); }
});

Deno.test("Thoughts IO: groups.json round-trips", () => {
  const dir = tempDir();
  try {
    assertEquals(listThoughtGroups(dir), []);
    writeThoughtGroups(dir, [
      { id: "grp-a", title: "Q3 Planning", x: 10, y: 20, w: 360, h: 260, groupColor: null, plateOpacity: "medium" },
      { id: "grp-b", title: "Ideas", x: 0, y: 0, w: 400, h: 300, groupColor: "blue", plateOpacity: "solid" },
    ]);
    const groups = listThoughtGroups(dir);
    assertEquals(groups.length, 2);
    assertEquals(groups[0], { id: "grp-a", title: "Q3 Planning", x: 10, y: 20, w: 360, h: 260, groupColor: null, plateOpacity: "medium" });
  } finally { cleanup(dir); }
});

Deno.test("Thoughts IO: groups without geometry get defaults", () => {
  const dir = tempDir();
  try {
    // Hand-written/legacy file lacking geometry: defaults fill in.
    Deno.writeTextFileSync(`${dir}/groups.json`, JSON.stringify([{ id: "grp-x", title: "X" }]));
    const [g] = listThoughtGroups(dir);
    assertEquals(g, { id: "grp-x", title: "X", x: 0, y: 0, w: 360, h: 260, groupColor: null, plateOpacity: "medium" });
  } finally { cleanup(dir); }
});

Deno.test("Thoughts IO: parse tolerates missing frontmatter (returns null)", () => {
  assertEquals(parseThought("th-x", "no frontmatter here"), null);
});
