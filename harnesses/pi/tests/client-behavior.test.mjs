// Behavioural tests for DaemonClient — the HTTP contract with the daemon.
//
// Every other test file in this package asserts on *source text* (readFileSync
// plus src.includes(...)), which cannot catch a behavioural regression and breaks
// on any file move. client.ts is the module that actually crosses a package
// boundary in P1c-8 (841 lines into agent-runtime/), so it gets real tests first
// — see docs/BATTERIES_INCLUDED_TASKS.md P0-7.
//
// These run against a real node:http server rather than a stubbed fetch, so they
// exercise URL construction, headers, status handling, and JSON parsing the same
// way the daemon will. Each test records what the server actually received, so a
// refactor that changes a path, method, or body fails here rather than in a
// silently misbehaving teammate.
//
// Run: node --test --experimental-strip-types tests/client-behavior.test.mjs

import { test } from "node:test";
import * as assert from "node:assert";
import * as http from "node:http";

const { DaemonClient, DaemonError } = await import("../src/client.ts");

/**
 * Start a throwaway server on an ephemeral port. `handler(req, body)` returns
 * `{ status?, json?, text? }`. Every request is recorded on `calls`.
 */
async function withServer(handler, fn) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: body ? JSON.parse(body) : undefined,
        raw: body,
      });
      const out = handler?.(req, body) ?? { json: { success: true } };
      const status = out.status ?? 200;
      if (out.text !== undefined) {
        res.writeHead(status, { "Content-Type": "text/plain" });
        res.end(out.text);
      } else {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out.json ?? {}));
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(url, calls);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const client = (url, opts) => new DaemonClient(url, "agent-1", { hostId: "host-1", ...opts });

// ─── Construction ────────────────────────────────────────────────────

test("strips a trailing slash so paths don't double up", () => {
  assert.equal(new DaemonClient("http://d:7437/", "a", { hostId: "h" }).url, "http://d:7437");
  assert.equal(new DaemonClient("http://d:7437", "a", { hostId: "h" }).url, "http://d:7437");
});

test("exposes the agent id and host id it was built with", () => {
  const c = new DaemonClient("http://d", "swift-ripley", { hostId: "box-2" });
  assert.equal(c.id, "swift-ripley");
  assert.equal(c.hostId, "box-2");
});

// ─── Headers ─────────────────────────────────────────────────────────

test("sends a bearer token only when one is configured", async () => {
  await withServer(null, async (url, calls) => {
    await client(url, { authToken: "tok-abc" }).getStatus();
    assert.equal(calls[0].headers.authorization, "Bearer tok-abc");
  });
  await withServer(null, async (url, calls) => {
    await client(url).getStatus();
    assert.equal(calls[0].headers.authorization, undefined);
  });
});

test("sets JSON content-type on requests with a body, not on GETs", async () => {
  await withServer(null, async (url, calls) => {
    const c = client(url);
    await c.getStatus();
    await c.register({ name: "swift-ripley" });
    const [get, post] = calls;
    assert.equal(get.headers["content-type"], undefined);
    assert.equal(post.headers["content-type"], "application/json");
  });
});

// ─── Error handling ──────────────────────────────────────────────────

test("surfaces the daemon's error message and status as DaemonError", async () => {
  await withServer(() => ({ status: 409, json: { error: "work item already claimed" } }), async (url) => {
    await assert.rejects(
      () => client(url).claimWorkItem("w-1"),
      (e) => {
        assert.ok(e instanceof DaemonError, "expected a DaemonError");
        assert.equal(e.message, "work item already claimed");
        assert.equal(e.statusCode, 409);
        return true;
      },
    );
  });
});

test("falls back to status text when the error body isn't JSON", async () => {
  await withServer(() => ({ status: 502, text: "<html>bad gateway</html>" }), async (url) => {
    await assert.rejects(
      () => client(url).claimWorkItem("w-1"),
      (e) => {
        assert.equal(e.statusCode, 502);
        assert.ok(!e.message.includes("<html>"), "should not leak an HTML body as the message");
        return true;
      },
    );
  });
});

test("checkHealth reports false instead of throwing when the daemon is down", async () => {
  // Port 1 is reserved and nothing listens there: a connection error, not a 4xx.
  const c = new DaemonClient("http://127.0.0.1:1", "a", { hostId: "h" });
  assert.equal(await c.checkHealth(), false);
});

test("checkHealth reports false on a non-2xx health response", async () => {
  await withServer(() => ({ status: 503, json: {} }), async (url) => {
    assert.equal(await client(url).checkHealth(), false);
  });
});

test("heartbeat swallows transport failures — it runs on an interval", async () => {
  const c = new DaemonClient("http://127.0.0.1:1", "a", { hostId: "h" });
  await assert.doesNotReject(() => c.heartbeat("idle"));
});

// ─── The agent protocol ──────────────────────────────────────────────

test("register posts identity, host, and directory", async () => {
  await withServer(null, async (url, calls) => {
    await client(url).register({ name: "swift-ripley", directory: "/repo", metadata: { window: "w3" } });
    const [c] = calls;
    assert.equal(c.method, "POST");
    assert.equal(c.url, "/api/agents/register");
    assert.deepEqual(c.body, {
      id: "agent-1",
      name: "swift-ripley",
      hostId: "host-1",
      directory: "/repo",
      metadata: { window: "w3" },
    });
  });
});

test("deregister deletes the agent by id", async () => {
  await withServer(null, async (url, calls) => {
    await client(url).deregister();
    assert.equal(calls[0].method, "DELETE");
    assert.equal(calls[0].url, "/api/agents/agent-1");
  });
});

test("work-item claim and terminal state hit the agent routes", async () => {
  await withServer(null, async (url, calls) => {
    const c = client(url);
    await c.claimWorkItem("w-1");
    await c.setWorkItemState("w-1", "COMPLETE");
    assert.equal(calls[0].url, "/api/agents/claim/w-1");
    assert.equal(calls[1].url, "/api/agents/work-items/w-1/state");
    assert.equal(calls[1].body.state, "COMPLETE");
  });
});

test("ids are URL-encoded, so a slash in one can't forge a path", async () => {
  await withServer(null, async (url, calls) => {
    await client(url).claimWorkItem("a/../b");
    assert.equal(calls[0].url, "/api/agents/claim/a%2F..%2Fb");
  });
});

// ─── Leader directives (the daemon -> leader channel) ────────────────
//
// P1c-1 collapses these from /api/hosts/:hostId/leader/* to /api/leader/*.
// Pinning them here means that change shows up as a failing test rather than a
// leader that silently polls a 404 and never spawns anyone.

test("leader directives are polled, created, completed, and failed on the host route", async () => {
  await withServer(null, async (url, calls) => {
    const c = client(url);
    await c.getLeaderDirectives();
    await c.createLeaderDirective("spawn", { params: { cwd: "/repo" } });
    await c.completeLeaderDirective("dir-1");
    await c.failLeaderDirective("dir-2");

    assert.deepEqual(
      calls.map((x) => `${x.method} ${x.url}`),
      [
        "GET /api/hosts/host-1/leader/directives",
        "POST /api/hosts/host-1/leader/directives",
        "PUT /api/hosts/host-1/leader/directives/dir-1",
        "PUT /api/hosts/host-1/leader/directives/dir-2",
      ],
    );
    // `memberId: undefined` is dropped by JSON.stringify, so it never goes over
    // the wire — a member-targeted directive is what carries it.
    assert.deepEqual(calls[1].body, { action: "spawn", params: { cwd: "/repo" } });
    assert.equal(calls[2].body.status, "done");
    assert.equal(calls[3].body.status, "failed");
  });
});

// ─── Usage reporting ─────────────────────────────────────────────────
//
// The ledger silently records nothing when this drifts (BATTERIES_INCLUDED
// §1.2), so the path and payload are worth pinning.

test("usage is reported against the agent", async () => {
  await withServer(null, async (url, calls) => {
    await client(url).reportUsage({ inputTokens: 10, outputTokens: 20, model: "m" });
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url, "/api/agents/agent-1/usage");
    assert.equal(calls[0].body.inputTokens, 10);
    assert.equal(calls[0].body.outputTokens, 20);
  });
});
