/**
 * Shared utilities for Obsidian-Claude runtime integration.
 * Project-neutral pure functions.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function readStdinJson(fallback = {}) {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw.trim()) {
      return fallback;
    }
    return parseJson(raw, fallback);
  } catch {
    return fallback;
  }
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function normalizePath(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

export function normalizeWhitespace(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

export function safeReadFile(filePath, fallback = '') {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

export function resolveProjectPath(projectDir, maybePath) {
  if (!maybePath) {
    return '';
  }
  if (path.isAbsolute(maybePath)) {
    return maybePath;
  }
  return path.join(projectDir, maybePath);
}

export function listFilesRecursive(basePath, filterFn = () => true) {
  if (!fs.existsSync(basePath)) {
    return [];
  }

  const results = [];
  const stack = [basePath];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && filterFn(fullPath, entry)) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

export function limitText(value, maxLength = 1200) {
  const normalized = String(value || '').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

export function sanitizeSlug(value, fallback = 'session') {
  const sanitized = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return sanitized || fallback;
}

export function deriveSessionSlug(input, transcriptPath = '') {
  const rawSessionId = input.session_id || input.sessionId || '';
  if (rawSessionId) {
    return sanitizeSlug(rawSessionId, 'session');
  }
  const baseName = transcriptPath
    ? path.basename(transcriptPath, path.extname(transcriptPath))
    : '';
  if (baseName) {
    return sanitizeSlug(baseName, 'session');
  }
  return crypto.createHash('md5').update(String(Date.now())).digest('hex').slice(0, 8);
}

export function toDateStamp(date = new Date(), timeZone = 'Asia/Seoul') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

export function writeVaultArtifact({
  projectDir,
  vaultRoot,
  relativePath,
  content,
  queueRoot,
  skipIfExists = false
}) {
  const normalizedRelativePath = normalizePath(relativePath).replace(/^\/+/, '');
  const pathSegments = normalizedRelativePath.split('/').filter(Boolean);
  const primaryPath = path.join(vaultRoot, ...pathSegments);
  const fallbackPath = path.join(
    projectDir,
    ...normalizePath(queueRoot).split('/').filter(Boolean),
    ...pathSegments
  );

  if (skipIfExists && (fs.existsSync(primaryPath) || fs.existsSync(fallbackPath))) {
    return {
      storage: fs.existsSync(primaryPath) ? 'vault' : 'queue',
      path: fs.existsSync(primaryPath) ? primaryPath : fallbackPath,
      skipped: true
    };
  }

  try {
    ensureDir(path.dirname(primaryPath));
    fs.writeFileSync(primaryPath, content, 'utf8');
    return { storage: 'vault', path: primaryPath, skipped: false };
  } catch {
    ensureDir(path.dirname(fallbackPath));
    fs.writeFileSync(fallbackPath, content, 'utf8');
    return { storage: 'queue', path: fallbackPath, skipped: false };
  }
}

export function toProjectRelativePath(projectDir, filePath) {
  const resolvedProjectDir = normalizePath(path.resolve(projectDir)).toLowerCase();
  const resolvedFilePath = normalizePath(path.resolve(filePath));
  if (resolvedFilePath.toLowerCase().startsWith(`${resolvedProjectDir}/`)) {
    return normalizePath(path.relative(projectDir, resolvedFilePath));
  }
  return resolvedFilePath;
}
