/**
 * tests/_globals.d.ts — types `Response.json()` as `Promise<any>`, as Deno's lib did.
 *
 * Node's lib types `json()` as `Promise<unknown>`. The suites read API bodies directly
 * (`body.workItem.id`) hundreds of times, and narrowing each one would bury what the
 * tests check under casts. This file is a global augmentation, so it applies to the
 * whole `tsconfig.json` program — the same typing every file had under `deno check`.
 */

interface Response {
  json(): Promise<any>;
}

/**
 * The tests import pure helpers from ui/src/lib/, and a few of those modules also
 * notify the page via `globalThis.dispatchEvent` — a browser global that Node's lib
 * lacks (Deno's had it). The tests never call those notifiers; this only lets the
 * modules type-check under the root config.
 */
declare function dispatchEvent(event: Event): boolean;
