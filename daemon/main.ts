/**
 * daemon/main.ts — Entry point for the HTTP daemon.
 *
 * Starts a Hono server using Deno's native serve adapter.
 * Looks for a team directory (defaults to .pi-pizza-team in cwd)
 * and wires the Store + API routes.
 */

import { createApp } from "./app.ts";
import { TEAM_DIR } from "../shared/types.ts";
import * as path from "jsr:@std/path@^1";

const teamDir = Deno.env.get("TEAM_DIR") || path.join(Deno.cwd(), TEAM_DIR);
const port = Number(Deno.env.get("PORT") ?? 7437);

const app = createApp(teamDir);

Deno.serve({ port, hostname: "127.0.0.1" }, app.fetch);

console.log(`🍕 my-pizza-team daemon listening on http://localhost:${port}`);
