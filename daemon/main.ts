/**
 * daemon/main.ts — Run the daemon directly from source (`deno task dev` / `start`).
 *
 * A thin entry point over daemon/start.ts, the one startup routine the `mpt` CLI
 * and the compiled binary also use — so the dev daemon is the real daemon (tmux
 * spawning and the readiness probe included). Reads TEAM_DIR, PORT, and HOST.
 */

import { resolveTeamDir, startDaemonInProcess } from "./start.ts";

if (import.meta.main) {
  await startDaemonInProcess(
    resolveTeamDir(),
    Number(Deno.env.get("PORT") ?? 7437),
    Deno.env.get("HOST") || "127.0.0.1",
  );
}
