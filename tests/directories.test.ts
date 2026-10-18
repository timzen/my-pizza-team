/**
 * tests/directories.test.ts — Favorite directories and directory-picker
 * suggestions (docs/DESIGN.md "Favorite Directories"): the Store normalizes,
 * dedupes and persists favorites to config.json; `/api/directories` serves
 * favorites + recently used directories and validates edits; and the UI's
 * ordering helper (ui/src/lib/directories.ts) lists favorites first.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import { test } from "node:test";
import { assertEquals } from "./_assert.ts";
import * as path from "node:path";
import { TEST_CONFIG } from "./_config.ts";
import { buildApp } from "../daemon/server.ts";
import { Store } from "../daemon/store.ts";
import type { TeamConfig } from "../shared/types.ts";
import { orderDirectorySuggestions } from "../ui/src/lib/directories.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };

function setup() {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-dirs-test-"));
  fs.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  // Real (symlink-free) scratch dirs, so realpath normalization is predictable.
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mpt-dirs-work-")));
  const config: TeamConfig = structuredClone(TEST_CONFIG);
  const store = new Store(teamDir, config);
  const app = buildApp(store, config, teamDir);
  const onDisk = () => JSON.parse(fs.readFileSync(path.join(teamDir, "config.json"), "utf8")) as Partial<TeamConfig>;
  const cleanup = () => {
    store.close();
    fs.rmSync(teamDir, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  };
  return { app, store, config, work, onDisk, cleanup };
}

test("favorites are normalized (trailing slash, symlinks, ~), deduped, and persisted", () => {
  const { store, work, onDisk, cleanup } = setup();
  try {
    const repo = path.join(work, "repo");
    fs.mkdirSync(repo);
    const link = path.join(work, "link");
    fs.symlinkSync(repo, link);

    const stored = store.setFavoriteDirectories([`${repo}/`, link, "  ", path.join(work, "other")]);
    // The symlink resolves to the same real path, so it collapses into `repo`.
    assertEquals(stored, [repo, path.join(work, "other")]);
    assertEquals(onDisk().favoriteDirectories, stored);

    const home = process.env["HOME"];
    if (home) {
      const withTilde = store.addFavoriteDirectory("~/definitely-missing-mpt-dir");
      assertEquals(withTilde.at(-1), path.join(home, "definitely-missing-mpt-dir"));
    }
  } finally { cleanup(); }
});

test("removeFavoriteDirectory matches by normalized path; emptied list is dropped from config.json", () => {
  const { store, work, onDisk, cleanup } = setup();
  try {
    store.addFavoriteDirectory(work);
    assertEquals(store.addFavoriteDirectory(work), [work]); // no duplicate
    assertEquals(store.removeFavoriteDirectory(`${work}/`), true);
    assertEquals(store.removeFavoriteDirectory(work), false);
    assertEquals(store.getFavoriteDirectories(), []);
    assertEquals(onDisk().favoriteDirectories, undefined);
  } finally { cleanup(); }
});

test("recent directories: online teammates, then WorkItems, then stories — favorites excluded", async () => {
  const { app, store, work, cleanup } = setup();
  try {
    const mk = (n: string) => { const p = path.join(work, n); fs.mkdirSync(p); return p; };
    const a = mk("a"), b = mk("b"), c = mk("c"), d = mk("d");
    store.registerMember("agent-1", "agent-1", a);
    await app.request("/api/work-defs", {
      method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ title: "W", goal: "g", acceptanceCriteria: "-", directory: b }),
    });
    await app.request("/api/stories", {
      method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ id: "s1", title: "S", description: "", workflow: "default", directory: c, tasks: [] }),
    });
    store.addFavoriteDirectory(d);
    store.addFavoriteDirectory(c);

    const res = await (await app.request("/api/directories")).json();
    assertEquals(res.favorites, [d, c]);
    assertEquals(res.recent, [a, b]);
  } finally { cleanup(); }
});

test("favorites API: add, replace, remove, and validation", async () => {
  const { app, work, cleanup } = setup();
  try {
    const x = path.join(work, "x");
    const y = path.join(work, "y");

    const bad = await app.request("/api/directories/favorites", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ directory: "" }) });
    assertEquals(bad.status, 400);

    let res = await (await app.request("/api/directories/favorites", {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ directory: `${x}/` }),
    })).json();
    assertEquals(res, { success: true, favorites: [x] });

    const badPut = await app.request("/api/directories/favorites", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ directories: [x, 3] }) });
    assertEquals(badPut.status, 400);

    res = await (await app.request("/api/directories/favorites", {
      method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ directories: [y, x] }),
    })).json();
    assertEquals(res.favorites, [y, x]);

    const del = await app.request(`/api/directories/favorites?directory=${encodeURIComponent(y)}`, { method: "DELETE" });
    assertEquals((await del.json()).favorites, [x]);
    assertEquals((await app.request(`/api/directories/favorites?directory=${encodeURIComponent(y)}`, { method: "DELETE" })).status, 404);
    assertEquals((await app.request("/api/directories/favorites", { method: "DELETE" })).status, 400);

    // GET /api/config exposes them (read-only there).
    assertEquals((await (await app.request("/api/config")).json()).favoriteDirectories, [x]);
  } finally { cleanup(); }
});

test("PUT /api/config does not overwrite favorites (they have their own endpoint)", async () => {
  const { app, store, work, onDisk, cleanup } = setup();
  try {
    const current = await (await app.request("/api/config")).json();
    // A star clicked in a picker after the Config page loaded its draft…
    store.addFavoriteDirectory(work);
    // …is not undone by saving that stale draft.
    const res = await app.request("/api/config", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(current) });
    assertEquals((await res.json()).success, true);
    assertEquals(onDisk().favoriteDirectories, [work]);
  } finally { cleanup(); }
});

test("orderDirectorySuggestions: favorites first, deduped, filtered", () => {
  const got = orderDirectorySuggestions(["/f1", "/f2"], ["/r1", "/f1"], ["/e1", "/r1"], "");
  assertEquals(got, [
    { dir: "/f1", favorite: true },
    { dir: "/f2", favorite: true },
    { dir: "/r1", favorite: false },
    { dir: "/e1", favorite: false },
  ]);
  assertEquals(orderDirectorySuggestions(["/Proj/A"], ["/other"], [], "proj").map((s) => s.dir), ["/Proj/A"]);
});
