// The flag that starts Pi as a teammate, and its deprecated alias.
//
// `--ppt-teammate` is the canonical flag the daemon's built-in spawn template
// passes (shared/types.ts DEFAULT_HARNESS_TEMPLATES). `--ppt-worker` was its name
// before the "worker" persona kind became "teammate"; it is still registered, so
// a team's own customized `harnesses.pi.teammate` template that passes it keeps
// starting a teammate.
//
// DEPRECATED(worker→teammate): remove in remove-worker-aliases — the
// `ppt-worker` registration and the alias branch in `readTeammateFlag`.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The canonical teammate flag. */
export const TEAMMATE_FLAG = "ppt-teammate";

/** DEPRECATED(worker→teammate): remove in remove-worker-aliases. The old name of `--ppt-teammate`. */
export const LEGACY_TEAMMATE_FLAG = "ppt-worker";

/** The one-time warning a `--ppt-worker` launch logs. */
export const LEGACY_TEAMMATE_FLAG_WARNING = `[ppt] '--${LEGACY_TEAMMATE_FLAG}' is deprecated; use '--${TEAMMATE_FLAG}'`;

/** Has this process already warned about `--ppt-worker`? (Once per run, not per session.) */
let warned = false;

/** Register `--ppt-teammate` and its deprecated alias `--ppt-worker` (once, at extension load). */
export function registerTeammateFlags(pi: ExtensionAPI): void {
  pi.registerFlag(TEAMMATE_FLAG, {
    description: "Run as a pi-pizza-team teammate",
    type: "boolean",
    default: false,
  });
  pi.registerFlag(LEGACY_TEAMMATE_FLAG, {
    description: `Deprecated: use --${TEAMMATE_FLAG}`,
    type: "boolean",
    default: false,
  });
}

/**
 * Was Pi started as a teammate (`--ppt-teammate`, or the deprecated
 * `--ppt-worker`)? `deprecation` is the warning to show when only the alias was
 * given — set the first time per run, null after that and whenever the
 * canonical flag was used.
 */
export function readTeammateFlag(pi: Pick<ExtensionAPI, "getFlag">): { teammate: boolean; deprecation: string | null } {
  if (pi.getFlag(TEAMMATE_FLAG)) return { teammate: true, deprecation: null };
  if (!pi.getFlag(LEGACY_TEAMMATE_FLAG)) return { teammate: false, deprecation: null };
  const deprecation = warned ? null : LEGACY_TEAMMATE_FLAG_WARNING;
  warned = true;
  return { teammate: true, deprecation };
}
