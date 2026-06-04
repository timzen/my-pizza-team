/**
 * daemon/main.ts — Entry point for the HTTP daemon.
 * Starts a Hono server using Deno's native serve adapter.
 */

import { app } from "./app.ts";

const port = Number(Deno.env.get("PORT") ?? 3000);

Deno.serve({ port }, app.fetch);

console.log(`🍕 my-pizza-team daemon listening on http://localhost:${port}`);
