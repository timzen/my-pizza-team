/**
 * shared/util.ts — Tiny, dependency-free helpers used across the daemon, the CLI,
 * `mpt agent` and the scripts.
 *
 * Each of these used to be redefined (or written out inline) in every module that
 * needed it; this is the one definition. Keep this file to small, pure helpers
 * with no imports — anything with I/O or domain knowledge belongs elsewhere.
 *
 * The UI (`ui/src/`) and the Pi extension (`harnesses/pi/src/`) can't import
 * `shared/` yet, so they keep their own copies for now.
 */

/**
 * Whether `v` is a non-null, non-array object — the shape a JSON object parses to.
 * Use it to narrow `unknown` (parsed JSON, plugin config) before reading keys.
 */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The message of a caught value: an `Error`'s `message`, anything else stringified.
 * Use it in `catch (e)` blocks, where `e` is `unknown` and may not be an `Error`.
 */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
