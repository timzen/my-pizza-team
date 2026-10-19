/**
 * daemon/main.ts — Run the daemon directly from source (`node daemon/main.ts`, `npm run dev` / `start`).
 *
 * A thin entry point over daemon/start.ts, the one startup routine the `mpt` CLI
 * (and so the npm package) also uses — so the dev daemon is the real daemon (tmux
 * spawning and the readiness probe included). Reads TEAM_DIR, PORT, and HOST.
 */

import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveTeamDir, startDaemonInProcess } from "./start.ts";

/** Is this module the entry script (`node daemon/main.ts`), not an import? */
function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  await startDaemonInProcess(
    resolveTeamDir(),
    Number(process.env["PORT"] ?? 7437),
    process.env["HOST"] || "127.0.0.1",
  );
}
