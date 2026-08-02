/**
 * daemon/cron.ts — Minimal 5-field cron parser for Scheduled WorkDefs.
 *
 * Vendored (rather than adding a dependency) per the refactor plan. Supports the
 * standard 5 fields `MIN HOUR DOM MON DOW` with `*`, lists (`a,b`), ranges
 * (`a-b`), and steps (`* /n`, `a-b/n`). Day-of-week 0 or 7 = Sunday. Matching is
 * minute-granular; the scheduler dedupes multiple ticks within one minute.
 */

/** Parse one cron field into the set of matching integer values in [min,max]. */
function parseField(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart ? parseInt(stepPart, 10) : 1;
    if (!Number.isFinite(step) || step < 1) return null;

    let lo = min;
    let hi = max;
    if (rangePart && rangePart !== "*") {
      const bounds = rangePart.split("-");
      lo = parseInt(bounds[0]!, 10);
      hi = bounds.length > 1 ? parseInt(bounds[1]!, 10) : lo;
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
      if (lo < min || hi > max || lo > hi) return null;
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values.size > 0 ? values : null;
}

interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** True when both DOM and DOW are restricted (cron ORs them in that case). */
  domRestricted: boolean;
  dowRestricted: boolean;
}

/** Parse a 5-field cron expression. Returns null when malformed. */
export function parseCron(expr: string): ParsedCron | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minute = parseField(fields[0]!, 0, 59);
  const hour = parseField(fields[1]!, 0, 23);
  const dom = parseField(fields[2]!, 1, 31);
  const month = parseField(fields[3]!, 1, 12);
  let dow = parseField(fields[4]!, 0, 7);
  if (!minute || !hour || !dom || !month || !dow) return null;
  // Normalize Sunday (7 -> 0).
  if (dow.has(7)) { dow = new Set(dow); dow.add(0); dow.delete(7); }
  return {
    minute, hour, dom, month, dow,
    domRestricted: fields[2] !== "*",
    dowRestricted: fields[4] !== "*",
  };
}

/** Does `date` (local time) match the cron expression? */
export function cronMatches(expr: string, date: Date): boolean {
  const p = parseCron(expr);
  if (!p) return false;
  if (!p.minute.has(date.getMinutes())) return false;
  if (!p.hour.has(date.getHours())) return false;
  if (!p.month.has(date.getMonth() + 1)) return false;

  const domOk = p.dom.has(date.getDate());
  const dowOk = p.dow.has(date.getDay());
  // Standard cron rule: if both DOM and DOW are restricted, match either.
  if (p.domRestricted && p.dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

/** Is the cron valid? */
export function isValidCron(expr: string): boolean {
  return parseCron(expr) !== null;
}

/**
 * Should a scheduled item fire at `now`? True when `now` matches the cron and we
 * haven't already fired within this same minute (deduped via `lastEnqueuedAt`).
 */
export function isCronDue(expr: string, now: Date, lastEnqueuedAt?: string): boolean {
  if (!cronMatches(expr, now)) return false;
  if (!lastEnqueuedAt) return true;
  const last = new Date(lastEnqueuedAt);
  if (isNaN(last.getTime())) return true;
  // Dedupe to one fire per calendar minute.
  return Math.floor(last.getTime() / 60000) < Math.floor(now.getTime() / 60000);
}
