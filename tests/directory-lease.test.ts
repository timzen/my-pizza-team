/**
 * tests/directory-lease.test.ts — One teammate per directory: the exclusive
 * directory lease (docs/DESIGN.md "Work Matching: Directory Affinity").
 *
 * - An IN_PROGRESS or MORIBUND WorkItem with a directory blocks any READY item
 *   whose directory overlaps it (same path, parent, or child — by segment)
 * - COMPLETE / FAILED / CANCELED free the lease; blocked items stay READY
 * - Items with no directory are exempt; a teammate's own directory never leases
 * - `claimWorkItem` re-checks the lease (no two claims for one directory)
 * - `exclusiveDirectories: false` restores unrestricted parallelism
 * - `GET /api/work-items` reports `blockedBy`; `PUT /api/config` edits the flag
 */

import { assert, assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { TEST_CONFIG } from "./_config.ts";
import { Store } from "../daemon/store.ts";
import { buildApp } from "../daemon/server.ts";
import { directoriesOverlap, type TeamConfig, type WorkItem } from "../shared/types.ts";
import * as path from "@std/path";

function setup(overrides: Partial<TeamConfig> = {}) {
  const teamDir = Deno.makeTempDirSync({ prefix: "mpt-lease-test-" });
  Deno.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  const config: TeamConfig = { ...structuredClone(TEST_CONFIG), ...overrides };
  const store = new Store(teamDir, config);
  const cleanup = () => { store.close(); try { Deno.removeSync(teamDir, { recursive: true }); } catch { /* */ } };
  return { store, config, teamDir, cleanup };
}

/** Create a standalone WorkDef in `directory` and return its READY WorkItem. */
function enqueue(store: Store, title: string, directory?: string): WorkItem {
  const def = store.createWorkDef({ title, goal: "g", acceptanceCriteria: "a", directory });
  return store.getActiveWorkItemForTask(def.id)!;
}

/** Poll as a teammate with no registered directory (no tier-1 preference). */
const next = (store: Store, id = "ag") => store.getNextWorkItem({ id });

/** Every READY item the store would hand out, one claim at a time. */
function drain(store: Store): string[] {
  const titles: string[] = [];
  for (let wi = next(store); wi; wi = next(store)) {
    assert(store.claimWorkItem(wi.id, "ag"));
    titles.push(wi.title);
  }
  return titles;
}

Deno.test("directoriesOverlap compares path segments, not string prefixes", () => {
  assert(directoriesOverlap("/ws/mpt-dev", "/ws/mpt-dev"));
  assert(directoriesOverlap("/ws/mpt-dev", "/ws/mpt-dev/my-pizza-team"));
  assert(directoriesOverlap("/ws/mpt-dev/my-pizza-team", "/ws/mpt-dev"));
  assert(!directoriesOverlap("/ws/foo", "/ws/foobar"));
  assert(!directoriesOverlap("/ws/foobar", "/ws/foo"));
  assert(!directoriesOverlap("/ws/a", "/ws/b"));
  assert(directoriesOverlap("/", "/ws/a"));
});

Deno.test("lease: two items in one directory run one at a time; COMPLETE frees it", () => {
  const { store, cleanup } = setup();
  try {
    const a = enqueue(store, "A", "/ws/repo");
    const b = enqueue(store, "B", "/ws/repo");
    assertEquals(next(store)!.id, a.id);
    assert(store.claimWorkItem(a.id, "ag"));
    // B is blocked: nothing to hand out, and it stays READY.
    assertEquals(next(store), null);
    assertEquals(store.getWorkItem(b.id)!.state, "READY");
    assertEquals(store.getDirectoryBlocker(b)!.id, a.id);

    assert(store.setWorkItemState(a.id, "COMPLETE").ok);
    assertEquals(store.getDirectoryBlocker(b), null);
    assertEquals(next(store)!.id, b.id);
  } finally { cleanup(); }
});

Deno.test("lease: FAILED and CANCELED free it too", () => {
  const { store, cleanup } = setup();
  try {
    const a = enqueue(store, "A", "/ws/repo");
    const b = enqueue(store, "B", "/ws/repo");
    const c = enqueue(store, "C", "/ws/repo");
    assert(store.claimWorkItem(a.id, "ag"));
    assert(store.setWorkItemState(a.id, "FAILED").ok);
    assertEquals(next(store)!.id, b.id);
    assert(store.claimWorkItem(b.id, "ag"));
    assertEquals(next(store), null);
    // Deleting a WorkDef cancels its in-flight item.
    store.deleteWorkDef(b.ref.workDefId);
    assertEquals(store.getWorkItem(b.id)!.state, "CANCELED");
    assertEquals(next(store)!.id, c.id);
  } finally { cleanup(); }
});

Deno.test("lease: parent/child directories conflict; unrelated (incl. shared prefixes) run in parallel", () => {
  const { store, cleanup } = setup();
  try {
    enqueue(store, "parent", "/ws/mpt-dev");
    enqueue(store, "child", "/ws/mpt-dev/my-pizza-team");
    enqueue(store, "foo", "/ws/foo");
    enqueue(store, "foobar", "/ws/foobar");
    // The child waits behind its parent; foo and foobar don't collide.
    assertEquals(drain(store), ["parent", "foo", "foobar"]);
  } finally { cleanup(); }

  const second = setup();
  try {
    // And the other way round: a child in flight blocks its parent.
    const child = enqueue(second.store, "child", "/ws/mpt-dev/my-pizza-team");
    const parent = enqueue(second.store, "parent", "/ws/mpt-dev");
    assert(second.store.claimWorkItem(child.id, "ag"));
    assertEquals(second.store.getDirectoryBlocker(parent)!.id, child.id);
    assertEquals(next(second.store), null);
  } finally { second.cleanup(); }
});

Deno.test("lease: overlap is found across a symlink (normalizeDirectory on both sides)", () => {
  const { store, cleanup } = setup();
  const root = Deno.realPathSync(Deno.makeTempDirSync({ prefix: "mpt-lease-link-" }));
  try {
    const real = path.join(root, "repo");
    Deno.mkdirSync(real);
    const link = path.join(root, "link");
    Deno.symlinkSync(real, link);
    const a = enqueue(store, "A", real);
    const b = enqueue(store, "B", link);
    // Simulate a legacy row holding the unresolved symlink path.
    const db = (store as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db;
    db.prepare("UPDATE work_items SET directory = ? WHERE id = ?").run(link, b.id);
    assert(store.claimWorkItem(a.id, "ag"));
    assertEquals(next(store), null);
  } finally { cleanup(); Deno.removeSync(root, { recursive: true }); }
});

Deno.test("lease: a teammate's registered directory neither takes nor blocks a lease", () => {
  const { store, cleanup } = setup();
  try {
    // Teammates are online in /ws/repo and its parent, idle.
    store.registerMember("home", "home", "/ws/repo");
    store.registerMember("up", "up", "/ws");
    const a = enqueue(store, "A", "/ws/repo");
    // The item is still handed out — to its home teammate, by affinity.
    assertEquals(store.getNextWorkItem({ id: "home", directory: "/ws/repo" })!.id, a.id);
    assertEquals(store.getDirectoryBlocker(a), null);
    assert(store.claimWorkItem(a.id, "home"));
  } finally { cleanup(); }
});

Deno.test("lease: items with no directory are exempt both ways", () => {
  const { store, cleanup } = setup();
  try {
    const free1 = enqueue(store, "free1");
    const dir = enqueue(store, "dir", "/ws/repo");
    const free2 = enqueue(store, "free2");
    assert(store.claimWorkItem(dir.id, "ag"));
    // A held directory doesn't block undirected work…
    assertEquals(store.getDirectoryBlocker(free1), null);
    assert(store.claimWorkItem(free1.id, "ag"));
    // …and undirected work in flight doesn't block anything.
    assert(store.claimWorkItem(free2.id, "ag"));
    const other = enqueue(store, "other", "/ws/other");
    assertEquals(next(store)!.id, other.id);
  } finally { cleanup(); }
});

Deno.test("lease: a MORIBUND item keeps its directory until resolved (force-fail frees it)", () => {
  const teamDir = Deno.makeTempDirSync({ prefix: "mpt-lease-moribund-" });
  Deno.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  try {
    const store = new Store(teamDir, structuredClone(TEST_CONFIG));
    const a = enqueue(store, "A", "/ws/repo");
    const b = enqueue(store, "B", "/ws/repo");
    assert(store.claimWorkItem(a.id, "ag"));
    store.close();

    // Daemon restart: the in-flight item becomes MORIBUND but holds the lease.
    const store2 = new Store(teamDir, structuredClone(TEST_CONFIG));
    try {
      assertEquals(store2.getWorkItem(a.id)!.state, "MORIBUND");
      assertEquals(next(store2), null);
      assertEquals(store2.claimWorkItem(b.id, "newcomer"), false);
      assertEquals(store2.getDirectoryBlocker(b)!.id, a.id);
      // A human releases the stuck lease by force-failing it.
      assert(store2.forceFailWorkItem(a.id).ok);
      assertEquals(next(store2)!.id, b.id);
    } finally { store2.close(); }
  } finally { Deno.removeSync(teamDir, { recursive: true }); }
});

Deno.test("lease: two agents polling at once can't both claim for one directory", () => {
  const { store, cleanup } = setup();
  try {
    const a = enqueue(store, "A", "/ws/repo");
    const b = enqueue(store, "B", "/ws/repo/sub");
    // Both agents were offered work before either claimed (stale offers).
    assertEquals(store.getDirectoryBlocker(a), null);
    assertEquals(store.getDirectoryBlocker(b), null);
    assert(store.claimWorkItem(a.id, "ag-1"));
    assertEquals(store.claimWorkItem(b.id, "ag-2"), false);
    assertEquals(store.getWorkItem(b.id)!.state, "READY");
    assertEquals(store.getWorkItem(b.id)!.memberId, undefined);
  } finally { cleanup(); }
});

Deno.test("lease: exclusiveDirectories false restores unrestricted parallelism", () => {
  const { store, cleanup } = setup({ exclusiveDirectories: false });
  try {
    enqueue(store, "A", "/ws/repo");
    enqueue(store, "B", "/ws/repo");
    enqueue(store, "C", "/ws/repo/sub");
    assertEquals(drain(store), ["A", "B", "C"]);
  } finally { cleanup(); }
});

Deno.test("GET /api/work-items reports why a READY item is waiting", async () => {
  const { store, config, teamDir, cleanup } = setup();
  try {
    const app = buildApp(store, config, teamDir);
    store.registerMember("m1", "swift-ripley", "/elsewhere");
    const a = enqueue(store, "Holder", "/ws/repo");
    const b = enqueue(store, "Waiter", "/ws/repo");
    const free = enqueue(store, "Free");
    assert(store.claimWorkItem(a.id, "m1"));

    const body = await (await app.request("/api/work-items?state=READY,IN_PROGRESS")).json();
    const byId = new Map((body.items as Array<{ id: string; blockedBy?: Record<string, string> }>).map((i) => [i.id, i]));
    assertEquals(byId.get(b.id)!.blockedBy, {
      workItemId: a.id, title: "Holder", directory: "/ws/repo", memberId: "m1", memberName: "swift-ripley",
    });
    assertEquals(byId.get(a.id)!.blockedBy, undefined);
    assertEquals(byId.get(free.id)!.blockedBy, undefined);

    // A claim that loses the directory race says why.
    const res = await app.request(`/api/agents/claim/${b.id}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agentId: "m2" }),
    });
    assertEquals(res.status, 409);
    assertStringIncludes((await res.json()).error, "directory busy (swift-ripley, Holder)");
  } finally { cleanup(); }
});

Deno.test("PUT /api/config edits exclusiveDirectories (default on, persisted, live)", async () => {
  const { store, config, teamDir, cleanup } = setup();
  try {
    const app = buildApp(store, config, teamDir);
    const put = async (patch: Record<string, unknown>) => {
      const current = await (await app.request("/api/config")).json();
      return app.request("/api/config", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...current, ...patch }),
      });
    };
    const onDisk = () => JSON.parse(Deno.readTextFileSync(path.join(teamDir, "config.json")));

    const a = enqueue(store, "A", "/ws/repo");
    const b = enqueue(store, "B", "/ws/repo");
    assert(store.claimWorkItem(a.id, "ag"));
    assertExists(store.getDirectoryBlocker(b));

    assertEquals((await (await put({ exclusiveDirectories: "nope" })).json()).success, false);
    assertEquals((await (await put({ exclusiveDirectories: false })).json()).success, true);
    assertEquals(onDisk().exclusiveDirectories, false);
    // Live: the in-memory config the Store reads changed.
    assertEquals(store.getDirectoryBlocker(b), null);
    assertEquals(next(store)!.id, b.id);

    assertEquals((await (await put({ exclusiveDirectories: true })).json()).success, true);
    assertEquals(onDisk().exclusiveDirectories, true);
    assertExists(store.getDirectoryBlocker(b));
  } finally { cleanup(); }
});
