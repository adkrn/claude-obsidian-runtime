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

import crypto from 'crypto';
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
import { stableStringify } from '../core/cache-stable-stringify.mjs';
import { gcOrphanPointers } from '../core/pointer-gc.mjs';

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

// ── DESIGN_MANUS_D §4-A — Static-first / Dynamic-last 4-section layout ─────

const DEFAULT_MANAGED_ROOTS = 9; // HANDOFF.md §4 D-9

const PACKAGE_META = (() => {
  // Resolve package.json next to commands/ directory.
  try {
    const here = fileURLToPath(import.meta.url);
    const pkgPath = path.resolve(path.dirname(here), '..', 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      name: typeof parsed?.name === 'string' ? parsed.name : 'claude-obsidian-runtime',
      version: typeof parsed?.version === 'string' ? parsed.version : '0.0.0'
    };
  } catch {
    return { name: 'claude-obsidian-runtime', version: '0.0.0' };
  }
})();

/**
 * D §4-A-1 — sha256(path.resolve(CLAUDE_RUNTIME_HOME)).slice(0,8).
 * Falls back to the package install dir when the env var is unset, so the
 * hash is still deterministic per machine layout.
 */
export function computeRuntimeHomeHash(env = process.env) {
  const raw = (env && typeof env.CLAUDE_RUNTIME_HOME === 'string' && env.CLAUDE_RUNTIME_HOME.length > 0)
    ? env.CLAUDE_RUNTIME_HOME
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const resolved = path.resolve(raw);
  return crypto.createHash('sha256').update(resolved).digest('hex').slice(0, 8);
}

function loadManifestSnapshot(projectDir) {
  try {
    const manifestPath = path.join(projectDir, '.claude', 'runtime-manifest.json');
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      projectTag: typeof parsed?.projectTag === 'string' && parsed.projectTag.length > 0
        ? parsed.projectTag
        : '',
      managedRoots: Array.isArray(parsed?.managedRoots) ? parsed.managedRoots.length : null
    };
  } catch {
    return { projectTag: '', managedRoots: null };
  }
}

function sortAscStable(arr) {
  return arr.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function normalizeForwardSlash(p) {
  return typeof p === 'string' ? p.replace(/\\/g, '/') : '';
}

function buildIdentitySection(projectDir, env = process.env) {
  const { projectTag, managedRoots } = loadManifestSnapshot(projectDir);
  // sub-keys emitted in alphabetical order (managed_roots < project_id < runtime < runtime_home_hash)
  const lines = ['## Project Identity'];
  lines.push(`- managed_roots: ${managedRoots !== null ? managedRoots : DEFAULT_MANAGED_ROOTS}`);
  lines.push(`- project_id: ${projectTag}`);
  lines.push(`- runtime: ${PACKAGE_META.name} v${PACKAGE_META.version}`);
  lines.push(`- runtime_home_hash: ${computeRuntimeHomeHash(env)}`);
  return lines;
}

function buildTaskSection(currentTask) {
  // §4-C: omit entire section when no task is owned by this session.
  if (!currentTask?.task) return null;
  const t = currentTask.task;
  const lines = ['## Task Context'];

  // sub-keys alphabetical: active_scopes < active_task_worklog < read_first < task_id < task_title
  const matchedScopes = Array.isArray(t.matchedScopes) ? t.matchedScopes : [];
  if (matchedScopes.length > 0) {
    lines.push(`- active_scopes: ${sortAscStable(matchedScopes).join(', ')}`);
  }
  if (t.lastWorklog?.relativePath) {
    lines.push(`- active_task_worklog: ${t.lastWorklog.relativePath}`);
  }

  // read_first: caller (task-start) selects via score+MMR; here we sort emit by path asc (D §5-C-1).
  const readFirst = Array.isArray(t.readFirst) ? t.readFirst : [];
  if (readFirst.length > 0) {
    const ordered = readFirst
      .slice()
      .sort((a, b) => {
        const pa = normalizeForwardSlash(a?.path);
        const pb = normalizeForwardSlash(b?.path);
        return pa < pb ? -1 : pa > pb ? 1 : 0;
      });
    lines.push('- read_first:');
    ordered.slice(0, 3).forEach((note) => {
      lines.push(`  - ${note.path} :: ${note.why}`);
    });
  }

  lines.push(`- task_id: ${t.taskId}`);
  const titleRaw = String(t.title || t.prompt || t.taskId || '');
  const title = titleRaw.length > 120 ? titleRaw.slice(0, 120) : titleRaw;
  lines.push(`- task_title: ${title}`);

  return lines;
}

/**
 * I §5-C — Session Volatile last_observation line.
 * Returns null when no off-loaded observation exists in the prior worklog
 * window (current behavior: payload_ref is interface-only, so always null).
 *
 * Caller convention (Wave C entry point): pass an array of recent events
 * filtered to those carrying `payload_ref`. Largest size wins (top-1, desc).
 */
export function buildLastObservationLine(recentOffloadEvents) {
  if (!Array.isArray(recentOffloadEvents) || recentOffloadEvents.length === 0) return null;
  let best = null;
  for (const ev of recentOffloadEvents) {
    const ref = ev?.payload_ref;
    if (!ref || typeof ref !== 'object') continue;
    const size = Number.isFinite(ref.size) ? ref.size : 0;
    if (!best || size > best.size) {
      best = { event: ev, size };
    }
  }
  if (!best || best.size <= 0) return null;
  const ev = best.event;
  const eventType = String(ev?.eventType || 'observation');
  const filePath = normalizeForwardSlash(ev?.filePath || '');
  const sizeKB = Math.round(best.size / 1024);
  return `- last_observation: ${eventType} @ ${filePath} (size=${sizeKB} KB)`;
}

function buildSessionVolatileSection({
  sessionId,
  sessionStartedAt,
  latestWorklog,
  lastObservationLine,
  notes
}) {
  // sub-keys alphabetical: last_observation < last_worklog < last_worklog_summary < session_id < session_started_at
  const lines = ['## Session Volatile'];
  if (lastObservationLine) lines.push(lastObservationLine);
  if (latestWorklog?.worklogRelativePath) {
    lines.push(`- last_worklog: ${latestWorklog.worklogRelativePath}`);
    const summaryNotes = notes ? `, notes=${notes}` : '';
    lines.push(`- last_worklog_summary: modified=${latestWorklog.modifiedFileCount}, failures=${latestWorklog.failureCount}, hook=${latestWorklog.hookEventName || ''}${summaryNotes}`);
  } else if (notes) {
    // worklog absent but we still need to surface orphan-pointer notes
    lines.push(`- last_worklog_summary: notes=${notes}`);
  }
  if (sessionId) lines.push(`- session_id: ${sessionId}`);
  lines.push(`- session_started_at: ${sessionStartedAt}`);
  return lines;
}

function stripErrorBlockHeader(errorBlock) {
  // S1 buildErrorInjectionBlock emits "### Related Past Failures..." as its first line.
  // D §4-A-4 owns the section header, so we drop the first line and keep only bullets.
  if (typeof errorBlock !== 'string' || errorBlock.length === 0) return [];
  const all = errorBlock.split('\n');
  if (all.length === 0) return [];
  const tail = all.slice(1).filter((line) => line.length > 0);
  return tail;
}

function buildRecentFailuresSection(errorBlock) {
  const bullets = stripErrorBlockHeader(errorBlock);
  if (bullets.length === 0) return null;
  return ['## Recent Failures', ...bullets];
}

export function buildAdditionalContext({
  projectDir,
  env,
  sessionId,
  sessionStartedAt,
  currentTask,
  latestWorklog,
  orphanPointerNote,
  lastObservationLine,
  errorBlock
}) {
  const out = ['[Runtime Session Context]'];

  // §4-A-1 always emit
  out.push('');
  out.push(...buildIdentitySection(projectDir, env));

  // §4-A-2 omit when no task owned by this session
  const taskSection = buildTaskSection(currentTask);
  if (taskSection) {
    out.push('');
    out.push(...taskSection);
  }

  // §4-A-3 always emit
  out.push('');
  out.push(...buildSessionVolatileSection({
    sessionId,
    sessionStartedAt,
    latestWorklog,
    lastObservationLine,
    notes: orphanPointerNote || ''
  }));

  // §4-A-4 conditional — omit when no failures pass the gate
  const failuresSection = buildRecentFailuresSection(errorBlock);
  if (failuresSection) {
    out.push('');
    out.push(...failuresSection);
  }

  return out.join('\n');
}

export function buildRuntimeSessionStartContext(projectDir, input = {}) {
  ensureRuntimeLayout(projectDir);
  const sessionId = input.session_id || input.sessionId || '';
  const sessionStartedAt = new Date().toISOString();

  // PRINCIPLES §7-quater — orphan current-task-<sid>.json 정리.
  // 현재 세션은 절대 건드리지 않고, 7일 이상 묵은 + 활동 흔적 없는 + task closed 인 것만 archive로 이동.
  // 실패해도 session-start 본 흐름은 계속.
  try {
    gcOrphanPointers(projectDir, { activeSessionId: sessionId });
  } catch { /* non-critical */ }

  // Session isolation: prefer per-session pointer. Never auto-attach this
  // sessionId to the global pointer's task — that would let an unrelated
  // session "inherit" another session's active task and accidentally close
  // it later. Only tasks that explicitly belong to this session (via
  // /task-start or a previously-written session pointer) are tracked here.
  const sessionPointer = sessionId ? loadSessionTaskPointer(projectDir, sessionId) : null;
  const ownedTask = sessionPointer?.taskId
    ? loadTaskRecord(projectDir, sessionPointer.taskId)
    : null;

  // §4-C orphan pointer detection: pointer exists but task record missing.
  const orphanPointerNote = (sessionPointer?.taskId && !ownedTask) ? 'task pointer orphan' : '';

  if (sessionId && ownedTask?.task) {
    const updated = updateTaskRecord(projectDir, (task) => {
      const alreadyKnown = Array.isArray(task.sessionIds) && task.sessionIds.includes(sessionId);
      return {
        ...task,
        updatedAt: sessionStartedAt,
        sessionIds: alreadyKnown
          ? task.sessionIds
          : [...(task.sessionIds || []), sessionId],
        sessionTimeline: upsertTaskSessionTimeline(task, {
          sessionId,
          startedAt: sessionStartedAt,
          lastSeenAt: sessionStartedAt,
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
        updatedAt: sessionStartedAt
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

  // B §6 — Related Past Failures injection (relocated to D §4-A-4 by section header)
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

  // I §5-C — last_observation line (interface only; payload_ref off-load not yet implemented).
  // Always null in current environment until Wave C ships write off-load.
  const lastObservationLine = buildLastObservationLine([]);

  // Read-only surfacing kept for backward awareness; not emitted under the
  // new D §4-A layout (other_session_active_task line removed).
  void globalTask;

  const additionalContext = buildAdditionalContext({
    projectDir,
    env: process.env,
    sessionId,
    sessionStartedAt,
    currentTask: ownedTask,
    latestWorklog,
    orphanPointerNote,
    lastObservationLine,
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
  // D §5-B-5 — JSON envelope sorted by key (stableStringify) so the
  // hookSpecificOutput payload is byte-stable across calls.
  process.stdout.write(stableStringify(output));
}

const currentFilePath = fileURLToPath(import.meta.url);
const invokedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (currentFilePath === invokedFilePath) {
  main().catch(() => process.exit(0));
}
