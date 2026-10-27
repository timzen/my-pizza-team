/**
 * daemon/plugins/host-resolve.ts — Resolve plugins' `my-pizza-team/plugin` imports to this daemon.
 * See docs/DESIGN.md "Plugin packages" ("Host types").
 *
 * A plugin declares `"peerDependencies": { "my-pizza-team": "*" }` and is
 * installed with `--omit=peer` (or loaded in place from a folder that never
 * installed it), so Node alone would fail to find `my-pizza-team/plugin` — or,
 * worse, find a different copy with different constants. Like pi, which maps
 * its extensions' imports of its own packages to the running pi, the daemon
 * registers a module resolve hook (`module.registerHooks`, in-thread and
 * synchronous) that answers `my-pizza-team/plugin` with the URL of the
 * running host's plugin/index module — whatever imports it, whether or not it
 * has its own copy installed. Every other specifier goes to Node's resolver.
 */

import * as module from "node:module";

/** The specifier plugin authors import the host surface from (package.json `exports["./plugin"]`). */
export const HOST_PLUGIN_SPECIFIER = "my-pizza-team/plugin";

let registered = false;

/**
 * The URL of this host's plugin surface: plugin/index.ts in a checkout (run
 * by type stripping), plugin/index.js in the published dist/. The extension
 * follows this file's own, since both are laid out (and compiled) together.
 */
export function hostPluginModuleUrl(): string {
  const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return new URL(`../../plugin/index${ext}`, import.meta.url).href;
}

/**
 * Install the resolve hook, once per process (idempotent). Call before the
 * first plugin `import()`; the loader does. Process-wide on purpose: a
 * plugin's own modules and dependencies import the host surface too.
 */
export function registerHostResolution(): void {
  if (registered) return;
  registered = true;
  const url = hostPluginModuleUrl();
  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === HOST_PLUGIN_SPECIFIER) return { url, shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });
}
