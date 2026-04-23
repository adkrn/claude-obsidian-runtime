#!/bin/bash
set -euo pipefail
if [ -n "${CLAUDE_RUNTIME_HOME:-}" ] && [ -d "$CLAUDE_RUNTIME_HOME" ]; then
  node "$CLAUDE_RUNTIME_HOME/commands/prompt-context.mjs" 
else
  echo "[hook] CLAUDE_RUNTIME_HOME not set. Hook skipped." >&2
fi
