/**
 * cli/checks.ts — The check model shared by `mpt doctor` (cli/doctor.ts) and
 * `mpt plugins doctor` (cli/plugins-doctor.ts).
 *
 * Both commands produce a list of checks that are each ok, a warning, or a
 * failure, print one glyph-prefixed line per check with an optional fix/hint
 * line under it, and exit non-zero only when something failed (warnings never
 * fail — the exit code would be useless if they did). This is that one model:
 * the status type, the tally, the exit-code rule, and the line rendering.
 *
 * The two commands keep their own check *shapes* (`Check` with name/detail/fix,
 * `DoctorCheck` with message/hint — the latter is the `--json` output) and
 * their own glyph sets, so their output stays exactly as it was.
 */

/** One check's outcome. Only "fail" affects the exit code. */
export type CheckStatus = "ok" | "warn" | "fail";

/** How many checks ended in each status (key order is the `--json` summary's). */
export interface CheckCounts {
  ok: number;
  warn: number;
  fail: number;
}

/** `mpt doctor`'s glyphs (the trailing space pads the narrower warning sign). */
export const EMOJI_GLYPHS: Readonly<Record<CheckStatus, string>> = { ok: "✅", warn: "⚠️ ", fail: "❌" };

/** `mpt plugins doctor`'s glyphs. */
export const PLAIN_GLYPHS: Readonly<Record<CheckStatus, string>> = { ok: "✓", warn: "⚠", fail: "✗" };

/** Tally checks by status. Use it for a report's summary line or `--json` summary. */
export function countChecks(checks: Iterable<{ status: CheckStatus }>): CheckCounts {
  const counts: CheckCounts = { ok: 0, warn: 0, fail: 0 };
  for (const c of checks) counts[c.status]++;
  return counts;
}

/** The exit code for a tally: 1 when anything failed, else 0 (warnings don't fail). */
export function checksExitCode(counts: CheckCounts): number {
  return counts.fail > 0 ? 1 : 0;
}

/** How `checkLines` lays out one check. */
export interface CheckLineOptions {
  glyphs: Readonly<Record<CheckStatus, string>>;
  /** Prefix of the check's own line. Default "". */
  indent?: string;
  /** Prefix of the hint line under it. */
  hintIndent: string;
  /** Show a hint on an ok check as "(optional: …)" rather than dropping it. */
  optionalOkHint?: boolean;
}

/**
 * Render one check: `<indent><glyph> <text>`, then, when there is a hint, a
 * `<hintIndent>→ <hint>` line for a problem. A hint on an ok check is an
 * optional next step, not a problem: it is dropped, or (with `optionalOkHint`)
 * shown as `<hintIndent>  (optional: <hint>)`.
 */
export function checkLines(status: CheckStatus, text: string, hint: string | undefined, opts: CheckLineOptions): string[] {
  const lines = [`${opts.indent ?? ""}${opts.glyphs[status]} ${text}`];
  if (hint && status !== "ok") lines.push(`${opts.hintIndent}→ ${hint}`);
  else if (hint && opts.optionalOkHint) lines.push(`${opts.hintIndent}  (optional: ${hint})`);
  return lines;
}
