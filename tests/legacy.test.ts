/**
 * tests/legacy.test.ts — `mpt adopt-legacy-internal` (cli/legacy.ts) and reading an
 * old service file's environment (cli/service.ts parseServiceEnv).
 *
 * The bridge (scripts/legacy-bridge.sh) runs this once after moving an old
 * compiled-binary install onto the npm package. What matters: it records a Node
 * only when none is configured, and it re-points *only* the old service shape —
 * the bridge's own path with no entry script — keeping that service's TEAM_DIR and
 * PORT. The shell half is covered end to end in tests/e2e/legacy-bridge.test.ts.
 */

import { describe, it } from "node:test";
import { assertEquals, assertStringIncludes } from "./_assert.ts";
import { type AdoptDeps, adoptLegacyInstall } from "../cli/legacy.ts";
import { parseServiceEnv } from "../cli/service.ts";

/** An old (v0.27) systemd unit: unquoted Environment= lines. */
const OLD_UNIT = `[Service]
Type=simple
ExecStart=/usr/local/bin/mpt start
Environment=TEAM_DIR=/home/me/proj/.my-pizza-team
Environment=PORT=7500
Restart=on-failure
`;

/** An old (v0.27) launchd plist. */
const OLD_PLIST = `<plist version="1.0"><dict>
  <key>ProgramArguments</key>
    <array>
      <string>/usr/local/bin/mpt</string>
      <string>start</string>
    </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TEAM_DIR</key>
    <string>/Users/me/proj/.my-pizza-team</string>
    <key>PORT</key>
    <string>7437</string>
  </dict>
</dict></plist>`;

interface Recorder {
  deps: AdoptDeps;
  saved: string[];
  installs: Array<[string, number, string]>;
  unloads: number;
  restarts: number;
  lines: string[];
}

function recorder(over: Partial<AdoptDeps> & { configured?: string | null } = {}): Recorder {
  let configured = over.configured ?? null;
  const r: Recorder = {
    saved: [],
    installs: [],
    unloads: 0,
    restarts: 0,
    lines: [],
    deps: {
      configuredNode: () => configured,
      saveNode: (n) => { r.saved.push(n); configured = n; },
      service: () => ({ program: { node: "/usr/local/bin/mpt", entry: null }, file: "/u/mpt.service", text: OLD_UNIT }),
      sameFile: (a, b) => a === b,
      unload: async () => { r.unloads++; },
      install: async (t, p, n) => { r.installs.push([t, p, n]); },
      restart: async () => { r.restarts++; return true; },
      log: (l) => r.lines.push(l),
      ...over,
    },
  };
  return r;
}

describe("parseServiceEnv", () => {
  it("reads an old unit's unquoted Environment= lines", () => {
    assertEquals(parseServiceEnv(OLD_UNIT), { TEAM_DIR: "/home/me/proj/.my-pizza-team", PORT: "7500" });
  });

  it("reads the current quoted form, values with spaces included", () => {
    assertEquals(parseServiceEnv(`Environment="TEAM_DIR=/a b/c"\nEnvironment="PATH=/x:/y"\n`), { TEAM_DIR: "/a b/c", PATH: "/x:/y" });
  });

  it("reads a plist's EnvironmentVariables", () => {
    assertEquals(parseServiceEnv(OLD_PLIST), { TEAM_DIR: "/Users/me/proj/.my-pizza-team", PORT: "7437" });
  });
});

describe("adoptLegacyInstall", () => {
  it("saves the Node when none is configured", async () => {
    const r = recorder();
    assertEquals(await adoptLegacyInstall(["/opt/homebrew/bin/node", "/usr/local/bin/mpt"], r.deps), 0);
    assertEquals(r.saved, ["/opt/homebrew/bin/node"]);
  });

  it("keeps a Node that is already configured, and runs the service with it", async () => {
    const r = recorder({ configured: "/usr/bin/node" });
    await adoptLegacyInstall(["/opt/homebrew/bin/node", "/usr/local/bin/mpt", "service"], r.deps);
    assertEquals(r.saved, []);
    assertEquals(r.installs, [["/home/me/proj/.my-pizza-team", 7500, "/usr/bin/node"]]);
  });

  it("without `service`, leaves the service alone (the service itself ran the bridge)", async () => {
    const r = recorder();
    await adoptLegacyInstall(["/n", "/usr/local/bin/mpt"], r.deps);
    assertEquals(r.installs, []);
    assertEquals(r.unloads, 0);
  });

  it("re-points an old service that launches the bridge: unload, install with its TEAM_DIR/PORT, restart", async () => {
    const r = recorder();
    assertEquals(await adoptLegacyInstall(["/n", "/usr/local/bin/mpt", "service"], r.deps), 0);
    assertEquals(r.unloads, 1);
    assertEquals(r.installs, [["/home/me/proj/.my-pizza-team", 7500, "/n"]]);
    assertEquals(r.restarts, 1);
  });

  it("leaves a service alone that runs Node already, or another path", async () => {
    for (const program of [{ node: "/n", entry: "/pkg/dist/main.js" }, { node: "/elsewhere/mpt", entry: null }]) {
      const r = recorder({ service: () => ({ program, file: "/u/mpt.service", text: OLD_UNIT }) });
      await adoptLegacyInstall(["/n", "/usr/local/bin/mpt", "service"], r.deps);
      assertEquals(r.installs, [], JSON.stringify(program));
    }
  });

  it("no service: nothing to do", async () => {
    const r = recorder({ service: () => null });
    assertEquals(await adoptLegacyInstall(["/n", "/usr/local/bin/mpt", "service"], r.deps), 0);
    assertEquals(r.installs, []);
  });

  it("a service with no TEAM_DIR is reported, not guessed at", async () => {
    const r = recorder({ service: () => ({ program: { node: "/usr/local/bin/mpt", entry: null }, file: "/u/mpt.service", text: "ExecStart=/usr/local/bin/mpt start\n" }) });
    assertEquals(await adoptLegacyInstall(["/n", "/usr/local/bin/mpt", "service"], r.deps), 1);
    assertEquals(r.installs, []);
    assertStringIncludes(r.lines.join("\n"), "TEAM_DIR");
  });

  it("the default port when the old service set none", async () => {
    const r = recorder({ service: () => ({ program: { node: "/usr/local/bin/mpt", entry: null }, file: "/u/p", text: OLD_PLIST.replace(/<key>PORT[\s\S]*?7437<\/string>/, "") }) });
    await adoptLegacyInstall(["/n", "/usr/local/bin/mpt", "service"], r.deps);
    assertEquals(r.installs, [["/Users/me/proj/.my-pizza-team", 7437, "/n"]]);
  });

  it("missing arguments are a usage error", async () => {
    assertEquals(await adoptLegacyInstall([], recorder().deps), 2);
  });
});
