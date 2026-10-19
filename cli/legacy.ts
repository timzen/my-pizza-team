/**
 * cli/legacy.ts — `mpt adopt-legacy-internal`: the TypeScript half of the bridge
 * that moves an old compiled-binary install (<= 0.27) onto the npm package.
 *
 * scripts/legacy-bridge.sh is published under the old binary asset names, so the
 * old binary's `mpt upgrade` installs it in the binary's place. After it has found
 * a Node and installed the package, it runs this (once) to finish what
 * `mpt setup` + `mpt install` would have done by hand:
 *
 *   - record the Node it found as the Node that runs mpt, unless one is already
 *     configured (shared/runtime-config.ts);
 *   - when asked (`service`: the bridge was run from a terminal, not by the
 *     service itself), re-point an old service that launches the bridge's path
 *     (`[<path>, "start"]`, no entry script) at `<node> <entry> start`, keeping
 *     its TEAM_DIR and PORT, and restart it on the new code.
 *
 * Re-pointing matters most when npm's own `mpt` link took the bridge's path: that
 * link is `#!/usr/bin/env node`, and the old service's bare PATH has no Node. See
 * docs/DESIGN.md "Moving Old Binaries Across".
 *
 * Side effects go through `AdoptDeps` so tests drive it without a real service.
 */

import * as fs from "node:fs";
import { configuredNode, sameFile, saveConfiguredNode } from "../shared/runtime-config.ts";
import {
  detectInstalledService,
  install,
  installedServiceFile,
  parseServiceEnv,
  restartSystemdService,
  type ServiceProgram,
  unloadServiceForRewrite,
} from "./service.ts";

/** The default daemon port (cli/main.ts getPort). */
const DEFAULT_PORT = 7437;

/** Side effects of adopting a legacy install (stubbed in tests). */
export interface AdoptDeps {
  configuredNode: () => string | null;
  saveNode: (node: string) => void;
  /** What the installed service launches, and its file's text; null when there is no service. */
  service: () => { program: ServiceProgram | null; file: string; text: string } | null;
  sameFile: (a: string, b: string) => boolean;
  unload: () => Promise<void>;
  install: (teamDir: string, port: number, node: string) => Promise<void>;
  /** Restart after the rewrite, where install() doesn't already (systemd). */
  restart: () => Promise<boolean>;
  log: (line: string) => void;
}

/** The real side effects. */
export function defaultAdoptDeps(): AdoptDeps {
  return {
    configuredNode: () => configuredNode()?.path ?? null,
    saveNode: (node) => saveConfiguredNode(node),
    service: () => {
      const file = installedServiceFile();
      if (!file) return null;
      return { program: detectInstalledService()?.programPath ?? null, file, text: fs.readFileSync(file, "utf8") };
    },
    sameFile,
    unload: unloadServiceForRewrite,
    install,
    restart: async () => process.platform === "darwin" ? true : await restartSystemdService(),
    log: (line) => console.log(line),
  };
}

/**
 * `mpt adopt-legacy-internal <node> <bridge path> [service]`. Resolves to an exit
 * code; every step is best-effort for the bridge, which works either way.
 */
export async function adoptLegacyInstall(args: string[], d: AdoptDeps = defaultAdoptDeps()): Promise<number> {
  const [node, bridge, mode] = args;
  if (!node || !bridge) {
    d.log("usage: mpt adopt-legacy-internal <node> <bridge path> [service]");
    return 2;
  }

  if (!d.configuredNode()) {
    d.saveNode(node);
    d.log(`   Saved ${node} as the Node that runs mpt (change it with  mpt setup --node <path>).`);
  }
  const nodeToRun = d.configuredNode() ?? node;

  if (mode !== "service") return 0;
  const svc = d.service();
  // Only the old shape — the bridge's path, no entry script. Anything else was set
  // up deliberately (`mpt install`) and is left alone.
  if (!svc?.program || svc.program.entry || !d.sameFile(svc.program.node, bridge)) return 0;

  const env = parseServiceEnv(svc.text);
  const teamDir = env["TEAM_DIR"];
  if (!teamDir) {
    d.log(`   ⚠️  ${svc.file} launches ${bridge} but sets no TEAM_DIR — re-point it with  mpt install  from your team's project.`);
    return 1;
  }
  const port = Number(env["PORT"]) || DEFAULT_PORT;
  d.log(`   Re-pointing the service at Node (it ran the old binary at ${bridge})…`);
  await d.unload();
  await d.install(teamDir, port, nodeToRun);
  if (!await d.restart()) d.log("   ⚠️  Couldn't restart the service — restart it to run the new version.");
  return 0;
}
