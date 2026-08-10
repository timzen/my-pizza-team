/**
 * tests/upgrade.test.ts — Unit tests for the `mpt upgrade` GitHub error helper.
 *
 * The 403 that cloud-desktop users hit is a rate-limit exhaustion (shared
 * egress IP + GitHub's 60/hr unauthenticated limit). githubErrorMessage()
 * distinguishes that case from other errors and points at the token remedy.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { githubErrorMessage } from "../cli/main.ts";

function resWith(status: number, headers: Record<string, string>): Response {
  return new Response(null, { status, headers });
}

Deno.test("rate-limit 403 (no token) explains the shared-IP limit and token remedy", () => {
  const reset = Math.floor(Date.now() / 1000) + 1800;
  const msg = githubErrorMessage(resWith(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }));
  assertStringIncludes(msg, "rate limit exceeded");
  assertStringIncludes(msg, "GITHUB_TOKEN");
});

Deno.test("rate-limit 403 (with token) says the token's own limit is spent", () => {
  const msg = githubErrorMessage(resWith(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "0" }), "ghp_x");
  assertStringIncludes(msg, "rate limit exceeded");
  assertStringIncludes(msg, "token's rate limit");
});

Deno.test("a non-rate-limit 403 falls back to the generic message", () => {
  assertEquals(githubErrorMessage(resWith(403, { "x-ratelimit-remaining": "42" })), "GitHub API returned HTTP 403");
});

Deno.test("other statuses fall back to the generic message", () => {
  assertEquals(githubErrorMessage(resWith(404, {})), "GitHub API returned HTTP 404");
});
