# Codex Wrapper Setup Guide

Use OpenAI's Codex CLI as a teammate in the my-pizza-team system. The wrapper script polls the daemon for tasks and delegates execution to Codex.

## Architecture

```
mpt-codex-runner (shell) → polls daemon → spawns codex per task → reports results
```

The wrapper is a thin orchestration script that:
1. Registers with the daemon as an agent
2. Polls for available work
3. Spawns `codex` with the task description as the prompt
4. Transitions the task on completion

## Prerequisites

- [Codex CLI](https://github.com/openai/codex) installed (`npm install -g @openai/codex`)
- my-pizza-team daemon running (`mpt start`)
- `OPENAI_API_KEY` environment variable set

## Setup

### 1. Create the Runner Script

```bash
#!/usr/bin/env bash
# mpt-codex-runner — Codex teammate for my-pizza-team
#
# Usage: mpt-codex-runner --name=<name> --daemon=<url> --cwd=<dir>

set -euo pipefail

# Parse arguments
AGENT_NAME=""
DAEMON_URL="http://localhost:7437"
WORK_DIR="$(pwd)"
POLL_INTERVAL=10
HEARTBEAT_INTERVAL=30

for arg in "$@"; do
  case "$arg" in
    --name=*) AGENT_NAME="${arg#*=}" ;;
    --daemon=*) DAEMON_URL="${arg#*=}" ;;
    --cwd=*) WORK_DIR="${arg#*=}" ;;
    --poll=*) POLL_INTERVAL="${arg#*=}" ;;
  esac
done

if [ -z "$AGENT_NAME" ]; then
  AGENT_NAME="codex-$(hostname -s)-$$"
fi

echo "🤖 Codex runner starting: $AGENT_NAME"
echo "   Daemon: $DAEMON_URL"
echo "   CWD: $WORK_DIR"

# Register with daemon
curl -s -X POST "$DAEMON_URL/api/agents/register" \
  -H "Content-Type: application/json" \
  -d "{\"name\": \"$AGENT_NAME\", \"cwd\": \"$WORK_DIR\"}" > /dev/null

# Heartbeat in background
heartbeat() {
  while true; do
    curl -s -X POST "$DAEMON_URL/api/agents/heartbeat" \
      -H "Content-Type: application/json" \
      -d "{\"agentId\": \"$AGENT_NAME\"}" > /dev/null 2>&1
    sleep "$HEARTBEAT_INTERVAL"
  done
}
heartbeat &
HEARTBEAT_PID=$!
trap "kill $HEARTBEAT_PID 2>/dev/null; exit" EXIT INT TERM

# Main work loop
while true; do
  # Poll for work
  RESPONSE=$(curl -s "$DAEMON_URL/api/agents/next-work?agentId=$AGENT_NAME")
  TASK_ID=$(echo "$RESPONSE" | jq -r '.task.id // empty')

  if [ -z "$TASK_ID" ]; then
    sleep "$POLL_INTERVAL"
    continue
  fi

  TASK_TITLE=$(echo "$RESPONSE" | jq -r '.task.title')
  TASK_DESC=$(echo "$RESPONSE" | jq -r '.task.description // ""')
  STORY_TITLE=$(echo "$RESPONSE" | jq -r '.story.title // ""')

  echo "📋 Claiming task: $TASK_TITLE ($TASK_ID)"

  # Claim the task (daemon transitions to working state)
  curl -s -X POST "$DAEMON_URL/api/agents/claim/$TASK_ID" \
    -H "Content-Type: application/json" \
    -d "{\"agentId\": \"$AGENT_NAME\"}" > /dev/null

  # Get comments for context
  COMMENTS=$(curl -s "$DAEMON_URL/api/agents/comments/$TASK_ID" | jq -r '.comments[]?.body // empty')

  # Build prompt for Codex
  PROMPT="Task: $TASK_TITLE"
  [ -n "$TASK_DESC" ] && PROMPT="$PROMPT\n\nDescription: $TASK_DESC"
  [ -n "$STORY_TITLE" ] && PROMPT="$PROMPT\n\nStory: $STORY_TITLE"
  [ -n "$COMMENTS" ] && PROMPT="$PROMPT\n\nFeedback/Comments:\n$COMMENTS"

  echo "🔧 Running Codex..."

  # Run Codex in the working directory
  cd "$WORK_DIR"
  if codex --approval-mode full-auto -q "$PROMPT" 2>&1; then
    echo "✅ Task complete: $TASK_TITLE"

    # Post success comment
    curl -s -X POST "$DAEMON_URL/api/agents/comments/$TASK_ID" \
      -H "Content-Type: application/json" \
      -d "{\"agentId\": \"$AGENT_NAME\", \"body\": \"Task completed by Codex runner.\"}" > /dev/null
  else
    echo "❌ Codex failed for task: $TASK_TITLE"

    # Post failure comment
    curl -s -X POST "$DAEMON_URL/api/agents/comments/$TASK_ID" \
      -H "Content-Type: application/json" \
      -d "{\"agentId\": \"$AGENT_NAME\", \"body\": \"Codex execution failed. Manual intervention needed.\"}" > /dev/null
  fi

  # Release the task (daemon advances to next state)
  curl -s -X POST "$DAEMON_URL/api/agents/release/$TASK_ID" \
    -H "Content-Type: application/json" \
    -d "{\"agentId\": \"$AGENT_NAME\", \"result\": \"Codex run complete\"}" > /dev/null

  echo "---"
done
```

### 2. Install the Script

```bash
chmod +x mpt-codex-runner
sudo cp mpt-codex-runner /usr/local/bin/
# Or add to your PATH
```

### 3. Run

```bash
# Basic usage
mpt-codex-runner --name=codex-frontend --cwd=/path/to/project

# Custom daemon URL and poll interval
mpt-codex-runner --name=codex-api --daemon=http://192.168.1.10:7437 --cwd=/path/to/api --poll=5
```

## Spawning from Pi Leader

Configure the harness command in `config.json`:

```json
{
  "hosts": {
    "my-machine": {
      "harnessCommands": {
        "codex": "mpt-codex-runner --name={name} --daemon={url} --cwd={cwd}"
      }
    }
  }
}
```

Then from the Pi leader: `/ppt-spawn --harness=codex my-codex-worker /path/to/cwd`

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `OPENAI_API_KEY` | (required) | OpenAI API key for Codex |
| `CODEX_MODEL` | (codex default) | Model override |

## Limitations

- **No interactive mode**: Codex runs in `full-auto` approval mode. All changes are applied without review.
- **Single task at a time**: The runner processes tasks sequentially.
- **No file context**: Unlike Pi teammates, the Codex wrapper doesn't maintain conversation history across tasks. Each task starts fresh.
- **Error handling**: If Codex crashes, the task is released with a failure comment. The lead can reassign or add clarifying comments.

## Workflow Integration

The typical flow:

```
1. Lead creates story + tasks via UI
2. mpt-codex-runner polls, claims task (daemon transitions to working state)
3. Codex executes in full-auto mode
4. Runner releases task (daemon advances to next state)
5. Lead reviews via UI, approves or sends back with comments
6. If sent back: runner picks up again, sees comments, re-executes
```

This works best for well-defined, atomic tasks with clear acceptance criteria.
