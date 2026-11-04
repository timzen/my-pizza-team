/**
 * shared/env-file.ts — The agent environment file (`agentEnvFile`): parse it, find it, load it.
 *
 * A team can name a file of environment variables every agent window should get
 * (`TeamConfig.agentEnvFile`) — credentials switches, account ids, anything an
 * agent's tools need that the daemon's own environment may not carry. The daemon
 * runs under systemd/launchd with a bare environment and talks to a tmux server
 * that may have been started weeks ago, so neither "export it in your shell rc"
 * nor "the tmux server's environment" reliably reaches a freshly spawned
 * teammate. Instead the file is re-read each time a window opens and its
 * variables are handed to that window explicitly (`tmux new-window -e`), so an
 * edit applies to the next teammate with no restart (docs/DESIGN.md "The Agent
 * Environment Is a File").
 *
 * The syntax is systemd's `EnvironmentFile=` (so `mpt install` can point the
 * unit at the same file): one `KEY=value` per line; `#` and `;` start a comment
 * line; blank lines are skipped; whitespace around the key and an unquoted
 * value is trimmed; a value may be wrapped in matching single or double quotes,
 * which are removed. There is **no** shell expansion (`$HOME` stays `$HOME`),
 * no `export` keyword, and no multi-line values.
 *
 * A bad file is all-or-nothing: any invalid line makes the whole file unusable
 * (`problem` set, no variables), and windows open without it rather than with
 * half of it. Values are never put in a message — they may be secrets; key
 * names and line numbers are fine.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** One invalid line, 1-based, with what is wrong (never the line's text — it may hold a secret). */
export interface EnvFileError {
  line: number;
  message: string;
}

/** The result of parsing env-file text: the variables in file order (last wins on repeats) and any invalid lines. */
export interface ParsedEnvFile {
  vars: Record<string, string>;
  errors: EnvFileError[];
}

/** What a key must look like: a portable environment variable name. */
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parse env-file text (systemd `EnvironmentFile=` syntax; see the header).
 * Never throws: every invalid line is reported in `errors` with its line number,
 * and valid lines still land in `vars` so a caller can count them.
 */
export function parseEnvFile(text: string): ParsedEnvFile {
  const vars: Record<string, string> = {};
  const errors: EnvFileError[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    // CRLF files: the \r is line ending, not value.
    const line = lines[i]!.replace(/\r$/, "").trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;

    const eq = line.indexOf("=");
    if (eq < 0) {
      errors.push({ line: lineNo, message: "expected KEY=value (no '=' found)" });
      continue;
    }
    const key = line.slice(0, eq).trim();
    if (!KEY_PATTERN.test(key)) {
      errors.push({
        line: lineNo,
        message: /^export\s/.test(key)
          ? `invalid key ${JSON.stringify(key)}: drop the 'export' (the file is KEY=value, not shell)`
          : `invalid key ${JSON.stringify(key)}: use letters, digits and '_', not starting with a digit`,
      });
      continue;
    }

    // Only the first '=' splits: everything after it (more '='s included) is the value.
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if (quote === `"` || quote === `'`) {
      if (value.length < 2 || value[value.length - 1] !== quote) {
        errors.push({ line: lineNo, message: `unterminated ${quote === `"` ? "double" : "single"} quote in the value of ${key}` });
        continue;
      }
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return { vars, errors };
}

/**
 * The absolute path `agentEnvFile` names: `~` (or `~/…`) expanded to the home
 * directory, a relative path resolved against the team directory (where
 * config.json lives), an absolute one as is.
 */
export function resolveEnvFilePath(file: string, teamDir: string, home: string = os.homedir()): string {
  const trimmed = file.trim();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/")) return path.join(home, trimmed.slice(2));
  return path.resolve(teamDir, trimmed);
}

/** The agent env as loaded for one window: where it came from, what to pass, and why not, if not. */
export interface AgentEnv {
  /** The resolved file path, or null when `agentEnvFile` is unset. */
  path: string | null;
  /** The variables to give the window. Empty when unset or when the file has a problem. */
  vars: Record<string, string>;
  /** Key names the file defines (also when it has errors), for doctor and logs. Never values. */
  keys: string[];
  /** Why the file can't be used (missing, unreadable, invalid lines), or null when it can (or is unset). */
  problem: string | null;
}

/** At most this many invalid lines are named in a `problem`; the rest are counted. */
const MAX_REPORTED_ERRORS = 3;

/**
 * Read and parse the team's agent env file, now. Called each time a window
 * opens, so edits apply to the next window with no restart. Never throws: a
 * missing, unreadable or invalid file comes back as `problem` with no `vars`,
 * and the caller opens the window without it (and says so).
 */
export function loadAgentEnv(
  config: { agentEnvFile?: string },
  teamDir: string,
  home: string = os.homedir(),
): AgentEnv {
  const setting = typeof config.agentEnvFile === "string" ? config.agentEnvFile.trim() : "";
  if (!setting) return { path: null, vars: {}, keys: [], problem: null };
  const file = resolveEnvFilePath(setting, teamDir, home);

  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    const problem = code === "ENOENT"
      ? `${file} does not exist`
      : code === "EISDIR"
      ? `${file} is a directory, not a file`
      : `${file} can't be read (${code ?? (e as Error).message})`;
    return { path: file, vars: {}, keys: [], problem };
  }

  const parsed = parseEnvFile(text);
  const keys = Object.keys(parsed.vars);
  if (parsed.errors.length > 0) {
    const shown = parsed.errors.slice(0, MAX_REPORTED_ERRORS).map((e) => `line ${e.line}: ${e.message}`).join("; ");
    const more = parsed.errors.length > MAX_REPORTED_ERRORS ? ` (and ${parsed.errors.length - MAX_REPORTED_ERRORS} more)` : "";
    return { path: file, vars: {}, keys, problem: `${file} has ${parsed.errors.length} invalid line(s) — ${shown}${more}` };
  }
  return { path: file, vars: parsed.vars, keys, problem: null };
}

/**
 * A one-line warning for a window opened without the env file it should have
 * had, or null when there's nothing to say. Names the file and the problem,
 * never a value.
 */
export function agentEnvWarning(env: AgentEnv): string | null {
  return env.problem ? `agentEnvFile not applied — ${env.problem}` : null;
}
