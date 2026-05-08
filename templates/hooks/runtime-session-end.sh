#!/bin/bash
# Disabled: hook-driven session-end corrupted parallel-task pointers when
# CLAUDE_SESSION_ID env var was unavailable (Claude Code v2.1.128+ does not
# inject session id into the hook shell). Use slash /task-close instead.
exit 0
