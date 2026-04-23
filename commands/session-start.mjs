#!/usr/bin/env node

/**
 * SessionStart hook handler.
 *
 * Reads SessionStart event stdin, updates task record session timeline,
 * and emits additionalContext for Claude Code.
 *
 * Usage:
 *   echo '{"session_id":"..."}' | claude-obsidian-runtime session-start
 *   (or bound to SessionStart hook via install-hooks)
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { readStdinJson } from '../core/utils.mjs';
import {
  ensureRuntimeLayout,
  loadCurrentTaskPointer,
  loadLatestWorklogSummary,
  loadTaskRecord,
  parseCliArgs,
  uniqueStrings,
  updateTaskRecord,
  upsertTaskSessionTimeline
} from '../core/runtime-lib.mjs';

function buildAdditionalContext({ sessionId, currentTask, latestWorklog }) {
  const lines = ['[Runtime Session Context]'];

  if (sessionId) lines.push(`- session_id: ${sessionId}`);

  if (currentTask?.task) {
    const t = currentTask.task;
    lines.push(`- active_task: ${t.taskId} :: ${t.title || t.prompt || t.taskId}`);
    if (Array.isArray(t.matchedScopes) && t.matchedScopes.length > 0) {
      lines.push(`- active_scopes: ${t.matchedScopes.join(', ')}`);
    }
    if (Array.isArray(t.readFirst) && t.readFirst.length > 0) {
      lines.push('- resume_read_first:');
      t.readFirst.slice(0, 3).forEach((note) => {
        lines.push(`  - ${note.path} :: ${note.why}`);
      });
    }
    if (t.lastWorklog?.relativePath) {
      lines.push(`- active_task_worklog: ${t.lastWorklog.relativePath}`);
    }
  } else {
    lines.push('- active_task: none');
  }

  if (latestWorklog?.worklogRelativePath) {
    lines.push(`- last_worklog: ${latestWorklog.worklogRelativePath}`);
    lines.push(`- last_worklog_summary: modified=${latestWorklog.modifiedFileCount}, failures=${latestWorklog.failureCount}, hook=${latestWorklog.hookEventName || ''}`);
  }

  return lines.join('\n');
}

export function buildRuntimeSessionStartContext(projectDir, input = {}) {
  ensureRuntimeLayout(projectDir);
  const sessionId = input.session_id || input.sessionId || '';
  const pointer = loadCurrentTaskPointer(projectDir);
  const currentTask = pointer?.taskId ? loadTaskRecord(projectDir, pointer.taskId) : null;

  if (sessionId && currentTask?.task) {
    const startedAt = new Date().toISOString();
    updateTaskRecord(projectDir, (task) => ({
      ...task,
      updatedAt: startedAt,
      sessionIds: uniqueStrings([...(task.sessionIds || []), sessionId]),
      sessionTimeline: upsertTaskSessionTimeline(task, {
        sessionId,
        startedAt,
        lastSeenAt: startedAt,
        transcriptPath: input.transcript_path || input.transcriptPath || ''
      })
    }), currentTask.task.taskId);
  }

  const latestWorklog = loadLatestWorklogSummary(projectDir);
  const additionalContext = buildAdditionalContext({ sessionId, currentTask, latestWorklog });

  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext
    }
  };
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const projectDir = path.resolve(args.projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd());

  let input;
  try {
    input = await readStdinJson({});
  } catch {
    input = {};
  }

  const output = buildRuntimeSessionStartContext(projectDir, input);
  process.stdout.write(JSON.stringify(output));
}

const currentFilePath = fileURLToPath(import.meta.url);
const invokedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (currentFilePath === invokedFilePath) {
  main().catch(() => process.exit(0));
}
