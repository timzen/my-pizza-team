/**
 * daemon/plugins/spec.ts — Parse plugin package specs from `TeamConfig.packages`.
 * See docs/DESIGN.md "Plugin packages" and TODO.md "Work Sources as plugins —
 * package loading".
 *
 * Pure (no file system, no network): a spec string becomes a discriminated
 * union — npm, git, or local — with an **identity** used to dedupe equivalent
 * declarations, the way pi does for its packages: the npm name, the git URL
 * without the ref, or the resolved absolute path. Bad input is a returned
 * error, never a throw, so one malformed entry in config.json can't stop the
 * daemon from starting; the loader logs it and moves on.
 */

import * as os from "node:os";
import * as path from "node:path";

/** `npm:<name>[@version]`. */
export interface NpmPackageSpec {
  kind: "npm";
  /** The spec as written. */
  raw: string;
  /** The package name, e.g. `@acme/mpt-jira`. */
  name: string;
  /** The version or range after the name's `@`, if any. */
  version?: string;
  /** Dedupe key: the package name. */
  identity: string;
}

/** A git repository: `git:<host>/<path>`, `https://…`, or `ssh://…`, each with an optional `@ref`. */
export interface GitPackageSpec {
  kind: "git";
  raw: string;
  /** The URL to clone, without the ref (`git:host/path` → `https://host/path`). */
  url: string;
  /** Branch, tag, or commit after the final `@`, if any. */
  ref?: string;
  /** Dedupe key: the clone URL without the ref, a trailing `.git`, or a trailing `/`. */
  identity: string;
}

/** A package on disk, loaded in place. */
export interface LocalPackageSpec {
  kind: "local";
  raw: string;
  /** The resolved absolute path (`~` expanded, relative to the team dir). */
  path: string;
  /** Dedupe key: the resolved absolute path. */
  identity: string;
}

export type PackageSpec = NpmPackageSpec | GitPackageSpec | LocalPackageSpec;

/** The outcome of parsing one spec: the spec, or why it's invalid. */
export type SpecParseResult = { ok: true; spec: PackageSpec } | { ok: false; error: string };

/**
 * npm's package-name rule (lowercase, URL-safe, optionally `@scope/`), so a
 * typo is caught here rather than as an opaque `npm install` failure.
 */
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

/** A git ref: no whitespace, no `..`, not starting with `-` (refuses option injection into git). */
const GIT_REF = /^(?!-)(?!.*\.\.)[^\s~^:?*[\\]+$/;

/**
 * Parse one package spec. `teamDir` anchors relative local paths (the specs
 * live in the team's config.json). Never throws.
 */
export function parsePackageSpec(raw: string, teamDir: string): SpecParseResult {
  if (typeof raw !== "string") return fail(raw, "a package spec must be a string");
  const spec = raw.trim();
  if (!spec) return fail(raw, "the package spec is empty");
  if (spec.startsWith("npm:")) return parseNpm(raw, spec.slice("npm:".length));
  if (spec.startsWith("git:")) return parseGitShorthand(raw, spec.slice("git:".length));
  if (spec.startsWith("https://") || spec.startsWith("ssh://")) return parseGitUrl(raw, spec);
  if (isLocalPath(spec)) return parseLocal(raw, spec, teamDir);
  return fail(raw, "expected npm:<name>[@version], git:<host>/<path>[@ref], an https:// or ssh:// git URL, or a local path (absolute, ./, ../, ~/)");
}

/** `name[@version]`; the scope's leading `@` is part of the name, not a version separator. */
function parseNpm(raw: string, rest: string): SpecParseResult {
  const at = rest.indexOf("@", 1);
  const name = at === -1 ? rest : rest.slice(0, at);
  const version = at === -1 ? undefined : rest.slice(at + 1);
  if (!name) return fail(raw, "npm: needs a package name");
  if (!NPM_NAME.test(name)) return fail(raw, `"${name}" is not a valid npm package name`);
  if (version !== undefined && (!version || /\s/.test(version))) return fail(raw, "the version after @ is empty or has spaces");
  return { ok: true, spec: { kind: "npm", raw, name, ...(version ? { version } : {}), identity: name } };
}

/** `git:<host>/<path>[@ref]` — shorthand for `https://<host>/<path>`. */
function parseGitShorthand(raw: string, rest: string): SpecParseResult {
  if (rest.startsWith("/")) return fail(raw, "git: takes <host>/<path> with no slashes before the host (use ssh:// or https:// for a full URL)");
  const { location, ref } = splitRef(rest, 0);
  const slash = location.indexOf("/");
  if (slash <= 0 || slash === location.length - 1) return fail(raw, "git: needs <host>/<path>, e.g. git:github.com/acme/mpt-jira");
  return gitSpec(raw, `https://${location}`, ref);
}

/** A full `https://` or `ssh://` URL, with an optional `@ref` after the path. */
function parseGitUrl(raw: string, spec: string): SpecParseResult {
  const scheme = spec.slice(0, spec.indexOf("://") + 3);
  // The ref's `@` is the last one *in the path*: `ssh://git@host/...` has one in the authority.
  const pathStart = spec.indexOf("/", scheme.length);
  if (pathStart === -1 || pathStart === scheme.length) return fail(raw, "the git URL needs a host and a repository path");
  const { location, ref } = splitRef(spec, pathStart);
  if (location.length <= pathStart + 1) return fail(raw, "the git URL needs a repository path after the host");
  return gitSpec(raw, location, ref);
}

/** Split `…@ref` off, looking for the last `@` at or after `from`. */
function splitRef(s: string, from: number): { location: string; ref?: string } {
  const at = s.lastIndexOf("@");
  if (at < from || at === -1) return { location: s };
  return { location: s.slice(0, at), ref: s.slice(at + 1) };
}

function gitSpec(raw: string, url: string, ref: string | undefined): SpecParseResult {
  if (ref !== undefined && !GIT_REF.test(ref)) return fail(raw, ref ? `"${ref}" is not a valid git ref` : "the ref after @ is empty");
  try {
    new URL(url);
  } catch {
    return fail(raw, `"${url}" is not a valid URL`);
  }
  const identity = url.replace(/\/+$/, "").replace(/\.git$/, "");
  return { ok: true, spec: { kind: "git", raw, url, ...(ref ? { ref } : {}), identity } };
}

/** Local paths must be explicit, so a bare word is never mistaken for one. */
function isLocalPath(spec: string): boolean {
  return path.isAbsolute(spec) || spec === "." || spec === ".." || spec === "~"
    || spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("~/");
}

function parseLocal(raw: string, spec: string, teamDir: string): SpecParseResult {
  const expanded = spec === "~" ? os.homedir() : spec.startsWith("~/") ? path.join(os.homedir(), spec.slice(2)) : spec;
  const resolved = path.resolve(teamDir, expanded);
  return { ok: true, spec: { kind: "local", raw, path: resolved, identity: resolved } };
}

function fail(raw: unknown, why: string): SpecParseResult {
  return { ok: false, error: `Invalid package spec ${JSON.stringify(raw)}: ${why}` };
}

/** A valid `packages` entry: its parsed spec and its per-plugin settings (`{}` when none). */
export interface ParsedPackageEntry {
  spec: PackageSpec;
  config: Record<string, unknown>;
}

/** A rejected `packages` entry: what was written, its identity when it parsed (a duplicate), and why. */
export interface RejectedPackageEntry {
  /** The spec as written (the `source` of the object form), or the entry as JSON when it has none. */
  raw: string;
  /** Set for a duplicate: the identity it shares with an earlier entry. */
  identity?: string;
  error: string;
}

/** Every valid entry of a `packages` array (deduped by identity), and an error per rejected one. */
export interface ParsedPackages {
  packages: ParsedPackageEntry[];
  /** One message per rejected entry, in order (the messages of `rejected`). */
  errors: string[];
  /** The rejected entries, structured, for the loader's per-package status (daemon/plugins/loader.ts). */
  rejected: RejectedPackageEntry[];
}

/**
 * Parse a team's `packages` (as read from config.json, so untyped): each entry
 * a spec string or `{ source, config? }`. Invalid entries and later duplicates
 * of an identity are reported in `errors` and skipped — the first declaration
 * wins — so the rest still load. Never throws.
 */
export function parsePackageEntries(entries: unknown, teamDir: string): ParsedPackages {
  const out: ParsedPackages = { packages: [], errors: [], rejected: [] };
  const reject = (r: RejectedPackageEntry) => {
    out.rejected.push(r);
    out.errors.push(r.error);
  };
  if (entries === undefined || entries === null) return out;
  if (!Array.isArray(entries)) {
    reject({ raw: JSON.stringify(entries), error: "config packages must be an array of package specs" });
    return out;
  }
  const seen = new Map<string, string>();
  for (const entry of entries) {
    const parsed = parseEntry(entry, teamDir);
    if ("error" in parsed) {
      reject({ raw: rawOf(entry), error: parsed.error });
      continue;
    }
    const first = seen.get(parsed.spec.identity);
    if (first !== undefined) {
      reject({
        raw: parsed.spec.raw,
        identity: parsed.spec.identity,
        error: `Duplicate package ${JSON.stringify(parsed.spec.raw)}: same package as ${JSON.stringify(first)}; ignored`,
      });
      continue;
    }
    seen.set(parsed.spec.identity, parsed.spec.raw);
    out.packages.push(parsed);
  }
  return out;
}

/** An entry's spec as written: the string, the object form's `source`, else the entry as JSON. */
function rawOf(entry: unknown): string {
  if (typeof entry === "string") return entry;
  if (isPlainObject(entry) && typeof entry.source === "string") return entry.source;
  return JSON.stringify(entry) ?? String(entry);
}

/** One entry: a string, or `{ source, config? }` with `config` a plain object. */
function parseEntry(entry: unknown, teamDir: string): ParsedPackageEntry | { error: string } {
  if (typeof entry === "string") {
    const r = parsePackageSpec(entry, teamDir);
    return r.ok ? { spec: r.spec, config: {} } : { error: r.error };
  }
  if (!isPlainObject(entry) || typeof entry.source !== "string") {
    return { error: `Invalid package entry ${JSON.stringify(entry)}: expected a spec string or { "source": "<spec>", "config": { ... } }` };
  }
  if (entry.config !== undefined && !isPlainObject(entry.config)) {
    return { error: `Invalid package entry for ${JSON.stringify(entry.source)}: "config" must be an object` };
  }
  const r = parsePackageSpec(entry.source, teamDir);
  if (!r.ok) return { error: r.error };
  return { spec: r.spec, config: entry.config ?? {} };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
