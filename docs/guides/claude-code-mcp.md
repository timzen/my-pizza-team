# Claude Code + MCP Setup Guide

Use Claude Code with the my-pizza-team daemon via an MCP (Model Context Protocol) server bridge. This lets Claude Code act as a teammate that claims and executes tasks.

## Architecture

```
Claude Code ←→ MCP Server ←→ my-pizza-team daemon (HTTP API)
```

The MCP server exposes daemon operations as MCP tools that Claude Code can invoke natively.

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed
- my-pizza-team daemon running (`mpt start`)
- Node.js 18+ (for the MCP bridge)

## Setup

### 1. Create the MCP Bridge

Create a simple MCP server that proxies to the daemon API:

```typescript
// mpt-mcp-server.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const DAEMON_URL = process.env.MPT_DAEMON_URL || "http://localhost:7437";
const AGENT_NAME = process.env.MPT_AGENT_NAME || "claude-worker";

const server = new Server({ name: "my-pizza-team", version: "1.0.0" }, {
  capabilities: { tools: {} }
});

// Register tools that map to daemon API endpoints
server.setRequestHandler("tools/list", async () => ({
  tools: [
    {
      name: "mpt_next_work",
      description: "Poll for the next available task",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "mpt_claim_task",
      description: "Claim ownership of a task",
      inputSchema: {
        type: "object",
        properties: { taskId: { type: "string" } },
        required: ["taskId"]
      }
    },
    {
      name: "mpt_transition_task",
      description: "Advance task to next workflow state",
      inputSchema: {
        type: "object",
        properties: { taskId: { type: "string" } },
        required: ["taskId"]
      }
    },
    {
      name: "mpt_release_task",
      description: "Release task (when blocked by lead transition)",
      inputSchema: {
        type: "object",
        properties: { taskId: { type: "string" } },
        required: ["taskId"]
      }
    },
    {
      name: "mpt_post_comment",
      description: "Post a comment on a task",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          body: { type: "string" }
        },
        required: ["taskId", "body"]
      }
    },
    {
      name: "mpt_get_comments",
      description: "Get comments on a task (for lead feedback)",
      inputSchema: {
        type: "object",
        properties: { taskId: { type: "string" } },
        required: ["taskId"]
      }
    },
    {
      name: "mpt_search_memory",
      description: "Search the team knowledge base",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"]
      }
    }
  ]
}));

// Tool execution handler
server.setRequestHandler("tools/call", async (request) => {
  const { name, arguments: args } = request.params;

  const handlers: Record<string, () => Promise<Response>> = {
    mpt_next_work: () => fetch(`${DAEMON_URL}/api/agents/next-work?agentId=${AGENT_NAME}`),
    mpt_claim_task: () => fetch(`${DAEMON_URL}/api/agents/claim/${args.taskId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: AGENT_NAME })
    }),
    mpt_release_task: () => fetch(`${DAEMON_URL}/api/agents/release/${args.taskId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: AGENT_NAME, result: args.result })
    }),
    mpt_post_comment: () => fetch(`${DAEMON_URL}/api/agents/comments/${args.taskId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: AGENT_NAME, body: args.body })
    }),
    mpt_get_comments: () => fetch(`${DAEMON_URL}/api/agents/comments/${args.taskId}`),
    mpt_search_memory: () => fetch(`${DAEMON_URL}/api/assistant/notes?q=${encodeURIComponent(args.query)}`)
  };

  const handler = handlers[name];
  if (!handler) return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };

  const res = await handler();
  const data = await res.json();
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
```

### 2. Register with Claude Code

Add to your Claude Code MCP config (`~/.claude/mcp.json` or project-level):

```json
{
  "mcpServers": {
    "my-pizza-team": {
      "command": "npx",
      "args": ["tsx", "/path/to/mpt-mcp-server.ts"],
      "env": {
        "MPT_DAEMON_URL": "http://localhost:7437",
        "MPT_AGENT_NAME": "claude-coder"
      }
    }
  }
}
```

### 3. Register the Agent

Before Claude Code can claim tasks, register it with the daemon:

```bash
curl -X POST http://localhost:7437/api/agents/register \
  -H "Content-Type: application/json" \
  -d '{"name": "claude-coder", "cwd": "/path/to/project"}'
```

### 4. Set Up Heartbeat

Add a heartbeat cron or background process (required to avoid timeout):

```bash
# Every 30 seconds:
while true; do
  curl -s -X POST http://localhost:7437/api/agents/heartbeat \
    -H "Content-Type: application/json" \
    -d '{"agentId": "claude-coder"}'
  sleep 30
done
```

Or integrate the heartbeat into the MCP server itself.

## Usage

Once configured, Claude Code can:

1. Use `mpt_next_work` to find available tasks
2. Use `mpt_claim_task` to take ownership
3. Read task description and comments for context
4. Do the actual coding work
5. Use `mpt_transition_task` to advance the workflow
6. Use `mpt_post_comment` to report status
7. Use `mpt_release_task` when only lead transitions remain

## System Prompt

Add to your Claude Code system prompt for best results:

```
You are a teammate on a software team managed by my-pizza-team. Use the mpt_* tools
to poll for work, claim tasks, and transition through workflow states. Always:
1. Check mpt_next_work first for available tasks
2. Read comments (mpt_get_comments) on claimed tasks for lead feedback
3. Post a comment when starting and finishing work
4. Transition the task when work is complete
5. Release tasks when blocked (no available transitions)
```

## Spawning from Pi Leader

The Pi leader can spawn Claude Code teammates via harness config:

```json
{
  "hosts": {
    "my-machine": {
      "harnessCommands": {
        "claude-code": "claude --mcp-config /path/to/mpt-mcp.json"
      }
    }
  }
}
```

Then use `/ppt-spawn --harness=claude-code worker-name /path/to/cwd`.
