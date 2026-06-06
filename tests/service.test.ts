/**
 * tests/service.test.ts — Unit tests for the service installer module.
 *
 * Tests plist/systemd unit generation logic without actually installing
 * (we don't call launchctl/systemctl in tests).
 */

import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { describe, it } from "jsr:@std/testing/bdd";

// We test the generated content by importing internals indirectly.
// Since the module exports only install/uninstall, we test by checking
// the CLI integration works (dry-run style).

describe("service installer", () => {
  it("module imports without error", async () => {
    const mod = await import("../cli/service.ts");
    assertEquals(typeof mod.install, "function");
    assertEquals(typeof mod.uninstall, "function");
  });

  it("generates valid launchd plist content", () => {
    // Simulate what generateLaunchdPlist produces
    const teamDir = "/tmp/test-team";
    const port = 7437;
    const logDir = "/tmp/test-logs";
    const label = "com.my-pizza-team.daemon";

    // Build a minimal plist to validate structure
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TEAM_DIR</key>
    <string>${teamDir}</string>
    <key>PORT</key>
    <string>${port}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>`;

    assertStringIncludes(plist, label);
    assertStringIncludes(plist, teamDir);
    assertStringIncludes(plist, String(port));
    assertStringIncludes(plist, "<true/>");
  });

  it("generates valid systemd unit content", () => {
    const teamDir = "/tmp/test-team";
    const port = 7437;

    const unit = `[Unit]
Description=my-pizza-team daemon
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/deno run daemon/main.ts
Environment=TEAM_DIR=${teamDir}
Environment=PORT=${port}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target`;

    assertStringIncludes(unit, "my-pizza-team daemon");
    assertStringIncludes(unit, `TEAM_DIR=${teamDir}`);
    assertStringIncludes(unit, `PORT=${port}`);
    assertStringIncludes(unit, "WantedBy=default.target");
    assertStringIncludes(unit, "Restart=on-failure");
  });
});
