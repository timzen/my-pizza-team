/**
 * daemon/terminal/template.ts — harness command templates and shell quoting.
 *
 * Backend-neutral: whichever terminal backend (daemon/terminal/backend.ts) opens a
 * window, the command it runs there is a harness template from team config, filled
 * here and typed into the window's shell. Moved out of the tmux module so a second
 * backend shares it rather than copying it (docs/DESIGN.md "The Daemon Is the
 * Supervisor").
 */

/**
 * Quote a string for a POSIX shell.
 *
 * Needed only for text typed *into* a shell (`send-keys`, or a backend's equivalent). Single quotes protect
 * everything except a single quote, which is closed, escaped, and reopened — the
 * standard `'\''` dance.
 */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

// ─── Harness command templates ───────────────────────────────────────

/** Placeholders a harness spawn template may use. */
export interface TemplateVars {
  /** `{mpt}`: how to run this mpt (daemon/self.ts), for `mpt agent` teammates. Left unfilled if absent. */
  mpt?: string[];
  name: string;
  url: string;
  cwd: string;
  session: string;
  window: string;
}

/**
 * Fill a harness spawn template.
 *
 * Templates live in team config (`TeamConfig.harnesses`) rather than in extension
 * code, which is what makes adding a harness a config change instead of a release
 * (DESIGN.md "The Daemon Is the Supervisor"). Substitution is literal: the result is typed into a shell by the terminal backend,
 * and values that need quoting are quoted by the caller.
 */
export function renderTemplate(template: string, vars: TemplateVars): string {
  const filled = vars.mpt ? template.replaceAll("{mpt}", vars.mpt.map(shellQuote).join(" ")) : template;
  return filled
    .replaceAll("{name}", vars.name)
    .replaceAll("{url}", vars.url)
    .replaceAll("{cwd}", shellQuote(vars.cwd))
    .replaceAll("{session}", vars.session)
    .replaceAll("{window}", vars.window);
}

/** Unfilled placeholders, so a typo in config is reported instead of run. */
export function unresolvedPlaceholders(rendered: string): string[] {
  return [...rendered.matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => m[0]);
}
