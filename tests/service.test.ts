/**
 * tests/service.test.ts — Unit tests for the service installer module.
 *
 * Tests plist/systemd unit generation and parsing without installing anything
 * (we never call launchctl/systemctl here): the service must launch
 * `<configured node> <entry> start`, and detectInstalledService must read back
 * exactly what was written.
 */

import { assertEquals, assertStringIncludes } from "./_assert.ts";
import { describe, it } from "node:test";
import {
  generateLaunchdPlist,
  generateSystemdUnit,
  parsePlistProgram,
  parseSystemdProgram,
  serviceProgramArguments,
} from "../cli/service.ts";
import { cliEntryScript } from "../shared/paths.ts";

const NODE = "/opt/homebrew/bin/node";

describe("service installer", () => {
  it("module imports without error", async () => {
    const mod = await import("../cli/service.ts");
    assertEquals(typeof mod.install, "function");
    assertEquals(typeof mod.uninstall, "function");
  });

  it("runs the configured Node, as given, with this copy's entry", () => {
    assertEquals(serviceProgramArguments(NODE), [NODE, cliEntryScript(), "start"]);
    assertEquals(serviceProgramArguments(NODE, "/pkg/dist/main.js"), [NODE, "/pkg/dist/main.js", "start"]);
  });

  it("generates a launchd plist with the configured Node, and parses it back", () => {
    const plist = generateLaunchdPlist({ teamDir: "/tmp/test-team", port: 7437, logDir: "/tmp/test-logs", node: NODE, entry: "/pkg/dist/main.js" });
    assertStringIncludes(plist, "com.my-pizza-team.daemon");
    assertStringIncludes(plist, `      <string>${NODE}</string>\n      <string>/pkg/dist/main.js</string>\n      <string>start</string>`);
    assertStringIncludes(plist, "<string>/tmp/test-team</string>");
    assertStringIncludes(plist, "<string>7437</string>");
    assertEquals(parsePlistProgram(plist), { node: NODE, entry: "/pkg/dist/main.js" });
  });

  it("generates a systemd unit with the configured Node, and parses it back", () => {
    const unit = generateSystemdUnit({ teamDir: "/tmp/test-team", port: 7437, node: NODE, entry: "/pkg/dist/main.js" });
    assertStringIncludes(unit, `ExecStart=${NODE} /pkg/dist/main.js start`);
    assertStringIncludes(unit, `Environment="TEAM_DIR=/tmp/test-team"`);
    assertStringIncludes(unit, `Environment="PORT=7437"`);
    assertStringIncludes(unit, "WantedBy=default.target");
    assertStringIncludes(unit, "Restart=on-failure");
    assertEquals(parseSystemdProgram(unit), { node: NODE, entry: "/pkg/dist/main.js" });
  });

  it("quotes paths with spaces in ExecStart and parses them back", () => {
    const node = "/Users/me/my tools/node";
    const unit = generateSystemdUnit({ teamDir: "/t", port: 1, node, entry: "/p q/dist/main.js" });
    assertStringIncludes(unit, `ExecStart="${node}" "/p q/dist/main.js" start`);
    assertEquals(parseSystemdProgram(unit), { node, entry: "/p q/dist/main.js" });
  });

  it("an old compiled-binary service parses with no entry", () => {
    assertEquals(parseSystemdProgram("[Service]\nExecStart=/usr/local/bin/mpt start\n"), { node: "/usr/local/bin/mpt", entry: null });
  });
});
