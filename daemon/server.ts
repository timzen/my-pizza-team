/**
 * daemon/server.ts — HTTP API server for the team lead (Deno port).
 *
 * Serves the REST API for teammates and the lead. Built with Hono on Deno.serve().
 * Routes are organized into modules by persona/concern:
 *   - shared: health, status, config, control, hosts, workflows
 *   - stories: story CRUD, archive, backlog
 *   - tasks: task CRUD, move, comments, attachments, token usage
 *   - teammate: legacy teammate protocol (next-task, claim, status, team)
 *   - agents: agent protocol (register, next-work, claim, release, spawn)
 *   - assistant: queue and knowledge base
 */

import { Hono } from "hono";
import { Store } from "./store.ts";
import { type TeamConfig } from "../shared/types.ts";
import { createAuthMiddleware, resolveToken } from "./auth.ts";
import { resolveDistDir, staticMiddleware } from "./static.ts";
import type { RouteContext } from "./routes/types.ts";
import { registerSharedRoutes } from "./routes/shared.ts";
import { registerStoryRoutes } from "./routes/stories.ts";
import { registerTaskRoutes } from "./routes/tasks.ts";
import { registerTeammateRoutes } from "./routes/teammate.ts";
import { registerAgentRoutes } from "./routes/agents.ts";
import { registerAssistantRoutes } from "./routes/assistant.ts";

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

  /** Assemble transition instructions into markdown */
  function getInstructionsMarkdown(fromStatus: string, toStatus: string, taskId?: string): string | undefined {
    let workflowName: string | undefined;
    if (taskId) {
      const task = store.getTask(taskId);
      if (task) {
        const story = store.getStory(task.storyId);
        workflowName = story?.workflow || config.defaultWorkflow;
      }
    }
    const { exitInstructions, enterInstructions } = store.getTransitionInstructions(fromStatus, toStatus, workflowName);
    const parts: string[] = [];
    if (exitInstructions) parts.push(`## Transition: leaving "${fromStatus}"\n\n${exitInstructions}`);
    if (enterInstructions) parts.push(`## Transition: entering "${toStatus}"\n\n${enterInstructions}`);
    return parts.length > 0 ? parts.join("\n\n---\n\n") : undefined;
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
    getInstructionsMarkdown,
  };

  // Register all route modules
  registerSharedRoutes(ctx);
  registerStoryRoutes(ctx);
  registerTaskRoutes(ctx);
  registerTeammateRoutes(ctx);
  registerAgentRoutes(ctx);
  registerAssistantRoutes(ctx);

  return app;
}
