/**
 * shared/duration.ts — Parse the short duration strings config uses ("15m",
 * "7d", "1h 30m").
 *
 * The first config field that takes a duration is a poll state's `pollEvery` /
 * `pollTimeout` (shared/types.ts `WorkflowState`; docs/DESIGN.md "Polling
 * States"). Kept apart from shared/types.ts so it stays a small, pure module
 * the daemon, the UI and tests can import alike (no `node:` imports).
 */

/** Milliseconds per duration unit: seconds, minutes, hours, days, weeks. */
const UNIT_MS: Readonly<Record<string, number>> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * A duration string in milliseconds, or null when it isn't one. The grammar is
 * one or more `<integer><unit>` parts, units `s`/`m`/`h`/`d`/`w`, optionally
 * separated by spaces: `"30s"`, `"15m"`, `"1h 30m"`, `"7d"`, `"1h30m"`. A bare
 * number, a zero total, a fraction, a negative, or an unknown unit is null —
 * a duration with no unit is ambiguous, so it is refused rather than guessed.
 */
export function parseDuration(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  if (!/^(\d+\s*[smhdw]\s*)+$/.test(text)) return null;
  let total = 0;
  for (const [, n, unit] of text.matchAll(/(\d+)\s*([smhdw])/g)) total += Number(n) * UNIT_MS[unit!]!;
  return total > 0 && Number.isSafeInteger(total) ? total : null;
}
