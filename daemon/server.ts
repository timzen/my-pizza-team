/**
 * daemon/server.ts — HTTP API server for the team lead.
 *
 * Serves the REST API for teammates and the lead. Built with Hono, served by @hono/node-server.
 * Feature toggles (daemon/features.ts) are middleware installed ahead of every
 * route module. Routes are organized into modules by concern:
 *   - shared: health, status, config, control, readiness, workflows
 *   - stories: story CRUD, pending/activate, archive
 *   - tasks: story-parent task operations — create-in-story, reorder, move, delete
 *   - work-defs: every WorkDef (board, Solitary, Scheduled): CRUD, enqueue,
 *     archive/restore, comments, attachments, token usage
 *   - work: the WorkItem queue — Inbox/sidebar reads plus the recovery actions
 *     (cancel, force-fail, re-enqueue)
 *   - schedules: Schedule (cron parent) CRUD
 *   - templates: Task Template CRUD — reusable molds for Solitary tasks
 *   - agents: agent protocol (register, heartbeat, next-work, claim, set-state,
 *     comments), self-directives, leader directives, spawn requests
 *   - assistant: chat v2 — conversation, SSE stream, agent mirror surface,
 *     session lifecycle, and the persona
 *   - thoughts: Thoughts board CRUD, batch positions, and groups (+ a note's triage)
 *   - sources: every Work Source's settings — list, preview, save + re-init
 *   - triage: proposals on any triage subject by WorkDef id (a triage-mode
 *     external item's accept/reject), and the handling the note routes share
 *   - context: the context library of reusable prompt/context entries
 *   - transcripts: live teammate transcripts (watch view SSE + agent mirror)
 *   - pairing: pair with / message / release a teammate from the web UI
 *   - usage: token-usage reports for any run + the Usage dashboard's rollups
 */

import { Hono } from "hono";
import { Store } from "./store.ts";
import { type TeamConfig } from "../shared/types.ts";
import { createAuthMiddleware, resolveToken } from "./auth.ts";
import { resolveDistDir, staticMiddleware } from "./static.ts";
import type { RouteContext } from "./routes/types.ts";
import { registerFeatureGates } from "./features.ts";
import { registerSharedRoutes } from "./routes/shared.ts";
import { registerDirectoryRoutes } from "./routes/directories.ts";
import { registerStoryRoutes } from "./routes/stories.ts";
import { registerTaskRoutes } from "./routes/tasks.ts";
import { registerAgentRoutes } from "./routes/agents.ts";
import { registerWorkRoutes } from "./routes/work.ts";
import { registerWorkDefRoutes } from "./routes/work-defs.ts";
import { registerScheduleRoutes } from "./routes/schedules.ts";
import { registerTemplateRoutes } from "./routes/templates.ts";
import { registerAssistantRoutes } from "./routes/assistant.ts";
import { registerContextRoutes } from "./routes/context.ts";
import { registerThoughtRoutes } from "./routes/thoughts.ts";
import { registerTranscriptRoutes } from "./routes/transcripts.ts";
import { registerPairingRoutes } from "./routes/pairing.ts";
import { registerUsageRoutes } from "./routes/usage.ts";
import { registerWorkSourceRoutes } from "./routes/work-sources.ts";
import { registerTriageRoutes } from "./routes/triage.ts";
import { registerSourceRoutes } from "./routes/sources.ts";

/** Build the Hono app with all API routes wired to the store */
export function buildApp(store: Store, config: TeamConfig, teamDir: string): Hono {
  const app = new Hono();
  let paused = false;
  const startedAt = Date.now();

  // Apply auth middleware if a token is configured
  const token = resolveToken(config.apiToken);
  const authMiddleware = createAuthMiddleware(token);
  if (authMiddleware) {
    app.use("*", authMiddleware);
  }

  // Serve static UI files if dist directory exists
  const distDir = resolveDistDir();
  if (distDir) {
    app.use("*", staticMiddleware(distDir));
  }

  // Build shared context for route modules
  const ctx: RouteContext = {
    app,
    store,
    config,
    teamDir,
    isPaused: () => paused,
    setPaused: (v) => { paused = v; },
    startedAt,
  };

  // Feature toggles first: their middleware must sit in front of the routes it
  // gates (docs/ARCHITECTURE.md "Feature toggles").
  registerFeatureGates(ctx);

  // Register all route modules
  registerSharedRoutes(ctx);
  registerStoryRoutes(ctx);
  registerTaskRoutes(ctx);
  registerAgentRoutes(ctx);
  registerWorkRoutes(ctx);
  registerWorkDefRoutes(ctx);
  registerWorkSourceRoutes(ctx);
  registerSourceRoutes(ctx);
  registerTriageRoutes(ctx);
  registerScheduleRoutes(ctx);
  registerTemplateRoutes(ctx);
  registerAssistantRoutes(ctx);
  registerContextRoutes(ctx);
  registerThoughtRoutes(ctx);
  registerTranscriptRoutes(ctx);
  registerPairingRoutes(ctx);
  registerUsageRoutes(ctx);
  registerDirectoryRoutes(ctx);

  return app;
}
