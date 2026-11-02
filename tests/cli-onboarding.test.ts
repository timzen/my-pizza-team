/**
 * tests/cli-onboarding.test.ts — The CLI's pointer to the Welcome checklist
 * (cli/onboarding-hint.ts).
 *
 * `mpt setup`, `mpt start --daemon` and `mpt lead` end with one line sending a new
 * team to the web UI's Welcome checklist. These pin the line itself, that it follows
 * the daemon's own `visible` (served by the real app over HTTP, with and without an
 * API token), that an unreachable or refusing daemon means silence, and that the
 * three commands — and not `mpt doctor` — print it.
 */

import * as fs from "node:fs";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { serve } from "@hono/node-server";
import { assert, assertEquals } from "./_assert.ts";
import { withTeam, post, type App } from "./_team.ts";
import { fetchOnboarding, onboardingHintLine } from "../cli/onboarding-hint.ts";

const WELCOME = "Open http://localhost:7437/ — the Welcome checklist walks you through your first task";

/** Serve `app` on an ephemeral port for `fn`, then close it. */
async function serving<T>(app: App, fn: (url: string) => Promise<T>): Promise<T> {
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("a team that isn't onboarded gets the Welcome line, with the daemon's port", () => {
  assertEquals(onboardingHintLine({ visible: true }, 7437), WELCOME);
  assertEquals(
    onboardingHintLine({ visible: true }, 6789),
    "Open http://localhost:6789/ — the Welcome checklist walks you through your first task",
  );
});

test("an onboarded team or an unreachable daemon gets no extra line", () => {
  assertEquals(onboardingHintLine({ visible: false }, 7437), null);
  assertEquals(onboardingHintLine(null, 7437), null);
});

test("fetchOnboarding follows the daemon's visible: new team, then dismissed", async () => {
  await withTeam({}, async ({ app }) => {
    await serving(app, async (url) => {
      assertEquals(await fetchOnboarding(url, null), { visible: true });
      assertEquals((await post(app, "/api/onboarding/dismiss")).status, 200);
      assertEquals(await fetchOnboarding(url, null), { visible: false });
    });
  });
});

test("fetchOnboarding sends the API token, and a refusal means silence", async () => {
  await withTeam({ apiToken: "s3cret" }, async ({ app }) => {
    await serving(app, async (url) => {
      assertEquals(await fetchOnboarding(url, "s3cret"), { visible: true });
      assertEquals(await fetchOnboarding(url, null), null);
      assertEquals(await fetchOnboarding(url, "wrong"), null);
    });
  });
});

test("fetchOnboarding is null when nothing is listening", async () => {
  // Bind and close to get a port that is (momentarily) free.
  const port = await new Promise<number>((resolve) => {
    const s = serve({ fetch: () => new Response(""), port: 0, hostname: "127.0.0.1" }, () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
  assertEquals(await fetchOnboarding(`http://127.0.0.1:${port}`, null), null);
});

test("setup, start --daemon and lead print the pointer; doctor doesn't", () => {
  const src = fs.readFileSync(new URL("../cli/main.ts", import.meta.url), "utf8");
  /** The body of `async function <name>(` up to the next top-level function. */
  const body = (name: string): string => {
    const i = src.indexOf(`function ${name}(`);
    assert(i >= 0, `found ${name}`);
    const end = src.slice(i + 1).search(/\n(?:async )?function |\n\/\*\*/);
    return src.slice(i, end < 0 ? undefined : i + 1 + end);
  };
  // setup has two endings (already set up, and after making changes).
  assertEquals(body("cmdSetup").split("printOnboardingHint(").length - 1, 2);
  assert(/if \(newPid && !exited\) \{(?:(?!\} else \{)[\s\S])*printOnboardingHint\(/.test(body("cmdStart")), "start --daemon prints it once started");
  assert(body("cmdLead").includes("printOnboardingHint("), "lead prints it");
  assert(!body("cmdDoctor").includes("printOnboardingHint("), "doctor stays unchanged");
});
