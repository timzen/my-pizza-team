/**
 * shared/runtime-config.ts — Which Node runs mpt: the saved setting, its overrides,
 * and the checks that a Node binary is fit to run mpt.
 *
 * mpt ships as an npm package, so "mpt" is really `<node> <package entry>`. The
 * service (launchd/systemd), teammate callbacks (`mptInvocation`) and `mpt upgrade`
 * must all agree on *which* node, and it has to keep working after the shell that
 * installed mpt is gone. So the choice is recorded once, in a user-level file:
 *
 *     ~/.config/mpt/runtime.json        { "node": "/abs/path/to/node", "chosenAt": "…" }
 *
 * (`$XDG_CONFIG_HOME/mpt/runtime.json` on Linux when that is set; `~/.config/mpt`
 * on macOS too, for simplicity.) Priority: `--node <path>` > `MPT_NODE` > the file.
 *
 * Paths are kept **as given, never symlink-resolved**: `/opt/homebrew/bin/node` is a
 * symlink into a versioned Cellar directory, and keeping the symlink is what lets
 * the service survive `brew upgrade`. Version-manager paths (nvm, fnm, volta, …)
 * pin one Node version; they work, but break when that version is removed, so they
 * are warned about rather than refused.
 *
 * Prompting for the choice lives in cli/node-choice.ts; this module only reads,
 * writes and checks, so the daemon can use it too (daemon/self.ts).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { packageRoot } from "./paths.ts";

/** The saved runtime settings. Unknown keys are preserved on write. */
export interface RuntimeConfig {
  /** Absolute path of the Node binary that runs mpt (not symlink-resolved). */
  node?: string;
  /** When `node` was chosen (ISO 8601). */
  chosenAt?: string;
  [key: string]: unknown;
}

/** Where a configured Node came from, strongest first. */
export type NodeSource = "flag" | "env" | "file";

/** A configured Node and where the setting came from. */
export interface ConfiguredNode {
  path: string;
  source: NodeSource;
}

/** Human-readable label for a NodeSource (doctor, prompts). */
export function describeNodeSource(source: NodeSource, file = runtimeConfigPath()): string {
  switch (source) {
    case "flag": return "--node";
    case "env": return "MPT_NODE";
    case "file": return file;
  }
}

/** The runtime settings file: `$XDG_CONFIG_HOME/mpt/runtime.json` on Linux if set, else `~/.config/mpt/runtime.json`. */
export function runtimeConfigPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const xdg = env["XDG_CONFIG_HOME"];
  if (platform === "linux" && xdg && path.isAbsolute(xdg)) return path.join(xdg, "mpt", "runtime.json");
  const home = env["HOME"] ?? env["USERPROFILE"] ?? ".";
  return path.join(home, ".config", "mpt", "runtime.json");
}

/** Read the settings file; `{}` when it is missing or unreadable (a broken file is treated as "nothing saved"). */
export function readRuntimeConfig(file: string = runtimeConfigPath()): RuntimeConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as RuntimeConfig : {};
  } catch {
    return {};
  }
}

/**
 * Write the settings file atomically (temp file + rename, like cli/setup.ts), so an
 * interrupted write can't leave a truncated file the service depends on.
 */
export function writeRuntimeConfig(config: RuntimeConfig, file: string = runtimeConfigPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.mpt-tmp-${crypto.randomUUID().slice(0, 8)}`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`);
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.rmSync(temp);
  }
}

/** Record `node` as the Node that runs mpt, keeping any other keys in the file. */
export function saveConfiguredNode(node: string, file: string = runtimeConfigPath(), now: Date = new Date()): void {
  writeRuntimeConfig({ ...readRuntimeConfig(file), node, chosenAt: now.toISOString() }, file);
}

// ─── The --node flag ─────────────────────────────────────────────────

let flagOverride: string | undefined;

/** Set (or clear) the `--node <path>` override for this process. cli/main.ts calls it after parsing argv. */
export function setNodeFlagOverride(node: string | undefined): void {
  flagOverride = node ? path.resolve(node) : undefined;
}

/**
 * Pull a `--node <path>` / `--node=<path>` flag out of argv. Returns the remaining
 * arguments and the path (undefined when absent). A trailing `--node` with no value
 * is an error, since silently ignoring it would install with the wrong Node.
 */
export function extractNodeFlag(argv: string[]): { args: string[]; node?: string } {
  const args: string[] = [];
  let node: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--node") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) throw new Error("--node needs a path, e.g. --node /usr/local/bin/node");
      node = value;
      i++;
    } else if (a.startsWith("--node=")) {
      node = a.slice("--node=".length);
      if (!node) throw new Error("--node needs a path, e.g. --node=/usr/local/bin/node");
    } else {
      args.push(a);
    }
  }
  return node === undefined ? { args } : { args, node };
}

/**
 * The configured Node: `--node` > `MPT_NODE` > the settings file, or null when none
 * is set. Not validated — see `checkNode`.
 */
export function configuredNode(opts: { env?: NodeJS.ProcessEnv; file?: string; flag?: string } = {}): ConfiguredNode | null {
  const flag = opts.flag ?? flagOverride;
  if (flag) return { path: path.resolve(flag), source: "flag" };
  const env = (opts.env ?? process.env)["MPT_NODE"];
  if (env) return { path: path.resolve(env), source: "env" };
  const saved = readRuntimeConfig(opts.file ?? runtimeConfigPath()).node;
  if (typeof saved === "string" && saved) return { path: saved, source: "file" };
  return null;
}

// ─── Validation ──────────────────────────────────────────────────────

/** The minimum Node version from package.json `engines.node` (`>=X[.Y[.Z]]`), as [major, minor, patch]. */
export function requiredNodeVersion(): [number, number, number] {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot(), "package.json"), "utf8"));
    const m = /^\s*>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(String(manifest?.engines?.node ?? ""));
    if (m) return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
  } catch { /* fall through to the documented minimum */ }
  return [24, 0, 0];
}

/** "24.0.0"-style rendering of `requiredNodeVersion()`. */
export function requiredNodeVersionString(): string {
  return requiredNodeVersion().join(".");
}

/** True when `version` (e.g. "24.3.1" or "v24.3.1") meets `min`. */
export function meetsVersion(version: string, min: [number, number, number] = requiredNodeVersion()): boolean {
  const parts = version.trim().replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10));
  if (parts.length === 0 || parts.some(Number.isNaN)) return false;
  for (let i = 0; i < 3; i++) {
    const d = (parts[i] ?? 0) - min[i]!;
    if (d !== 0) return d > 0;
  }
  return true;
}

/** Run `<node> -p process.versions.node`; the version string, or null when it didn't run. */
export function probeNodeVersion(node: string): string | null {
  const out = spawnSync(node, ["-p", "process.versions.node"], { encoding: "utf8", timeout: 15_000 });
  if (out.error || out.status !== 0) return null;
  const v = out.stdout.trim();
  return /^\d+\.\d+\.\d+/.test(v) ? v : null;
}

/** The outcome of checking a Node binary. */
export type NodeCheck =
  | { ok: true; version: string }
  | { ok: false; problem: string; version?: string };

/**
 * Is `node` fit to run mpt? It must exist, be an executable file, and report a
 * version meeting package.json `engines`. The path is checked as given — never
 * symlink-resolved (see the module comment).
 */
export function checkNode(node: string): NodeCheck {
  if (!path.isAbsolute(node)) return { ok: false, problem: `${node} is not an absolute path` };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(node);
  } catch {
    return { ok: false, problem: `${node} does not exist` };
  }
  if (!stat.isFile()) return { ok: false, problem: `${node} is not a file` };
  try {
    fs.accessSync(node, fs.constants.X_OK);
  } catch {
    return { ok: false, problem: `${node} is not executable` };
  }
  const version = probeNodeVersion(node);
  if (!version) return { ok: false, problem: `${node} did not report a Node version (is it Node?)` };
  if (!meetsVersion(version)) {
    return { ok: false, version, problem: `${node} is Node ${version}; mpt needs Node >=${requiredNodeVersionString()}` };
  }
  return { ok: true, version };
}

// ─── Version-pinned paths ────────────────────────────────────────────

/** Path fragments of installs that hold exactly one Node version, with the tool's name. */
const PINNED_PATTERNS: Array<{ tool: string; home: boolean; fragment: string }> = [
  { tool: "nvm", home: true, fragment: ".nvm/versions/" },
  { tool: "fnm", home: true, fragment: ".local/share/fnm/" },
  { tool: "fnm", home: true, fragment: "Library/Application Support/fnm/" },
  // fnm's per-shell symlink dirs vanish when the shell exits.
  { tool: "fnm", home: false, fragment: "/fnm_multishells/" },
  { tool: "volta", home: true, fragment: ".volta/tools/image/" },
  { tool: "asdf", home: true, fragment: ".asdf/installs/" },
  { tool: "mise", home: true, fragment: ".local/share/mise/installs/" },
  // Homebrew's versioned keg; `brew cleanup` deletes old ones. /opt/homebrew/bin/node is the stable spelling.
  { tool: "Homebrew", home: false, fragment: "/Cellar/node" },
];

/**
 * The version manager that pins `node` to one version (e.g. "nvm"), or null when
 * the path looks stable. Purely by path; the file is not touched.
 */
export function pinnedNodeManager(node: string, home: string | undefined = process.env["HOME"]): string | null {
  for (const p of PINNED_PATTERNS) {
    if (p.home) {
      if (home && node.startsWith(path.join(home, p.fragment))) return p.tool;
    } else if (node.includes(p.fragment)) {
      return p.tool;
    }
  }
  return null;
}

/** Well-known Node locations that survive upgrades, in preference order. */
export const STABLE_NODE_PATHS = [
  "/opt/homebrew/bin/node",
  "/usr/local/bin/node",
  "/home/linuxbrew/.linuxbrew/bin/node",
  "/usr/bin/node",
];

/** Every `node` on PATH, in PATH order (as spelled on PATH — not symlink-resolved). */
export function nodesOnPath(pathVar: string | undefined = process.env["PATH"]): string[] {
  const out: string[] = [];
  for (const d of (pathVar ?? "").split(path.delimiter)) {
    if (!d || !path.isAbsolute(d)) continue;
    const candidate = path.join(d, "node");
    if (fs.existsSync(candidate) && !out.includes(candidate)) out.push(candidate);
  }
  return out;
}

/**
 * The first stable Node location that exists and passes `checkNode`, or null.
 * `check` is injectable for tests.
 */
export function stableNodeAlternative(
  candidates: string[] = STABLE_NODE_PATHS,
  check: (node: string) => NodeCheck = checkNode,
): string | null {
  for (const c of candidates) {
    if (check(c).ok) return c;
  }
  return null;
}

/** The warning for a version-pinned Node, or null when `node` isn't pinned. */
export function pinnedNodeWarning(node: string, stable: string | null, home?: string): string | null {
  const tool = pinnedNodeManager(node, home);
  if (!tool) return null;
  const suggestion = stable
    ? ` A stable path is available: ${stable} (use it with \`--node ${stable}\`).`
    : " Prefer a Node installed at a stable path (e.g. /opt/homebrew/bin/node, /usr/local/bin/node, /usr/bin/node).";
  return `${node} is pinned to one Node version by ${tool}; the mpt service breaks if that version is removed.${suggestion}`;
}

/** Do two paths name the same file (following symlinks)? Falls back to comparing resolved paths. */
export function sameFile(a: string, b: string): boolean {
  const real = (p: string) => {
    try { return fs.realpathSync(p); } catch { return path.resolve(p); }
  };
  return real(a) === real(b);
}

/**
 * The Node to suggest when nothing is configured: the running `execPath`, unless a
 * stable spelling of the same binary exists — a `node` on PATH or a well-known
 * location that links to it (Node reports `execPath` symlink-resolved, so a
 * Homebrew install shows up as its versioned Cellar path) — or `execPath` is
 * version-pinned and another stable Node works.
 */
export function suggestedNode(
  execPath: string = process.execPath,
  opts: { candidates?: string[]; check?: (node: string) => NodeCheck; home?: string; pathVar?: string } = {},
): string {
  const home = opts.home ?? process.env["HOME"];
  const candidates = opts.candidates ?? STABLE_NODE_PATHS;
  const spellings = [...nodesOnPath(opts.pathVar ?? process.env["PATH"]), ...candidates]
    .filter((c) => !pinnedNodeManager(c, home));
  const same = spellings.find((c) => fs.existsSync(c) && sameFile(c, execPath));
  if (same) return same;
  if (pinnedNodeManager(execPath, home)) {
    return stableNodeAlternative(candidates, opts.check) ?? execPath;
  }
  return execPath;
}
