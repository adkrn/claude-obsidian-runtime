#!/bin/bash
set -euo pipefail
if [ -n "${CLAUDE_RUNTIME_HOME:-}" ] && [ -d "$CLAUDE_RUNTIME_HOME" ]; then
  node "$CLAUDE_RUNTIME_HOME/commands/stop.mjs" --session-id "${CLAUDE_SESSION_ID:-}"
else
  echo "[hook] CLAUDE_RUNTIME_HOME not set. Hook skipped." >&2
fi
