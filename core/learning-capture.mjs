/**
 * Shared learning-capture engine for Obsidian-Claude runtime.
 *
 * Captures PostToolUse events (file_modified, public_surface_detected,
 * verification_run, verification_failed, tool_failed) and appends them
 * to the per-day event log.  Also updates the active task record with
 * files, verifications, failures, and detected surfaces.
 *
 * Project-specific behaviour is injected via `config`:
 *   config.surfaceSegments   -- path segments that mark a "public surface"
 *   config.inferScope(path)  -- override scope inference (default: inferScopeFromPath)
 */

import fs from 'fs';
import path from 'path';
import {
  appendJsonl,
  getEventFilePath,
  getRuntimePaths,
  inferScopeFromPath,
  loadCurrentTaskPointer,
  parseCliArgs,
  toProjectRelativePath,
  tokenizeSearchText,
  uniqueStrings,
  updateTaskRecord
} from './runtime-lib.mjs';
import { loadObsidianConfig } from './obsidian-config.mjs';
import { normalizePath } from './utils.mjs';

// ── Defaults ───────────────────────────────────────────────────────

const DEFAULT_SURFACE_SEGMENTS = [
  '/routes/',
  '/controllers/',
  '/services/',
  '/websocket/',
  '/middleware/',
  '/hooks/',
  '/stores/',
  '/contexts/',
  '/components/',
  '/app/'
];

const CODE_FILE_PATTERN = /\.(js|jsx|ts|tsx|mjs|cjs|json|yaml|yml|sql|md)$/i;

const VERIFICATION_PATTERNS = [
  /\bnpm\s+(run\s+)?(test|lint|build|typecheck|check)\b/i,
  /\bpnpm\s+(run\s+)?(test|lint|build|typecheck|check)\b/i,
  /\byarn\s+(test|lint|build|typecheck|check)\b/i,
  /\bbun\s+(run\s+)?(test|lint|build|typecheck|check)\b/i,
  /\bvitest\b/i,
  /\bjest\b/i,
  /\bplaywright\b/i,
  /\btsc\b/i,
  /\beslint\b/i,
  /\bnext\s+build\b/i,
  /\bmake\s+(test|lint|build|health|smoke|verify)\b/i,
  /\bcurl\s+/i
];

// ── Dedup constants ────────────────────────────────────────────────

const DEDUP_WINDOW_MS = 30_000;
const DEDUP_LOCK_TTL_MS = 60_000;

// file_read dedup window per Design-A §Z-3-A A-3 / §3-C
const FILE_READ_DEDUP_WINDOW_MS = 60_000;
const FILE_READ_DEDUP_WINDOW_SEC = FILE_READ_DEDUP_WINDOW_MS / 1000;

const READABLE_DOC_VAULT_HINT = '/document/obsidian_context/';

// ── Pure helpers ───────────────────────────────────────────────────

/**
 * file_read 이벤트 대상 판단 (Design-A §1-D, §Z-3-A A-5).
 * true if filePath ends with .md AND
 *   (a) includes '/document/obsidian_context/' OR
 *   (b) starts with vaultRoot prefix.
 *
 * Pure function: vaultRoot is injected (no fs lookup here).
 */
export function isReadableDocPath(filePath, vaultRoot = '') {
  if (!filePath) return false;
  const normalizedPath = normalizePath(String(filePath));
  if (!/\.md$/i.test(normalizedPath)) return false;

  if (normalizedPath.toLowerCase().includes(READABLE_DOC_VAULT_HINT)) {
    return true;
  }
  if (vaultRoot) {
    const normalizedVault = normalizePath(String(vaultRoot)).toLowerCase().replace(/\/+$/, '');
    if (normalizedVault && normalizedPath.toLowerCase().startsWith(`${normalizedVault}/`)) {
      return true;
    }
  }
  return false;
}

export function isVerificationCommand(command) {
  return VERIFICATION_PATTERNS.some((pattern) => pattern.test(command));
}

export function isCodeLikePath(filePath) {
  return CODE_FILE_PATTERN.test(filePath);
}

export function isProjectScopedPath(projectDir, filePath) {
  if (!filePath) return false;
  const resolvedProjectDir = path.resolve(projectDir).toLowerCase();
  const resolvedFilePath = path.resolve(filePath).toLowerCase();
  return (
    resolvedFilePath.startsWith(`${resolvedProjectDir}${path.sep}`) ||
    resolvedFilePath === resolvedProjectDir
  );
}

export function isPublicSurfacePath(filePath, surfaceSegments) {
  const segments = surfaceSegments || DEFAULT_SURFACE_SEGMENTS;
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return segments.some((segment) => normalized.includes(segment));
}

export function inferSurfaceType(filePath) {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  const baseName = path.basename(normalized);

  if (baseName === 'page.tsx') return 'page';
  if (baseName === 'layout.tsx') return 'layout';
  if (baseName === 'route.ts' || baseName === 'route.js') return 'route-handler';
  if (normalized.includes('/routes/')) return 'route';
  if (normalized.includes('/controllers/')) return 'controller';
  if (normalized.includes('/services/')) return 'service';
  if (normalized.includes('/websocket/')) return 'websocket';
  if (normalized.includes('/hooks/')) return 'hook';
  if (normalized.includes('/stores/')) return 'store';
  if (normalized.includes('/contexts/')) return 'context';
  if (normalized.includes('/components/')) return 'component';
  if (normalized.includes('/middleware/')) return 'middleware';
  if (normalized.includes('/app/')) return 'page';

  return 'file';
}

// ── CLI argument parsing ───────────────────────────────────────────

export function parseCaptureArgs(argv) {
  const base = parseCliArgs(argv);
  const args = {
    ...base,
    eventType: '',
    toolName: '',
    filePath: '',
    command: '',
    success: '',
    message: '',
    sessionId: '',
    surfaceType: '',
    score: ''
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--event-type') { args.eventType = argv[index + 1] || ''; index += 1; continue; }
    if (token === '--tool-name') { args.toolName = argv[index + 1] || ''; index += 1; continue; }
    if (token === '--file-path') { args.filePath = argv[index + 1] || ''; index += 1; continue; }
    if (token === '--command') { args.command = argv[index + 1] || ''; index += 1; continue; }
    if (token === '--success') { args.success = argv[index + 1] || ''; index += 1; continue; }
    if (token === '--message') { args.message = argv[index + 1] || ''; index += 1; continue; }
    if (token === '--session-id') { args.sessionId = argv[index + 1] || ''; index += 1; continue; }
    if (token === '--surface-type') { args.surfaceType = argv[index + 1] || ''; index += 1; continue; }
    if (token === '--score') { args.score = argv[index + 1] || ''; index += 1; continue; }
  }

  return args;
}

// ── Payload builder ────────────────────────────────────────────────

function summarizeCommand(command) {
  return String(command || '').trim().replace(/\s+/g, ' ').slice(0, 240);
}

function summarizeMessage(message) {
  return String(message || '').trim().replace(/\s+/g, ' ').slice(0, 280);
}

export function buildEventPayload({
  projectDir,
  taskId,
  sessionId,
  eventType,
  toolName,
  filePath,
  command,
  success,
  message,
  surfaceType,
  score,
  errorOutput,
  config = {}
}) {
  const ts = new Date().toISOString();
  const relativeFilePath = filePath ? toProjectRelativePath(projectDir, filePath) : '';
  const parsedSuccess = String(success).toLowerCase() === 'true';
  const finalSurfaceType = surfaceType || (relativeFilePath ? inferSurfaceType(relativeFilePath) : '');
  const scopeFn = config.inferScope || inferScopeFromPath;

  const detail = {
    filePath: relativeFilePath,
    command: summarizeCommand(command),
    success: parsedSuccess,
    toolName,
    surfaceType: finalSurfaceType,
    score: Number.parseInt(score || '0', 10) || 0,
    errorOutput: String(errorOutput || '').trim().replace(/\s+/g, ' ').slice(0, 500),
    tokens: uniqueStrings([
      ...tokenizeSearchText(relativeFilePath),
      ...tokenizeSearchText(command),
      ...tokenizeSearchText(message)
    ]).slice(0, 20)
  };

  // file_read 전용 필드 (Design-A §3-C)
  if (eventType === 'file_read') {
    const normalizedAbs = normalizePath(filePath || '');
    const vaultRel = computeVaultRelPath(normalizedAbs, config.vaultRoot || '');
    detail.isVaultDoc = true;
    detail.vaultRelPath = vaultRel || relativeFilePath;
    detail.dedupWindowSec = FILE_READ_DEDUP_WINDOW_SEC;
  }

  return {
    ts,
    taskId,
    sessionId,
    eventType,
    toolName,
    scope: relativeFilePath ? scopeFn(relativeFilePath) : 'repo',
    files: relativeFilePath ? [relativeFilePath] : [],
    summary: summarizeMessage(message || command || filePath || eventType),
    detail
  };
}

function computeVaultRelPath(absPath, vaultRoot) {
  if (!absPath) return '';
  if (vaultRoot) {
    const normalizedVault = normalizePath(String(vaultRoot)).toLowerCase().replace(/\/+$/, '');
    const lower = absPath.toLowerCase();
    if (normalizedVault && lower.startsWith(`${normalizedVault}/`)) {
      return absPath.slice(normalizedVault.length + 1);
    }
  }
  const hintIdx = absPath.toLowerCase().indexOf(READABLE_DOC_VAULT_HINT);
  if (hintIdx >= 0) {
    return absPath.slice(hintIdx + READABLE_DOC_VAULT_HINT.length);
  }
  return '';
}

// ── Dedup lock helpers ─────────────────────────────────────────────

function getDedupLockPath(projectDir, taskId, eventType, filePath) {
  const { eventsRoot } = getRuntimePaths(projectDir);
  const suffix = filePath
    ? filePath.replace(/[^a-zA-Z0-9]/g, '_').slice(-60)
    : 'nf';
  return path.join(eventsRoot, `.dedup-capture-${taskId}-${eventType}-${suffix}.lock`);
}

function tryAcquireCaptureLock(lockPath, windowMs) {
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs < windowMs) return false;
    fs.rmSync(lockPath, { force: true });
  } catch { /* file doesn't exist */ }
  try {
    fs.writeFileSync(lockPath, String(Date.now()), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

export function cleanStaleDedupCaptureLocks(projectDir) {
  const { eventsRoot } = getRuntimePaths(projectDir);
  try {
    for (const name of fs.readdirSync(eventsRoot)) {
      if (!name.startsWith('.dedup-capture-') || !name.endsWith('.lock')) continue;
      try {
        const stat = fs.statSync(path.join(eventsRoot, name));
        if (Date.now() - stat.mtimeMs > DEDUP_LOCK_TTL_MS) {
          fs.rmSync(path.join(eventsRoot, name), { force: true });
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
}

// ── Main capture function ──────────────────────────────────────────

/**
 * @param {string} projectDir - absolute path to project root
 * @param {object} options    - event fields (eventType, filePath, command, etc.)
 * @param {object} [config]   - project-specific overrides
 * @param {string[]} [config.surfaceSegments] - path segments for public surface detection
 * @param {function} [config.inferScope]      - (relativePath) => scopeString
 */
export function captureLearningEvent(projectDir, options = {}, config = {}) {
  const pointer = loadCurrentTaskPointer(projectDir);
  const taskId = options.taskId || pointer?.taskId || '';
  if (!taskId || !options.eventType) {
    return { ok: false, reason: 'missing_task_or_event_type' };
  }

  if (options.filePath && !isProjectScopedPath(projectDir, options.filePath)) {
    return { ok: false, reason: 'outside_project_file' };
  }

  const dedupEventTypes = new Set(['file_modified', 'public_surface_detected']);
  if (dedupEventTypes.has(options.eventType)) {
    const relPath = options.filePath
      ? toProjectRelativePath(projectDir, options.filePath)
      : '';
    const lockPath = getDedupLockPath(projectDir, taskId, options.eventType, relPath);
    if (!tryAcquireCaptureLock(lockPath, DEDUP_WINDOW_MS)) {
      return { ok: false, reason: 'deduplicated', taskId, eventType: options.eventType };
    }
  }

  if (Math.random() < 0.05) {
    cleanStaleDedupCaptureLocks(projectDir);
  }

  const payload = buildEventPayload({
    projectDir,
    taskId,
    sessionId: options.sessionId || '',
    eventType: options.eventType,
    toolName: options.toolName || '',
    filePath: options.filePath || '',
    command: options.command || '',
    success: options.success || '',
    message: options.message || '',
    surfaceType: options.surfaceType || '',
    score: options.score || '',
    errorOutput: options.errorOutput || '',
    config
  });

  appendJsonl(getEventFilePath(projectDir, new Date(payload.ts)), payload);

  const filePath = payload.files[0] || '';
  const isVerification = payload.eventType === 'verification_run' || payload.eventType === 'verification_failed';
  const isFailure = payload.eventType === 'tool_failed' || payload.eventType === 'verification_failed';
  const isSurface = payload.eventType === 'public_surface_detected';

  const updatedTask = updateTaskRecord(projectDir, (task) => {
    const files = uniqueStrings([...(task.files || []), ...payload.files]);
    const verifications = Array.isArray(task.verifications) ? task.verifications : [];
    const failures = Array.isArray(task.failures) ? task.failures : [];
    const surfaces = Array.isArray(task.detectedSurfaces) ? task.detectedSurfaces : [];

    if (isVerification) {
      verifications.push({
        ts: payload.ts,
        command: payload.detail.command,
        success: payload.detail.success,
        summary: payload.summary
      });
    }

    if (isFailure) {
      failures.push({
        ts: payload.ts,
        eventType: payload.eventType,
        summary: payload.summary,
        filePath,
        errorOutput: payload.detail.errorOutput || ''
      });
    }

    if (isSurface && filePath) {
      const nextSurface = {
        ts: payload.ts,
        path: filePath,
        surfaceType: payload.detail.surfaceType || inferSurfaceType(filePath)
      };
      const surfaceKey = `${nextSurface.path}:${nextSurface.surfaceType}`;
      const deduped = new Map(
        surfaces.map((entry) => [`${entry.path}:${entry.surfaceType}`, entry])
      );
      deduped.set(surfaceKey, nextSurface);
      surfaces.length = 0;
      surfaces.push(...Array.from(deduped.values()));
    }

    return {
      ...task,
      updatedAt: payload.ts,
      files,
      verifications: verifications.slice(-20),
      failures: failures.slice(-20),
      detectedSurfaces: surfaces,
      lastEvent: {
        ts: payload.ts,
        eventType: payload.eventType,
        summary: payload.summary
      }
    };
  }, taskId);

  if (isSurface && filePath) {
    appendJsonl(
      path.join(projectDir, '.claude', 'runtime', 'architecture', 'detected-surfaces.jsonl'),
      {
        ts: payload.ts,
        taskId,
        path: filePath,
        surfaceType: payload.detail.surfaceType || inferSurfaceType(filePath),
        scope: payload.scope
      }
    );
  }

  return {
    ok: true,
    taskId,
    eventType: payload.eventType,
    filePath,
    taskUpdated: Boolean(updatedTask),
    summary: payload.summary
  };
}

// ── file_read public API ───────────────────────────────────────────

function getFileReadLockPath(projectDir, sessionId, vaultRelOrPath) {
  const { eventsRoot } = getRuntimePaths(projectDir);
  const sessSlug = String(sessionId || 'nosession').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 32);
  const pathSlug = String(vaultRelOrPath || 'nf').replace(/[^a-zA-Z0-9]/g, '_').slice(-80);
  return path.join(eventsRoot, `.dedup-fileread-${sessSlug}-${pathSlug}.lock`);
}

function tryAcquireFileReadLock(lockPath, windowMs = FILE_READ_DEDUP_WINDOW_MS) {
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs < windowMs) return false;
    fs.rmSync(lockPath, { force: true });
  } catch { /* lock missing — proceed */ }
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, String(Date.now()), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Capture a file_read event for retrieval-quality metrics (Design-A §1-D, §2-F).
 *
 * @param {string} projectDir
 * @param {object} options
 *   - filePath:  string (absolute or project-relative). Required.
 *   - toolName:  string (default 'Read').
 *   - sessionId: string (used for dedup key).
 *   - taskId:    string (optional; falls back to current pointer).
 *   - vaultRoot: string (optional override; falls back to obsidian-config).
 * @returns {{ ok: boolean, event?: object, skipped?: 'duplicate'|'not_doc'|'missing_filepath' }}
 */
export function captureFileRead(projectDir, options = {}) {
  const filePath = options.filePath || '';
  if (!filePath) {
    return { ok: false, skipped: 'missing_filepath' };
  }

  let vaultRoot = options.vaultRoot || '';
  if (!vaultRoot) {
    try {
      vaultRoot = loadObsidianConfig(projectDir).vaultRoot || '';
    } catch {
      vaultRoot = '';
    }
  }

  if (!isReadableDocPath(filePath, vaultRoot)) {
    return { ok: false, skipped: 'not_doc' };
  }

  const pointer = loadCurrentTaskPointer(projectDir);
  const taskId = options.taskId || pointer?.taskId || '';
  const sessionId = options.sessionId || '';
  const toolName = options.toolName || 'Read';

  const normalizedAbs = normalizePath(filePath);
  const vaultRel = computeVaultRelPath(normalizedAbs, vaultRoot) || normalizedAbs;
  const lockPath = getFileReadLockPath(projectDir, sessionId, vaultRel);
  if (!tryAcquireFileReadLock(lockPath)) {
    return { ok: false, skipped: 'duplicate' };
  }

  const payload = buildEventPayload({
    projectDir,
    taskId,
    sessionId,
    eventType: 'file_read',
    toolName,
    filePath,
    command: '',
    success: '',
    message: '',
    surfaceType: '',
    score: '',
    errorOutput: '',
    config: { vaultRoot }
  });

  appendJsonl(getEventFilePath(projectDir, new Date(payload.ts)), payload);

  return { ok: true, event: payload };
}

// ── CLI entry point (when invoked directly) ────────────────────────

const args = parseCaptureArgs(process.argv.slice(2));
const currentFilePath = path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1'));
const invokedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : '';

if (currentFilePath === invokedFilePath) {
  const projectDir = path.resolve(args.projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const result = captureLearningEvent(projectDir, args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
