/**
 * L1.5 errors.jsonl indexer (DESIGN_MANUS_B).
 *
 * events/<scope>.jsonl is the SSOT (L1 Episodic). This module derives a
 * normalized, retrievable index — `runtime/knowledge/errors.jsonl` — from
 * fail/error events so session-start can inject "Related Past Failures".
 *
 * Append-only with sentinel rollup (P-M3):
 *   - new fail event           → append row
 *   - resolved transition      → append `{ id, resolution: {...} }` sentinel
 *   - reflection link          → append `{ id, linkedReflectionPath }` sentinel
 *   - loadErrors() rolls up sentinels into the latest row state.
 *
 * importance is recomputed during rollup (DESIGN_MANUS_B §9-D).
 */

import path from 'path';
import {
  appendJsonl,
  getRuntimePaths,
  loadJsonl,
  tokenizeSearchText,
  uniqueStrings
} from './runtime-lib.mjs';
import { ensureDir } from './utils.mjs';

const ERRORS_JSONL = 'errors.jsonl';

// Stop-tokens shared with learning-curate (kept private here to avoid coupling).
const ERROR_STOP_TOKENS = new Set([
  'error', 'fail', 'failed', 'failure',
  'src', 'js', 'mjs', 'ts', 'md',
  'runtime', 'claude', 'memory', 'event'
]);

function errorsPath(projectDir) {
  const { knowledgeRoot } = getRuntimePaths(projectDir);
  return path.join(knowledgeRoot, ERRORS_JSONL);
}

function isoNow() {
  return new Date().toISOString();
}

function toForwardSlash(p) {
  if (typeof p !== 'string' || p.length === 0) return null;
  return p.replace(/\\/g, '/');
}

function basenamePosix(p) {
  if (typeof p !== 'string' || p.length === 0) return '';
  const norm = p.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

/**
 * "src/foo.ts" → "src/foo/**" (directory glob covering the file's dir).
 * "foo.ts"     → "**" (no leading dir)
 * null/empty   → null
 */
function posixDirGlob(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return null;
  const norm = filePath.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  if (idx <= 0) return '**';
  return `${norm.slice(0, idx)}/**`;
}

function tokenize(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  return tokenizeSearchText(text);
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * §9-B importance formula:
 *   base = 3
 *   base += min(recoveryAttempts * 1.5, 4.5)    // cap +4.5
 *   if !resolved:               base += 1.5
 *   if linkedReflectionPath:    base += 1.0
 *   importance = min(round(base), 10)
 */
export function computeErrorImportance(error) {
  if (!error || typeof error !== 'object') return 3;
  let base = 3;
  const attempts = Number.isFinite(error.recoveryAttempts) ? error.recoveryAttempts : 0;
  base += Math.min(Math.max(attempts, 0) * 1.5, 4.5);
  if (!error.resolved) base += 1.5;
  if (error.linkedReflectionPath) base += 1.0;
  return clamp(Math.round(base), 1, 10);
}

/**
 * §6-C autofill — derive applicable_when from a fail event.
 *   path_glob       = [posixDirGlob(event.detail.filePath)]   (if filePath)
 *   trigger_keywords = tokenize(errorType) + tokenize(toolName)
 *   scope_id        = event.scope || null  (P-M3 — no post-hoc inference)
 */
export function autofillApplicableWhen(event) {
  if (!event || typeof event !== 'object') return null;
  const filePath = event?.detail?.filePath || event?.filePath || null;
  const errorType = event?.detail?.errorType || event?.error?.type || '';
  const toolName = event?.toolName || event?.tool || '';

  const out = {};
  const glob = posixDirGlob(filePath);
  if (glob) out.path_glob = [glob];

  const triggerKeywords = uniqueStrings([
    ...tokenize(errorType),
    ...tokenize(toolName)
  ]).filter((t) => !ERROR_STOP_TOKENS.has(t));
  if (triggerKeywords.length > 0) out.trigger_keywords = triggerKeywords;

  if (typeof event.scope === 'string' && event.scope.length > 0) {
    out.scope_id = event.scope;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * §5-C scope priority — no post-hoc inference.
 *   1. event.scope defined            → use it
 *   2. currentTaskPointer.taskId === event.taskId
 *      → currentTaskPointer.matchedScopes[0]
 *   3. otherwise                      → null
 */
function resolveScope(event, options) {
  if (typeof event?.scope === 'string' && event.scope.length > 0) {
    return event.scope;
  }
  const ptr = options?.currentTaskPointer;
  if (
    ptr
    && typeof ptr.taskId === 'string'
    && typeof event?.taskId === 'string'
    && ptr.taskId === event.taskId
    && Array.isArray(ptr.matchedScopes)
    && ptr.matchedScopes.length > 0
  ) {
    return String(ptr.matchedScopes[0]);
  }
  return null;
}

function buildErrorRow(event, options = {}) {
  const ts = typeof event?.ts === 'string' ? event.ts : isoNow();
  const eventId = event?.eventId || event?.id || `evt-${Date.parse(ts) || Date.now()}`;
  const id = `err-${eventId}`;

  const filePath = toForwardSlash(event?.detail?.filePath || event?.filePath || null);
  const tool = String(event?.toolName || event?.tool || '');
  const errorType = String(
    event?.detail?.errorType || event?.error?.type || 'unknown'
  );
  const rawSummary = String(
    event?.detail?.message || event?.errorMessage || event?.summary || ''
  );
  const summary = rawSummary.replace(/[\r\n]+/g, ' ').slice(0, 180);

  const tokens = uniqueStrings([
    ...tokenize(summary),
    ...tokenize(basenamePosix(filePath || '')),
    ...tokenize(tool)
  ]).filter((t) => !ERROR_STOP_TOKENS.has(t)).slice(0, 32);

  const scope = resolveScope(event, options);
  const recoveryAttempts = Number.isFinite(event?.detail?.recovery_attempts)
    ? event.detail.recovery_attempts
    : 0;

  const row = {
    id,
    timestamp: ts,
    taskId: typeof event?.taskId === 'string' ? event.taskId : null,
    tool,
    errorType,
    summary,
    filePath,
    scope,
    tokens,
    applicable_when: autofillApplicableWhen({ ...event, scope }),
    recoveryAttempts,
    resolved: false,
    linkedReflectionPath: null,
    importance: 0,
    last_accessed_at: ts
  };
  row.importance = computeErrorImportance(row);
  return row;
}

/**
 * Append a normalized error row derived from a fail/error event.
 * Returns { ok, errorId } or { ok: false, reason }.
 */
export function indexErrorEvent(projectDir, event, options = {}) {
  if (!projectDir || typeof projectDir !== 'string') {
    return { ok: false, reason: 'missing_projectDir' };
  }
  if (!event || typeof event !== 'object') {
    return { ok: false, reason: 'missing_event' };
  }
  const isFailLike = event.outcome === 'fail' || event.level === 'error';
  if (!isFailLike) {
    return { ok: false, reason: 'not_fail_event' };
  }
  const row = buildErrorRow(event, options);
  const file = errorsPath(projectDir);
  ensureDir(path.dirname(file));
  appendJsonl(file, row);
  return { ok: true, errorId: row.id };
}

/**
 * Append a `resolved` sentinel for a previously-recorded error id.
 * P-M3 — never mutates existing rows.
 */
export function markResolved(projectDir, errorId, resolutionEvent = {}) {
  if (!projectDir || typeof errorId !== 'string' || errorId.length === 0) {
    return { ok: false, reason: 'missing_args' };
  }
  const sentinel = {
    id: errorId,
    resolution: {
      resolvedAt: typeof resolutionEvent?.ts === 'string' ? resolutionEvent.ts : isoNow(),
      resolvedTaskId: typeof resolutionEvent?.taskId === 'string'
        ? resolutionEvent.taskId
        : null
    }
  };
  const file = errorsPath(projectDir);
  ensureDir(path.dirname(file));
  appendJsonl(file, sentinel);
  return { ok: true };
}

/**
 * Append a `linkedReflectionPath` sentinel for a previously-recorded error id.
 */
export function linkReflection(projectDir, errorId, reflectionPath) {
  if (!projectDir || typeof errorId !== 'string' || errorId.length === 0) {
    return { ok: false, reason: 'missing_args' };
  }
  if (typeof reflectionPath !== 'string' || reflectionPath.length === 0) {
    return { ok: false, reason: 'missing_path' };
  }
  const sentinel = {
    id: errorId,
    linkedReflectionPath: reflectionPath
  };
  const file = errorsPath(projectDir);
  ensureDir(path.dirname(file));
  appendJsonl(file, sentinel);
  return { ok: true };
}

/**
 * Read errors.jsonl with sentinel rollup. Latest base row wins per id; sentinel
 * fields (resolved/linkedReflectionPath) are merged on top, then importance is
 * recomputed (§9-D).
 *
 * Options:
 *   - windowDays?: number  — drop rows whose timestamp is older than `now - windowDays`.
 *   - now?: number (ms)    — for deterministic tests.
 */
export function loadErrors(projectDir, options = {}) {
  const file = errorsPath(projectDir);
  const rows = loadJsonl(file);
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const baseMap = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string') continue;
    const isSentinel = (
      ('resolution' in row || 'linkedReflectionPath' in row)
      && !('summary' in row)
    );
    if (isSentinel) {
      const existing = baseMap.get(row.id);
      if (!existing) continue; // sentinel without base → skip
      if (row.resolution) {
        existing.resolved = true;
        existing.resolvedAt = row.resolution.resolvedAt || null;
        existing.resolvedTaskId = row.resolution.resolvedTaskId || null;
      }
      if (typeof row.linkedReflectionPath === 'string') {
        existing.linkedReflectionPath = row.linkedReflectionPath;
      }
    } else {
      // Base row — last write wins (latest fail event for this id).
      baseMap.set(row.id, { ...row });
    }
  }

  const merged = [];
  for (const row of baseMap.values()) {
    row.importance = computeErrorImportance(row);
    merged.push(row);
  }

  const windowDays = Number.isFinite(options.windowDays) && options.windowDays > 0
    ? options.windowDays
    : null;
  if (windowDays !== null) {
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const cutoff = now - windowDays * 86400 * 1000;
    return merged.filter((row) => {
      const ts = Date.parse(row.timestamp);
      return Number.isFinite(ts) ? ts >= cutoff : true;
    });
  }
  return merged;
}
