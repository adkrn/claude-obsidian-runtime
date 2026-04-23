#!/usr/bin/env node

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  ensureDir,
  limitText,
  loadJson,
  normalizePath,
  sanitizeSlug,
  toDateStamp
} from './utils.mjs';

const RUNTIME_DIR_NAMES = [
  'tasks',
  'events',
  'retrieval',
  'code-index',
  'knowledge',
  'architecture'
];

const SEARCH_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'be',
  'by',
  'for',
  'from',
  'how',
  'in',
  'into',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'use',
  'with',
  '작업',
  '구조',
  '관련',
  '기능',
  '문서',
  '방법',
  '방식',
  '수정',
  '이슈',
  '현재',
  '클로드',
  '코드',
  '토큰',
  '파일',
  '흐름'
]);

function toTimeStamp(date = new Date(), timeZone = 'Asia/Seoul') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit'
  }).formatToParts(date);

  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.hour}${lookup.minute}`;
}

export function getRuntimePaths(projectDir) {
  const runtimeRoot = path.join(projectDir, '.claude', 'runtime');

  return {
    runtimeRoot,
    currentTaskPath: path.join(runtimeRoot, 'current-task.json'),
    tasksRoot: path.join(runtimeRoot, 'tasks'),
    eventsRoot: path.join(runtimeRoot, 'events'),
    retrievalRoot: path.join(runtimeRoot, 'retrieval'),
    lastContextPath: path.join(runtimeRoot, 'retrieval', 'last-context.json'),
    lastPlanPath: path.join(runtimeRoot, 'retrieval', 'last-plan.json'),
    codeIndexRoot: path.join(runtimeRoot, 'code-index'),
    knowledgeRoot: path.join(runtimeRoot, 'knowledge'),
    architectureRoot: path.join(runtimeRoot, 'architecture')
  };
}

export function ensureRuntimeLayout(projectDir) {
  const paths = getRuntimePaths(projectDir);
  ensureDir(paths.runtimeRoot);

  for (const dirName of RUNTIME_DIR_NAMES) {
    ensureDir(path.join(paths.runtimeRoot, dirName));
  }

  return paths;
}

export function writeJsonFile(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

export function removeFile(filePath) {
  fs.rmSync(filePath, { force: true });
}

export function appendJsonl(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

export function loadJsonl(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function readJsonlTail(filePath, count = 10) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return lines.slice(-count).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

export function writeJsonlFile(filePath, rows) {
  ensureDir(path.dirname(filePath));
  const content = (rows || []).map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, content ? `${content}\n` : '', 'utf8');
}

export function splitCamelCase(value) {
  return String(value || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

export function uniqueStrings(items) {
  return Array.from(new Set((items || []).filter(Boolean)));
}

export function getTaskSessionEntry(task, sessionId = '') {
  if (!sessionId) {
    return null;
  }

  const sessionTimeline = Array.isArray(task?.sessionTimeline)
    ? task.sessionTimeline
    : [];

  return sessionTimeline.find((entry) => entry?.sessionId === sessionId) || null;
}

export function upsertTaskSessionTimeline(task, update = {}) {
  const sessionId = String(update.sessionId || '').trim();
  if (!sessionId) {
    return Array.isArray(task?.sessionTimeline) ? task.sessionTimeline : [];
  }

  const sessionTimeline = Array.isArray(task?.sessionTimeline)
    ? [...task.sessionTimeline]
    : [];
  const normalizedTranscriptPath = update.transcriptPath
    ? normalizePath(update.transcriptPath)
    : '';
  const nextEntry = {
    sessionId,
    startedAt: String(update.startedAt || '').trim(),
    endedAt: String(update.endedAt || '').trim(),
    lastSeenAt: String(update.lastSeenAt || '').trim(),
    transcriptPath: normalizedTranscriptPath
  };
  const existingIndex = sessionTimeline.findIndex((entry) => entry?.sessionId === sessionId);

  if (existingIndex === -1) {
    sessionTimeline.push(nextEntry);
    return sessionTimeline;
  }

  const currentEntry = sessionTimeline[existingIndex] || {};
  sessionTimeline[existingIndex] = {
    sessionId,
    startedAt: currentEntry.startedAt || nextEntry.startedAt,
    endedAt: nextEntry.endedAt || currentEntry.endedAt || '',
    lastSeenAt: nextEntry.lastSeenAt || currentEntry.lastSeenAt || '',
    transcriptPath: nextEntry.transcriptPath || currentEntry.transcriptPath || ''
  };

  return sessionTimeline;
}

export function tokenizeSearchText(value) {
  const normalized = splitCamelCase(String(value || ''))
    .toLowerCase()
    .replace(/[`*_#[\]{}()<>:;"',.?!=+\\/|]/g, ' ');

  const tokens = normalized
    .split(/[^a-z0-9가-힣_-]+/)
    .flatMap((token) => token.split(/[_-]+/))
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .filter((token) => !SEARCH_STOPWORDS.has(token));

  return uniqueStrings(tokens);
}

export function createTaskId(task, date = new Date()) {
  const datePart = toDateStamp(date).replace(/-/g, '');
  const timePart = toTimeStamp(date);
  const rawSlug = sanitizeSlug(task, 'task').slice(0, 32);
  const slug = rawSlug === 'task'
    ? `task-${crypto.createHash('md5').update(String(task || '')).digest('hex').slice(0, 8)}`
    : rawSlug;
  return `${datePart}-${timePart}-${slug}`;
}

export function parseCliArgs(argv) {
  const args = {
    task: '',
    taskId: '',
    sessionId: '',
    projectDir: '',
    limit: 6,
    dryRun: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '--task') {
      const taskTokens = [];
      for (let j = index + 1; j < argv.length; j++) {
        if (argv[j].startsWith('--')) break;
        taskTokens.push(argv[j]);
      }
      args.task = taskTokens.join(' ').trim();
      continue;
    }

    if (token === '--task-id') {
      args.taskId = argv[index + 1] || '';
      index += 1;
      continue;
    }

    if (token === '--session-id') {
      args.sessionId = argv[index + 1] || '';
      index += 1;
      continue;
    }

    if (token === '--project-dir') {
      args.projectDir = argv[index + 1] || '';
      index += 1;
      continue;
    }

    if (token === '--limit') {
      const parsed = Number.parseInt(argv[index + 1], 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        args.limit = parsed;
      }
      index += 1;
      continue;
    }

    if (token === '--dry-run') {
      args.dryRun = true;
      continue;
    }
  }

  return args;
}

export function inferScopeFromPath(filePath) {
  const normalized = normalizePath(filePath);

  if (normalized.startsWith('.claude/') || normalized.startsWith('scripts/')) {
    return 'workflow';
  }

  if (normalized.startsWith('backend/')) {
    return 'backend';
  }

  if (normalized.startsWith('frontend_admin/')) {
    return 'frontend_admin';
  }

  if (normalized.startsWith('frontend/')) {
    return 'frontend';
  }

  return 'repo';
}

export function loadCurrentTaskPointer(projectDir) {
  return loadJson(getRuntimePaths(projectDir).currentTaskPath, null);
}

export function writeCurrentTaskPointer(projectDir, value) {
  writeJsonFile(getRuntimePaths(projectDir).currentTaskPath, value);
}

export function clearCurrentTaskPointer(projectDir, taskId = '') {
  const pointer = loadCurrentTaskPointer(projectDir);
  if (taskId && pointer?.taskId && pointer.taskId !== taskId) {
    return false;
  }

  removeFile(getRuntimePaths(projectDir).currentTaskPath);
  return true;
}

function getSessionTaskPath(projectDir, sessionId) {
  return path.join(getRuntimePaths(projectDir).runtimeRoot, `current-task-${sessionId}.json`);
}

export function writeSessionTaskPointer(projectDir, sessionId, value) {
  if (!sessionId) {
    return;
  }
  writeJsonFile(getSessionTaskPath(projectDir, sessionId), value);
}

export function loadSessionTaskPointer(projectDir, sessionId) {
  if (!sessionId) {
    return null;
  }
  return loadJson(getSessionTaskPath(projectDir, sessionId), null);
}

export function clearSessionTaskPointer(projectDir, sessionId, taskId = '') {
  if (!sessionId) {
    return false;
  }
  const filePath = getSessionTaskPath(projectDir, sessionId);
  if (!fs.existsSync(filePath)) {
    return false;
  }
  const pointer = loadJson(filePath, null);
  if (taskId && pointer?.taskId && pointer.taskId !== taskId) {
    return false;
  }
  removeFile(filePath);
  return true;
}

const STALE_POINTER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_TASK_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function cleanStaleSessionPointers(projectDir) {
  const runtimeRoot = getRuntimePaths(projectDir).runtimeRoot;
  const now = Date.now();
  const removed = [];

  try {
    const entries = fs.readdirSync(runtimeRoot).filter(
      (name) => name.startsWith('current-task-') && name.endsWith('.json')
    );

    for (const entry of entries) {
      const filePath = path.join(runtimeRoot, entry);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > STALE_POINTER_TTL_MS) {
          removeFile(filePath);
          removed.push(entry);
        }
      } catch {
        // skip unreadable files
      }
    }
  } catch {
    // skip if dir unreadable
  }

  return removed;
}

export function archiveStaleTasks(projectDir) {
  const paths = getRuntimePaths(projectDir);
  const archiveRoot = path.join(paths.runtimeRoot, 'archive');
  const now = Date.now();
  const archived = [];

  try {
    const entries = fs.readdirSync(paths.tasksRoot).filter(
      (name) => name.endsWith('.json')
    );

    for (const entry of entries) {
      const filePath = path.join(paths.tasksRoot, entry);
      try {
        const task = loadJson(filePath, null);
        if (
          task?.status === 'completed' &&
          task.closedAt &&
          now - new Date(task.closedAt).getTime() > STALE_TASK_TTL_MS
        ) {
          ensureDir(archiveRoot);
          const archivePath = path.join(archiveRoot, entry);
          fs.renameSync(filePath, archivePath);
          archived.push(entry);
        }
      } catch {
        // skip unreadable tasks
      }
    }
  } catch {
    // skip if dir unreadable
  }

  return archived;
}

export function loadTaskRecord(projectDir, taskId = '') {
  const pointer = loadCurrentTaskPointer(projectDir);
  const taskPath = taskId
    ? path.join(getRuntimePaths(projectDir).tasksRoot, `${taskId}.json`)
    : pointer?.taskPath
      ? path.resolve(pointer.taskPath)
      : '';

  if (!taskPath || !fs.existsSync(taskPath)) {
    return null;
  }

  return {
    taskPath,
    task: loadJson(taskPath, null)
  };
}

export function updateTaskRecord(projectDir, updater, taskId = '') {
  const loaded = loadTaskRecord(projectDir, taskId);
  if (!loaded?.taskPath || !loaded.task) {
    return null;
  }

  const nextTask = updater({
    ...loaded.task
  });

  if (!nextTask) {
    return null;
  }

  writeJsonFile(loaded.taskPath, nextTask);
  const pointer = loadCurrentTaskPointer(projectDir);
  if (pointer?.taskId === nextTask.taskId) {
    writeJsonFile(
      getRuntimePaths(projectDir).currentTaskPath,
      toTaskPointer(nextTask, loaded.taskPath, pointer.contextPath || getRuntimePaths(projectDir).lastContextPath)
    );
  }

  return {
    taskPath: loaded.taskPath,
    task: nextTask
  };
}

export function loadLatestWorklogSummary(projectDir) {
  const latest = loadJson(path.join(projectDir, 'report', 'worklog', 'latest.json'), null);
  if (!latest) {
    return null;
  }

  const worklogArtifact = Array.isArray(latest.artifacts)
    ? latest.artifacts.find((artifact) => artifact.type === 'worklog')
    : null;

  return {
    date: latest.date || '',
    sessionId: latest.sessionId || '',
    hookEventName: latest.hookEventName || '',
    modifiedFileCount: Array.isArray(latest.modifiedFiles) ? latest.modifiedFiles.length : 0,
    failureCount: Array.isArray(latest.failures) ? latest.failures.length : 0,
    worklogPath: normalizePath(worklogArtifact?.path || ''),
    worklogRelativePath: worklogArtifact?.relativePath || '',
    architectureRecommendations: Array.isArray(latest.architectureRecommendations)
      ? latest.architectureRecommendations
      : []
  };
}

export function getEventFilePath(projectDir, date = new Date()) {
  const paths = getRuntimePaths(projectDir);
  return path.join(paths.eventsRoot, `${toDateStamp(date)}.jsonl`);
}

export function toTaskPointer(task, taskFilePath, contextFilePath) {
  return {
    taskId: task.taskId,
    title: limitText(task.title || task.prompt || task.taskId, 120),
    status: task.status || 'active',
    updatedAt: task.updatedAt || new Date().toISOString(),
    taskPath: normalizePath(taskFilePath),
    contextPath: normalizePath(contextFilePath),
    matchedScopes: task.matchedScopes || []
  };
}

export function toProjectRelativePath(projectDir, filePath) {
  const resolvedProjectDir = normalizePath(path.resolve(projectDir)).toLowerCase();
  const resolvedFilePath = normalizePath(path.resolve(filePath));

  if (resolvedFilePath.toLowerCase().startsWith(`${resolvedProjectDir}/`)) {
    return normalizePath(path.relative(projectDir, resolvedFilePath));
  }

  return normalizePath(filePath);
}

export function loadTaskEvents(projectDir, taskId) {
  const runtimePaths = getRuntimePaths(projectDir);
  if (!fs.existsSync(runtimePaths.eventsRoot)) {
    return [];
  }

  return fs.readdirSync(runtimePaths.eventsRoot)
    .filter((entry) => entry.toLowerCase().endsWith('.jsonl'))
    .flatMap((entry) => loadJsonl(path.join(runtimePaths.eventsRoot, entry)))
    .filter((row) => row?.taskId === taskId)
    .sort((left, right) => String(left.ts || '').localeCompare(String(right.ts || '')));
}

export function formatMarkdownList(items, emptyLabel = '없음') {
  if (!items || items.length === 0) {
    return `- ${emptyLabel}`;
  }

  return items.map((item) => `- ${item}`).join('\n');
}

export function shortenPath(filePath) {
  return `\`${normalizePath(filePath)}\``;
}

export function findTaskBySessionId(projectDir, sessionId) {
  if (!sessionId) {
    return null;
  }
  const runtimePaths = getRuntimePaths(projectDir);
  const tasksRoot = runtimePaths.tasksRoot;
  if (!fs.existsSync(tasksRoot)) {
    return null;
  }
  const entries = fs.readdirSync(tasksRoot).filter((f) => f.endsWith('.json'));
  for (const entry of entries) {
    const taskPath = path.join(tasksRoot, entry);
    const task = loadJson(taskPath, null);
    if (task && Array.isArray(task.sessionIds) && task.sessionIds.includes(sessionId)) {
      return { task, taskPath };
    }
  }
  return null;
}
