#!/usr/bin/env node

/**
 * Stop / SubagentStop hook handler.
 * Checkpoints the active task record with session timeline updates.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { readStdinJson } from '../core/utils.mjs';
import {
  ensureRuntimeLayout,
  getTaskSessionEntry,
  loadCurrentTaskPointer,
  loadSessionTaskPointer,
  parseCliArgs,
  toTaskPointer,
  uniqueStrings,
  updateTaskRecord,
  upsertTaskSessionTimeline,
  writeSessionTaskPointer
} from '../core/runtime-lib.mjs';

export function checkpointRuntimeTask(projectDir, input = {}) {
  ensureRuntimeLayout(projectDir);
  const sessionId = input.session_id || input.sessionId || '';
  const sessionPointer = sessionId ? loadSessionTaskPointer(projectDir, sessionId) : null;
  const globalPointer = loadCurrentTaskPointer(projectDir);

  // Only treat the global pointer's task as ours when this session originated
  // it. Otherwise this hook would attach the current sessionId to an
  // unrelated task and let session-end close it on the wrong session.
  let activeTaskId = sessionPointer?.taskId || '';
  let ownsTask = Boolean(sessionPointer?.taskId);
  if (!activeTaskId && globalPointer?.taskId) {
    activeTaskId = globalPointer.taskId;
    ownsTask = false;
  }
  if (!activeTaskId) {
    return { ok: false, reason: 'no_active_task' };
  }

  const hookEventName = input.hook_event_name || input.hookEventName || 'Stop';
  const updatedAt = new Date().toISOString();
  const updated = updateTaskRecord(projectDir, (task) => {
    const base = {
      ...task,
      updatedAt,
      lastCheckpoint: { ts: updatedAt, hookEventName, sessionId }
    };
    if (!ownsTask || !sessionId) return base;
    return {
      ...base,
      sessionIds: uniqueStrings([...(task.sessionIds || []), sessionId]),
      sessionTimeline: upsertTaskSessionTimeline(task, {
        sessionId,
        startedAt: getTaskSessionEntry(task, sessionId)?.startedAt || task.createdAt || updatedAt,
        lastSeenAt: updatedAt,
        transcriptPath: input.transcript_path || input.transcriptPath || ''
      })
    };
  }, activeTaskId);

  if (ownsTask && sessionId && updated?.task && updated?.taskPath) {
    writeSessionTaskPointer(
      projectDir,
      sessionId,
      toTaskPointer(updated.task, updated.taskPath, globalPointer?.contextPath || '')
    );
  }

  return { ok: Boolean(updated?.task), taskId: activeTaskId, hookEventName, ownsTask };
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

  if (args.sessionId && !input.session_id) input.session_id = args.sessionId;
  if (args.hookEventName && !input.hook_event_name) input.hook_event_name = args.hookEventName;

  const result = checkpointRuntimeTask(projectDir, input);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const currentFilePath = fileURLToPath(import.meta.url);
const invokedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (currentFilePath === invokedFilePath) {
  main().catch(() => process.exit(0));
}
