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

  it("with agentEnvFile, the systemd unit reads it (optional, % escaped); without, no line", () => {
    const withFile = generateSystemdUnit({ teamDir: "/t", port: 1, node: NODE, entry: "/e.js", envFile: "/home/u/.config/mpt/env" });
    assertStringIncludes(withFile, "\nEnvironmentFile=-/home/u/.config/mpt/env\n");
    // Inside [Service], after the Environment= lines.
    assertEquals(withFile.indexOf("EnvironmentFile=") > withFile.indexOf("[Service]"), true);
    assertEquals(withFile.indexOf("EnvironmentFile=") < withFile.indexOf("[Install]"), true);
    assertStringIncludes(generateSystemdUnit({ teamDir: "/t", port: 1, node: NODE, envFile: "/a%b/env" }), "EnvironmentFile=-/a%%b/env");
    assertEquals(generateSystemdUnit({ teamDir: "/t", port: 1, node: NODE }).includes("EnvironmentFile"), false);
    assertEquals(generateSystemdUnit({ teamDir: "/t", port: 1, node: NODE, envFile: null }).includes("EnvironmentFile"), false);
    assertEquals(parseSystemdProgram(withFile), { node: NODE, entry: "/e.js" });
  });

  it("with agentEnvFile, the launchd plist carries its variables, XML-escaped", () => {
    const plist = generateLaunchdPlist({
      teamDir: "/t", port: 1, logDir: "/l", node: NODE, entry: "/e.js",
      agentEnv: { OUTLOOK_MCP_ENABLE_WRITES: "true", Q: "a<b&c" },
    });
    assertStringIncludes(plist, "<key>OUTLOOK_MCP_ENABLE_WRITES</key>\n    <string>true</string>");
    assertStringIncludes(plist, "<string>a&lt;b&amp;c</string>");
    assertStringIncludes(plist, "<key>TEAM_DIR</key>");
    assertEquals(parsePlistProgram(plist), { node: NODE, entry: "/e.js" });
  });

  it("with a wrapper, both service files prefix the same argv and parse it back", () => {
    const wrapper = "/opt/wrap/run-mpt";
    assertEquals(serviceProgramArguments(NODE, "/pkg/dist/main.js", wrapper), [wrapper, NODE, "/pkg/dist/main.js", "start"]);
    assertEquals(serviceProgramArguments(NODE, "/pkg/dist/main.js", null), [NODE, "/pkg/dist/main.js", "start"]);
    const unit = generateSystemdUnit({ teamDir: "/t", port: 1, node: NODE, entry: "/pkg/dist/main.js", wrapper });
    assertStringIncludes(unit, `ExecStart=${wrapper} ${NODE} /pkg/dist/main.js start\n`);
    assertEquals(parseSystemdProgram(unit), { wrapper, node: NODE, entry: "/pkg/dist/main.js" });
    const plist = generateLaunchdPlist({ teamDir: "/t", port: 1, logDir: "/l", node: NODE, entry: "/pkg/dist/main.js", wrapper });
    assertStringIncludes(plist, `    <array>\n      <string>${wrapper}</string>\n      <string>${NODE}</string>\n      <string>/pkg/dist/main.js</string>\n      <string>start</string>\n    </array>`);
    assertEquals(parsePlistProgram(plist), { wrapper, node: NODE, entry: "/pkg/dist/main.js" });
  });

  it("with no wrapper, the service files are exactly the unwrapped ones", () => {
    const base = { teamDir: "/t", port: 1, node: NODE, entry: "/e.js" };
    assertEquals(generateSystemdUnit({ ...base, wrapper: null }), generateSystemdUnit(base));
    assertEquals(generateSystemdUnit({ ...base, wrapper: "" }), generateSystemdUnit(base));
    assertEquals(generateLaunchdPlist({ ...base, logDir: "/l", wrapper: null }), generateLaunchdPlist({ ...base, logDir: "/l" }));
  });

  it("quotes a wrapper path with spaces in ExecStart and parses it back", () => {
    const wrapper = "/Users/me/my scripts/wrap";
    const node = "/Users/me/my tools/node";
    const unit = generateSystemdUnit({ teamDir: "/t", port: 1, node, entry: "/p q/dist/main.js", wrapper });
    assertStringIncludes(unit, `ExecStart="${wrapper}" "${node}" "/p q/dist/main.js" start\n`);
    assertEquals(parseSystemdProgram(unit), { wrapper, node, entry: "/p q/dist/main.js" });
    const plist = generateLaunchdPlist({ teamDir: "/t", port: 1, logDir: "/l", node, entry: "/p q/dist/main.js", wrapper });
    assertEquals(parsePlistProgram(plist), { wrapper, node, entry: "/p q/dist/main.js" });
  });

  it("a wrapper that is itself a script still parses (the entry is what's third)", () => {
    const unit = generateSystemdUnit({ teamDir: "/t", port: 1, node: NODE, entry: "/pkg/cli/main.ts", wrapper: "/w/wrap.js" });
    assertEquals(parseSystemdProgram(unit), { wrapper: "/w/wrap.js", node: NODE, entry: "/pkg/cli/main.ts" });
  });

  it("an old compiled-binary service parses with no entry", () => {
    assertEquals(parseSystemdProgram("[Service]\nExecStart=/usr/local/bin/mpt start\n"), { node: "/usr/local/bin/mpt", entry: null });
  });
});
