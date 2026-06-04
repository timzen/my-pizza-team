/**
 * daemon/app.ts — Hono application setup and route registration.
 * All HTTP routes are mounted here.
 */

import { Hono } from "hono";

export const app = new Hono();

// Health check endpoint
app.get("/health", (c) => {
  return c.json({ status: "ok", service: "my-pizza-team" });
});
