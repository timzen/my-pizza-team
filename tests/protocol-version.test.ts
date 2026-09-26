/**
 * tests/protocol-version.test.ts — The two PROTOCOL_VERSION constants agree.
 *
 * The extension cannot yet import `shared/protocol.ts` directly: it is a separate
 * npm package that must stay publishable on its own, so it carries a local copy of
 * the constant (in client.ts, the protocol boundary). That is precisely the
 * duplication BATTERIES_INCLUDED.md §1.2 warns about, so it is enforced rather than
 * trusted — this test fails if the two drift.
 *
 * P1c-7 deletes the duplicate by having the extension import the root definition,
 * at which point this test can go too.
 */

import { assertEquals, assertMatch } from "@std/assert";
import { PROTOCOL_VERSION } from "../shared/protocol.ts";

const EXT_CLIENT = new URL("../harnesses/pi/src/runtime/client.ts", import.meta.url);

Deno.test("harnesses/pi declares the same PROTOCOL_VERSION as shared/protocol.ts", async () => {
  const src = await Deno.readTextFile(EXT_CLIENT);
  const match = src.match(/export const PROTOCOL_VERSION\s*=\s*(\d+)/);
  assertMatch(
    src,
    /export const PROTOCOL_VERSION/,
    "the extension must declare PROTOCOL_VERSION — it is sent at registration",
  );
  assertEquals(
    Number(match![1]),
    PROTOCOL_VERSION,
    "PROTOCOL_VERSION drift: harnesses/pi/src/client.ts disagrees with shared/protocol.ts. " +
      "Both halves are one protocol (§1.2) — update the extension's copy.",
  );
});

Deno.test("the extension sends the handshake at registration", async () => {
  // A regression guard with teeth: if register() stops sending these, the daemon
  // silently treats every agent as pre-handshake and the skew banner goes dark.
  const client = await Deno.readTextFile(new URL("../harnesses/pi/src/runtime/client.ts", import.meta.url));
  for (const field of ["protocolVersion: PROTOCOL_VERSION", 'harness: "pi"', "harnessVersion:"]) {
    assertMatch(
      client,
      new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `client.ts register() should send ${field}`,
    );
  }
});
