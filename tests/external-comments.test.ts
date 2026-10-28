/**
 * tests/external-comments.test.ts — A mirrored WorkDef's thread, pulled from
 * its external source (`ExternalDef.comments`) and deduped against what MPT
 * wrote back (`onComment` → `{ externalId }`).
 * See docs/DESIGN.md "External sources" — "A mirrored thread".
 *
 * Covers: the pure merge (sources/comments.ts), the fixture's round trip
 * (pull → thread marked external; a new comment isn't a revision and doesn't
 * enqueue; inbound comments never fire onComment; a written-back comment
 * isn't pulled in again), the in-flight write-back deferral, and the UI helpers.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "./_assert.ts";
import { TEST_CONFIG } from "./_config.ts";
import { Store } from "../daemon/store.ts";
import { buildApp } from "../daemon/server.ts";
import { FIXTURE_SOURCE_ID, FIXTURE_WRITEBACK_CHANNEL, FixtureSource, fixtureCommentsFile } from "../daemon/sources/fixture.ts";
import { invalidExternalComment, mergeExternalComments, wroteBackKey } from "../daemon/sources/comments.ts";
import { invalidExternalDef, mirroredWorkDefId } from "../daemon/sources/mirror.ts";
import { fileSourceKv } from "../daemon/store/source-kv.ts";
import type { CommentWriteBack, ExternalComment, ExternalDef, WorkSource } from "../daemon/sources/types.ts";
import type { Comment } from "../shared/types.ts";
import { externalCommentLabel, newestFirst } from "../ui/src/lib/external-sources.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };

function tempTeam(): { store: Store; teamDir: string } {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-ext-comments-test-"));
  fs.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  return { store: new Store(teamDir, TEST_CONFIG), teamDir };
}

function cleanup(store: Store, teamDir: string): void {
  store.close();
  try { fs.rmSync(teamDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

const c = (externalId: string, createdAt: string, extra: Partial<ExternalComment> = {}): ExternalComment =>
  ({ externalId, author: "alice", createdAt, body: `body ${externalId}`, ...extra });

const settle = () => new Promise((r) => setTimeout(r, 0));

// ─── The merge ──────────────────────────────────────────────────────

test("invalidExternalComment: externalId, author, createdAt (a date), and body are required", () => {
  assertEquals(invalidExternalComment(c("1", "2025-01-01T00:00:00Z")), null);
  assertStringIncludes(invalidExternalComment({ ...c("1", "2025-01-01"), author: "" }) ?? "", "author");
  assertStringIncludes(invalidExternalComment(c("1", "not a date")) ?? "", "createdAt");
  assertStringIncludes(invalidExternalComment({ ...c("1", "2025-01-01"), channel: 3 }) ?? "", "channel");
  assert(invalidExternalComment(null));
});

test("invalidExternalDef: a non-array 'comments' makes the item invalid; omitted or [] is fine", () => {
  const base = { externalId: "a", revision: "1", title: "t", goal: "g" };
  assertEquals(invalidExternalDef(base), null);
  assertEquals(invalidExternalDef({ ...base, comments: [] }), null);
  assertStringIncludes(invalidExternalDef({ ...base, comments: "nope" }) ?? "", "comments");
});

test("mergeExternalComments: skips what the thread has, what MPT wrote back, repeats, and invalid ones; oldest first", () => {
  const thread: Comment[] = [
    { from: "alice", body: "old", at: "2025-01-01T00:00:00.000Z", external: { source: "src", id: "c1", author: "alice" } },
    // Another source's id doesn't count.
    { from: "bob", body: "x", at: "2025-01-01T00:00:00.000Z", external: { source: "other", id: "c2", author: "bob" } },
    { from: "you", body: "local", at: "2025-01-01T00:00:00.000Z" },
  ];
  const kv = new Map([[wroteBackKey("src~X", "c3"), "2025-01-02"]]);
  const { added, invalid } = mergeExternalComments("src", "src~X", thread, { get: (k) => kv.get(k) }, [
    c("c4", "2025-03-01T00:00:00Z", { channel: " Worklog " }),
    c("c1", "2025-01-01T00:00:00Z"),
    c("c2", "2025-02-01T00:00:00Z"),
    c("c3", "2025-01-02T00:00:00Z"),
    c("c4", "2025-03-01T00:00:00Z"),
    { externalId: "bad" },
  ]);
  assertEquals(added.map((a) => a.external?.id), ["c2", "c4"]);
  assertEquals(added[1], {
    from: "alice", body: "body c4", at: "2025-03-01T00:00:00.000Z",
    external: { source: "src", id: "c4", channel: "Worklog", author: "alice" },
  });
  assertEquals(invalid.length, 1);
});

// ─── The fixture round trip ─────────────────────────────────────────

test("sync pulls an item's comments into the mirror's thread, marked external; new ones never re-run it or write back", async () => {
  const { store, teamDir } = tempTeam();
  try {
    const folder = path.join(teamDir, "external");
    fs.mkdirSync(folder);
    const fixture = new FixtureSource({ dir: folder, syncEveryMs: null });
    store.registerWorkSource(fixture);
    fs.writeFileSync(path.join(folder, "T-1.md"), "---\ntitle: Thing\n---\n## Goal\n\nDo it\n");
    const commentsFile = fixtureCommentsFile(folder, "T-1");
    fs.writeFileSync(commentsFile, [
      JSON.stringify(c("w1", "2025-01-02T00:00:00Z", { channel: "Worklog", author: "bob" })),
      JSON.stringify(c("k1", "2025-01-01T00:00:00Z", { channel: "Correspondence" })),
    ].join("\n") + "\n");
    const id = mirroredWorkDefId(FIXTURE_SOURCE_ID, "T-1");

    const first = await store.syncWorkSource(FIXTURE_SOURCE_ID);
    assertEquals(first.enqueued.length, 1);
    assertEquals(first.commented, [id]);
    const thread = store.getCommentsForRef({ workDefId: id });
    assertEquals(thread.map((t) => [t.from, t.external?.channel, t.external?.id]), [["alice", "Correspondence", "k1"], ["bob", "Worklog", "w1"]]);

    // Re-sync: nothing new. A new comment upstream: appended, but no revision, no WorkItem.
    assertEquals((await store.syncWorkSource(FIXTURE_SOURCE_ID)).commented, []);
    fs.appendFileSync(commentsFile, JSON.stringify(c("k2", "2025-01-03T00:00:00Z", { channel: "Correspondence" })) + "\n");
    const item = store.getActiveWorkItemForTask(id)!;
    store.cancelWorkItem(item.id); // nothing in flight, so an enqueue would show
    const third = await store.syncWorkSource(FIXTURE_SOURCE_ID);
    assertEquals(third.commented, [id]);
    assertEquals(third.enqueued, []);
    assertEquals(third.mirrored, []);
    assertEquals(store.getCommentsForRef({ workDefId: id }).length, 3);
    // None of them was written back.
    assertEquals(fixture.writeBacks.filter((w) => w.hook === "onComment"), []);

    // A comment posted in MPT is written back (the fixture appends it upstream
    // and returns its id) and isn't pulled in again.
    const app = buildApp(store, TEST_CONFIG, teamDir);
    const res = await app.request(`/api/work-defs/${id}/comment`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ from: "you", body: "on it" }) });
    assertEquals(res.status, 200);
    assertEquals(fixture.writeBacks.filter((w) => w.hook === "onComment").length, 1);
    const upstream = fs.readFileSync(commentsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as ExternalComment);
    const posted = upstream.at(-1)!;
    assertEquals([posted.body, posted.channel], ["on it", FIXTURE_WRITEBACK_CHANNEL]);
    assert(fileSourceKv(teamDir, FIXTURE_SOURCE_ID).get(wroteBackKey(id, posted.externalId)));
    assertEquals((await store.syncWorkSource(FIXTURE_SOURCE_ID)).commented, []);
    const final = store.getCommentsForRef({ workDefId: id });
    assertEquals(final.map((t) => t.body), ["body k1", "body w1", "body k2", "on it"]);
    assertEquals(final.at(-1)!.external, undefined);
  } finally {
    cleanup(store, teamDir);
  }
});

test("an item that omits comments leaves the thread alone", async () => {
  const { store, teamDir } = tempTeam();
  try {
    let comments: ExternalComment[] | undefined = [c("1", "2025-01-01T00:00:00Z")];
    store.registerWorkSource({
      id: "src", apiVersion: 1,
      sync: async () => [{ externalId: "A", revision: "r1", title: "A", goal: "g", ...(comments ? { comments } : {}) }],
    });
    await store.syncWorkSource("src");
    comments = undefined;
    await store.syncWorkSource("src");
    assertEquals(store.getCommentsForRef({ workDefId: mirroredWorkDefId("src", "A") }).length, 1);
  } finally {
    cleanup(store, teamDir);
  }
});

test("an async write-back in flight defers that item's new comments; its returned id is recognised afterwards", async () => {
  const { store, teamDir } = tempTeam();
  try {
    const upstream: ExternalComment[] = [];
    let release!: (r: CommentWriteBack) => void;
    const source: WorkSource = {
      id: "slow", apiVersion: 1,
      sync: async (): Promise<ExternalDef[]> => [{ externalId: "S-1", revision: "r1", title: "S", goal: "g", comments: [...upstream] }],
      onComment: (_def, comment) => {
        // Posted upstream at once; the id only comes back later.
        upstream.push({ externalId: "up-1", author: "mpt", createdAt: comment.at, body: comment.body });
        return new Promise<CommentWriteBack>((r) => { release = r; });
      },
    };
    store.registerWorkSource(source);
    await store.syncWorkSource("slow");
    const id = mirroredWorkDefId("slow", "S-1");
    store.addCommentForRef({ workDefId: id }, "you", "hello");

    // The sync races the write-back: the post is upstream, its id not yet known.
    assertEquals((await store.syncWorkSource("slow")).commented, []);
    assertEquals(store.getCommentsForRef({ workDefId: id }).length, 1);

    release({ externalId: "up-1" });
    await settle();
    upstream.push(c("other", "2030-01-01T00:00:00Z"));
    assertEquals((await store.syncWorkSource("slow")).commented, [id]);
    assertEquals(store.getCommentsForRef({ workDefId: id }).map((t) => t.body), ["hello", "body other"]);
  } finally {
    cleanup(store, teamDir);
  }
});

// ─── The UI ─────────────────────────────────────────────────────────

test("externalCommentLabel: the source's label, and the channel when there is one", () => {
  assertEquals(externalCommentLabel({ source: "sim-t", id: "1", author: "a", channel: "Worklog" }, "SIM-T"), "SIM-T · Worklog");
  assertEquals(externalCommentLabel({ source: "taskei", id: "1", author: "a" }), "taskei");
});

test("newestFirst: by each comment's own time, file order breaking ties", () => {
  const thread = [
    { at: "2025-01-01T00:00:00Z", n: 1 },
    { at: "2025-01-03T00:00:00Z", n: 2 },
    { at: "2025-01-02T00:00:00Z", n: 3 }, // pulled later, written earlier
    { at: "2025-01-03T00:00:00Z", n: 4 },
  ];
  assertEquals(newestFirst(thread).map((t) => t.n), [4, 2, 3, 1]);
});
