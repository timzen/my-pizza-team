// The extension's generated shared files are in step with the repo root's shared/.
//
// src/shared/types.ts and src/shared/agent-protocol.ts are written by the root's
// scripts/sync-shared.ts (the extension can't import shared/: `mpt setup` copies
// it outside the repo). This runs that generator's own rendering and compares, so
// `npm run test:ext` catches a stale copy — e.g. a PROTOCOL_VERSION bump in
// shared/ that never reached the extension (docs/DESIGN.md "One Protocol, One
// Version"). Outside the monorepo (no ../../scripts/sync-shared.ts) it skips.
//
// Run: node --test --experimental-strip-types tests/shared-sync.test.mjs

import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";

const GENERATOR = new URL("../../../scripts/sync-shared.ts", import.meta.url);
const inRepo = fs.existsSync(GENERATOR);

test("src/shared/ matches what npm run sync-shared generates", { skip: !inRepo && "not in the my-pizza-team repo" }, async () => {
  const { generatedFiles } = await import(GENERATOR.href);
  const files = await generatedFiles();
  assert.ok(files.length >= 2, "expected the generated files");
  for (const { target, content } of files) {
    assert.equal(fs.readFileSync(target, "utf8"), content, `${target.pathname} is stale — run \`npm run sync-shared\` at the repo root`);
  }
});

test("the client sends the generated PROTOCOL_VERSION", { skip: !inRepo && "not in the my-pizza-team repo" }, async () => {
  const { PROTOCOL_VERSION } = await import("../src/shared/agent-protocol.ts");
  const root = await import(new URL("../../../shared/agent-protocol.ts", import.meta.url).href);
  assert.equal(PROTOCOL_VERSION, root.PROTOCOL_VERSION);
});
