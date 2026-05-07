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

import fs from 'fs';
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
  tokenizeSearchText,
  uniqueStrings,
  updateTaskRecord,
  upsertTaskSessionTimeline,
  writeSessionTaskPointer
} from '../core/runtime-lib.mjs';
import { scoreItems } from '../core/memory/retrieval-scoring.mjs';
import { loadErrors } from '../core/error-indexer.mjs';

// ── DESIGN_MANUS_B §6/§7 — Related Past Failures injection ───────

// AVOIDANCE_HINTS — initial 4 errorTypes (B §7-B). Expand as ops data grows.
const AVOIDANCE_HINTS = {
  'string-not-found': '컨텍스트 5줄 더 포함해서 재시도',
  'ENOENT': '경로 존재 확인 후 재시도',
  'permission-denied': '권한 또는 파일 잠금 확인',
  'parse-error': '입력 형식 검증 후 재시도'
};

const FAILURE_FALLBACK_THRESHOLD = 5;
const FAILURE_TOP_N = 3;
const FAILURE_WINDOW_DAYS = 30;

function loadDefaultScopeFromManifest(projectDir) {
  try {
    const manifestPath = path.join(projectDir, '.claude', 'runtime-manifest.json');
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed?.defaultScope === 'string' && parsed.defaultScope.length > 0) {
      return { defaultScope: parsed.defaultScope, retrievalWeights: parsed.retrievalWeights || null };
    }
  } catch {
    // missing or invalid → caller falls back to repo
  }
  return { defaultScope: 'repo', retrievalWeights: null };
}

/**
 * B §6-A — collect signal context for the gate / scoring.
 * Pure helper (no I/O); accepts pre-loaded task/worklog/manifest.
 */
export function collectSignalContext(currentTask, latestWorklog, manifest) {
  const defaultScope = (manifest && typeof manifest.defaultScope === 'string')
    ? manifest.defaultScope
    : 'repo';

  if (currentTask?.task) {
    const t = currentTask.task;
    const activeScopes = Array.isArray(t.matchedScopes) && t.matchedScopes.length > 0
      ? t.matchedScopes.slice()
      : [defaultScope];
    const readFirstPaths = Array.isArray(t.readFirst)
      ? t.readFirst.map((r) => (r && typeof r.path === 'string' ? r.path : '')).filter(Boolean)
      : [];
    const candidatePaths = readFirstPaths.map((p) => p.replace(/\\/g, '/')).sort();
    const tokens = uniqueStrings([
      ...tokenizeSearchText(t.prompt || ''),
      ...tokenizeSearchText(t.title || ''),
      ...candidatePaths.flatMap((p) => tokenizeSearchText(path.basename(p)))
    ]);
    return { activeScopes, candidatePaths, signalTokens: tokens };
  }

  const summary = latestWorklog?.summary || latestWorklog?.summaryText || '';
  return {
    activeScopes: [defaultScope],
    candidatePaths: [],
    signalTokens: uniqueStrings(tokenizeSearchText(summary))
  };
}

function parseTsMs(value) {
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : 0;
}

function formatErrorLines(errors, modeFallback) {
  const header = modeFallback
    ? '### Related Past Failures (fallback: time-based, errors < 5)'
    : '### Related Past Failures (avoid repeating)';
  const out = [header];
  for (const err of errors) {
    const tool = err.tool || 'unknown';
    const errorType = err.errorType || 'unknown';
    const filePath = err.filePath || '(no path)';
    const attempts = Number.isFinite(err.recoveryAttempts) ? err.recoveryAttempts : 0;

    if (modeFallback) {
      out.push(`- [tool=${tool}] ${errorType} in ${filePath}`);
      continue;
    }

    let resolvedStr;
    if (err.resolved && err.linkedReflectionPath) {
      resolvedStr = `resolved via ${err.linkedReflectionPath}`;
    } else if (err.resolved) {
      resolvedStr = 'resolved';
    } else {
      resolvedStr = '미해결';
    }
    out.push(`- [tool=${tool}] ${errorType} in ${filePath} (${attempts}회 시도, ${resolvedStr})`);

    if (err.linkedReflectionPath) {
      out.push(`    → 참조: ${err.linkedReflectionPath}`);
    } else if (!err.resolved) {
      const hint = AVOIDANCE_HINTS[errorType];
      if (hint) out.push(`    → 회피: ${hint}`);
    }
  }
  return out.join('\n');
}

/**
 * B §6/§7 — produce the "Related Past Failures" block.
 * Returns null when no errors exist (block omitted entirely).
 *
 * Pure-ish: takes pre-loaded errors and signal context + weights.
 */
export function buildErrorInjectionBlock(errors, signalCtx, options = {}) {
  if (!Array.isArray(errors) || errors.length === 0) return null;

  if (errors.length < FAILURE_FALLBACK_THRESHOLD) {
    const sorted = [...errors].sort((a, b) => parseTsMs(b.timestamp) - parseTsMs(a.timestamp));
    return formatErrorLines(sorted.slice(0, FAILURE_TOP_N), true);
  }

  const ctx = {
    promptTokens: signalCtx.signalTokens,
    candidatePaths: signalCtx.candidatePaths,
    signalTokens: signalCtx.signalTokens,
    activeScopes: signalCtx.activeScopes,
    weights: options.weights || null,
    gateMode: 'exclude',
    now: options.now instanceof Date ? options.now : new Date()
  };
  const scored = scoreItems(errors, ctx);
  const passed = scored.filter((s) => s.score > -Infinity);
  if (passed.length === 0) return null;
  return formatErrorLines(passed.slice(0, FAILURE_TOP_N).map((s) => s.item), false);
}

function buildAdditionalContext({
  sessionId,
  currentTask,
  globalTask,
  latestWorklog,
  errorBlock
}) {
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

  if (typeof errorBlock === 'string' && errorBlock.length > 0) {
    lines.push('');
    lines.push(errorBlock);
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

  // B §6 — Related Past Failures injection
  const manifestSnapshot = loadDefaultScopeFromManifest(projectDir);
  const signalCtx = collectSignalContext(ownedTask, latestWorklog, manifestSnapshot);
  let errorBlock = null;
  try {
    const errors = loadErrors(projectDir, { windowDays: FAILURE_WINDOW_DAYS });
    errorBlock = buildErrorInjectionBlock(errors, signalCtx, {
      weights: manifestSnapshot.retrievalWeights
    });
  } catch {
    // errors.jsonl missing/corrupt → silently omit block
    errorBlock = null;
  }

  const additionalContext = buildAdditionalContext({
    sessionId,
    currentTask: ownedTask,
    globalTask: ownedTask ? null : globalTask,
    latestWorklog,
    errorBlock
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
