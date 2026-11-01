/**
 * tests/protocol-version.test.ts — The extension speaks the protocol version
 * shared/ defines.
 *
 * The extension can't import `shared/` (it is a self-contained package that
 * `mpt setup` writes outside this repo), so `npm run sync-shared` copies
 * shared/agent-protocol.ts — PROTOCOL_VERSION included — into
 * harnesses/pi/src/shared/agent-protocol.ts, and runtime/client.ts imports it by
 * `../shared/agent-protocol.ts` — the root original at the root, and the copy in
 * the extension's generated runtime/client.ts.
 * That leaves two things to enforce rather than trust (docs/DESIGN.md "One
 * Protocol, One Version"): the copy holds the same value, and client.ts uses the
 * copy instead of declaring its own. (tests/version.test.ts checks the whole
 * generated file is in step.)
 */

import * as fs from "node:fs";
import { test } from "node:test";
import { assertEquals, assertMatch } from "./_assert.ts";
import { PROTOCOL_VERSION } from "../shared/protocol.ts";
import { PROTOCOL_VERSION as EXT_PROTOCOL_VERSION } from "../harnesses/pi/src/shared/agent-protocol.ts";

const EXT_CLIENT = new URL("../runtime/client.ts", import.meta.url);

test("the extension's generated agent protocol carries shared/'s PROTOCOL_VERSION", () => {
  assertEquals(
    EXT_PROTOCOL_VERSION,
    PROTOCOL_VERSION,
    "PROTOCOL_VERSION drift: harnesses/pi/src/shared/agent-protocol.ts disagrees with shared/agent-protocol.ts — run `npm run sync-shared`",
  );
});

test("client.ts imports PROTOCOL_VERSION from the generated copy and declares none of its own", async () => {
  const src = await fs.promises.readFile(EXT_CLIENT, "utf8");
  assertEquals(
    /\b(const|let|var)\s+PROTOCOL_VERSION\b/.test(src),
    false,
    "client.ts must not declare its own PROTOCOL_VERSION — import it from ../shared/agent-protocol.ts",
  );
  assertMatch(
    src,
    /import\s*\{[^}]*\bPROTOCOL_VERSION\b[^}]*\}\s*from\s*"\.\.\/shared\/agent-protocol\.ts"/,
    "client.ts should import PROTOCOL_VERSION from ../shared/agent-protocol.ts",
  );
});

test("client.ts hand-copies none of the agent-protocol definitions", async () => {
  // The drift this refactor removed: interfaces re-declared in client.ts that
  // also lived in shared/. Anything agent-protocol.ts exports must come from it.
  const src = await fs.promises.readFile(EXT_CLIENT, "utf8");
  const shared = await fs.promises.readFile(new URL("../shared/agent-protocol.ts", import.meta.url), "utf8");
  const names = [...shared.matchAll(/^export\s+(?:const|function|type|interface)\s+(\w+)/gm)].map((m) => m[1]!);
  assertEquals(names.length > 10, true, `expected agent-protocol.ts's exports, found ${names.length}`);
  const redeclared = names.filter((n) => new RegExp(`^export\\s+(?:const|function|type|interface|class)\\s+${n}\\b`, "m").test(src));
  assertEquals(redeclared, [], `client.ts re-declares: ${redeclared.join(", ")}`);
});

test("the extension sends the handshake at registration", async () => {
  // A regression guard with teeth: if register() stops sending these, the daemon
  // silently treats every agent as pre-handshake and the skew banner goes dark.
  const client = await fs.promises.readFile(EXT_CLIENT, "utf8");
  // `harness` defaults to "pi"; `mpt agent` passes its own.
  for (const field of ["protocolVersion: PROTOCOL_VERSION", "harness: this.harness", 'this.harness = options?.harness ?? "pi"', "harnessVersion:"]) {
    assertMatch(
      client,
      new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `client.ts register() should send ${field}`,
    );
  }
});
