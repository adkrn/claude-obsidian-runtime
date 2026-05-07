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
  loadSessionTaskPointer,
  loadTaskRecord,
  parseCliArgs,
  updateTaskRecord,
  upsertTaskSessionTimeline,
  writeSessionTaskPointer
} from '../core/runtime-lib.mjs';

function buildAdditionalContext({ sessionId, currentTask, globalTask, latestWorklog }) {
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
    if (globalTask?.task) {
      const g = globalTask.task;
      lines.push(`- other_session_active_task: ${g.taskId} :: ${g.title || g.prompt || g.taskId} (run /task-start to claim a task in this session)`);
    }
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

  // Session isolation: prefer per-session pointer. Never auto-attach this
  // sessionId to the global pointer's task — that would let an unrelated
  // session "inherit" another session's active task and accidentally close
  // it later. Only tasks that explicitly belong to this session (via
  // /task-start or a previously-written session pointer) are tracked here.
  const sessionPointer = sessionId ? loadSessionTaskPointer(projectDir, sessionId) : null;
  const ownedTask = sessionPointer?.taskId
    ? loadTaskRecord(projectDir, sessionPointer.taskId)
    : null;

  if (sessionId && ownedTask?.task) {
    const startedAt = new Date().toISOString();
    const updated = updateTaskRecord(projectDir, (task) => {
      const alreadyKnown = Array.isArray(task.sessionIds) && task.sessionIds.includes(sessionId);
      return {
        ...task,
        updatedAt: startedAt,
        sessionIds: alreadyKnown
          ? task.sessionIds
          : [...(task.sessionIds || []), sessionId],
        sessionTimeline: upsertTaskSessionTimeline(task, {
          sessionId,
          startedAt,
          lastSeenAt: startedAt,
          transcriptPath: input.transcript_path || input.transcriptPath || ''
        })
      };
    }, ownedTask.task.taskId);

    if (updated?.task && updated?.taskPath) {
      writeSessionTaskPointer(projectDir, sessionId, {
        taskId: updated.task.taskId,
        title: updated.task.title || '',
        status: updated.task.status || 'active',
        taskPath: updated.taskPath,
        contextPath: sessionPointer?.contextPath || '',
        updatedAt: startedAt
      });
    }
  }

  // Surface info about the global active task (read-only) so the user can
  // see what's running elsewhere, but we do NOT mutate it.
  const globalPointer = loadCurrentTaskPointer(projectDir);
  const globalTask = globalPointer?.taskId && globalPointer.taskId !== ownedTask?.task?.taskId
    ? loadTaskRecord(projectDir, globalPointer.taskId)
    : null;

  const latestWorklog = loadLatestWorklogSummary(projectDir);
  const additionalContext = buildAdditionalContext({
    sessionId,
    currentTask: ownedTask,
    globalTask: ownedTask ? null : globalTask,
    latestWorklog
  });

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
