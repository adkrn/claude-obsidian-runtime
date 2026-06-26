#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

// pruneKnowledgeForRemovedArchitectures is project-specific.
// Projects inject via options.pruneCallback. Default is no-op.
const DEFAULT_PRUNE = () => ({ removedArchitectures: [], deletedDocs: [], updatedDocs: [], runtimePruned: {} });


const DEFAULT_SYNC_CACHE_TTL_MS = 5 * 60 * 1000;

const QUARANTINE_DIR_NAME = '_quarantine';
const DEFAULT_QUARANTINE_TTL_DAYS = 7;
const DEFAULT_PRUNE_WARN_BYTES = 2048;

function quarantineRoot(contextRoot) {
  return path.join(contextRoot, QUARANTINE_DIR_NAME);
}

function todayStamp(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function timeSuffix(date = new Date()) {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${h}${m}${s}`;
}

function quarantineWarnBytes() {
  const raw = Number(process.env.OBSIDIAN_PRUNE_WARN_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PRUNE_WARN_BYTES;
}

function quarantineTtlMs() {
  const raw = Number(process.env.OBSIDIAN_QUARANTINE_TTL_DAYS);
  const days = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_QUARANTINE_TTL_DAYS;
  return days * 24 * 60 * 60 * 1000;
}

// Move a single file into <contextRoot>/_quarantine/<YYYY-MM-DD>/<root>/<relPath>.
// Falls back to copy+rm when rename crosses volumes. Returns { quarantinedPath, bytes }.
function moveFileToQuarantine(contextRoot, sourceAbsPath, mirrorRelativePath, now = new Date()) {
  const baseDir = path.join(quarantineRoot(contextRoot), todayStamp(now));
  let destPath = path.join(baseDir, mirrorRelativePath);
  ensureDir(path.dirname(destPath));

  if (fs.existsSync(destPath)) {
    const ext = path.extname(destPath);
    const stem = destPath.slice(0, destPath.length - ext.length);
    destPath = `${stem}.${timeSuffix(now)}${ext}`;
  }

  let bytes = 0;
  try {
    bytes = fs.statSync(sourceAbsPath).size;
  } catch {
    bytes = 0;
  }

  try {
    fs.renameSync(sourceAbsPath, destPath);
  } catch {
    // Cross-device or locked: fall back to copy + remove.
    fs.copyFileSync(sourceAbsPath, destPath);
    fs.rmSync(sourceAbsPath, { force: true });
  }

  return { quarantinedPath: destPath, bytes };
}

// Move a whole directory into quarantine. Same date/conflict rules as moveFileToQuarantine.
function moveDirToQuarantine(contextRoot, sourceAbsDir, mirrorRelativePath, now = new Date()) {
  const baseDir = path.join(quarantineRoot(contextRoot), todayStamp(now));
  let destPath = path.join(baseDir, mirrorRelativePath);
  ensureDir(path.dirname(destPath));

  if (fs.existsSync(destPath)) {
    destPath = `${destPath}.${timeSuffix(now)}`;
  }

  try {
    fs.renameSync(sourceAbsDir, destPath);
  } catch {
    // Best-effort recursive copy fallback. Node 16+ supports cpSync.
    if (typeof fs.cpSync === 'function') {
      fs.cpSync(sourceAbsDir, destPath, { recursive: true });
    } else {
      ensureDir(destPath);
      for (const entry of fs.readdirSync(sourceAbsDir, { withFileTypes: true })) {
        const childSrc = path.join(sourceAbsDir, entry.name);
        const childDest = path.join(destPath, entry.name);
        if (entry.isDirectory()) {
          moveDirToQuarantine(destPath, childSrc, entry.name, now);
        } else {
          fs.copyFileSync(childSrc, childDest);
        }
      }
    }
    fs.rmSync(sourceAbsDir, { recursive: true, force: true });
  }

  return { quarantinedPath: destPath };
}

// Purge entries under _quarantine whose mtime is older than the configured TTL.
function purgeExpiredQuarantine(contextRoot, now = Date.now()) {
  const root = quarantineRoot(contextRoot);
  if (!fs.existsSync(root)) return;
  const ttlMs = quarantineTtlMs();
  const cutoff = now - ttlMs;

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (entry.isDirectory()) {
        walk(full);
        try {
          if (fs.readdirSync(full).length === 0 && stat.mtimeMs < cutoff) {
            fs.rmdirSync(full);
          }
        } catch {
          // ignore
        }
      } else if (stat.mtimeMs < cutoff) {
        try { fs.rmSync(full, { force: true }); } catch { /* ignore */ }
      }
    }
  }

  walk(root);
}

export function normalizePathValue(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

/**
 * True iff two paths resolve to the same directory on disk.
 *
 * Guards the musicGame-style misconfig where vaultRoot and contextRoot point at
 * the same folder (differing only by drive-letter case, separators, or trailing
 * slash). Mirroring a directory onto itself makes obsidian-sync treat its own
 * exclude-only artifact folders (Drafts/Generated) as mirror-only orphans and
 * quarantine real session artifacts. Uses realpath when both exist (absorbs
 * case/symlink on Windows/macOS), else falls back to resolved+normalized compare.
 */
export function isSamePath(a, b) {
  if (!a || !b) return false;
  const resolve = (p) => {
    try {
      return normalizePathValue(fs.realpathSync.native(p)).toLowerCase();
    } catch {
      return normalizePathValue(path.resolve(String(p))).toLowerCase();
    }
  };
  return resolve(a) === resolve(b);
}

function listMarkdownFiles(basePath) {
  if (!fs.existsSync(basePath)) {
    return [];
  }

  try {
    const entries = fs.readdirSync(basePath, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
      const fullPath = path.join(basePath, entry.name);
      if (entry.isDirectory()) {
        files.push(...listMarkdownFiles(fullPath));
        continue;
      }

      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        files.push(fullPath);
      }
    }

    return files;
  } catch {
    return [];
  }
}

function hashFile(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function isExcludedMirrorPath(relativePath, excludedRoots) {
  const normalizedRelativePath = normalizePathValue(relativePath);
  return excludedRoots.some((root) =>
    normalizedRelativePath === root || normalizedRelativePath.startsWith(`${root}/`)
  );
}

function cleanupExcludedMirrorRoots(contextRoot, excludedRoots, now = new Date()) {
  for (const root of excludedRoots) {
    if (!root) {
      continue;
    }
    if (root === QUARANTINE_DIR_NAME) {
      // Never quarantine the quarantine directory itself.
      continue;
    }

    const targetPath = path.join(contextRoot, root);
    try {
      if (fs.existsSync(targetPath)) {
        moveDirToQuarantine(contextRoot, targetPath, root, now);
      }
    } catch {
      // best effort cleanup only
    }
  }
}

function getSyncCachePath(projectDir) {
  const hash = crypto.createHash('md5').update(projectDir).digest('hex').slice(0, 8);
  return path.join(os.tmpdir(), `obsidian_sync_cache_${hash}.json`);
}

function readSyncCache(projectDir, cacheTtlMs) {
  const cachePath = getSyncCachePath(projectDir);
  try {
    const raw = fs.readFileSync(cachePath, 'utf8');
    const cache = JSON.parse(raw);
    if (Date.now() - cache.timestamp < cacheTtlMs) {
      return cache.result;
    }
  } catch {
    // cache miss or corrupt
  }

  return null;
}

function writeSyncCache(projectDir, result) {
  const cachePath = getSyncCachePath(projectDir);
  try {
    fs.writeFileSync(cachePath, JSON.stringify({ timestamp: Date.now(), result }));
  } catch {
    // non-critical
  }
}

function getMirrorSettings(config) {
  return {
    contextRoot: config.contextRoot,
    managedRoots: config.managedRoots,
    mirrorExcludeRoots: (config.mirrorExcludeRoots || [])
      .map((root) => normalizePathValue(root))
      .filter(Boolean)
  };
}

function shouldCascadeArchitectureRemoval(relativePath) {
  const normalized = normalizePathValue(relativePath).toLowerCase();
  return normalized.endsWith('.md') &&
    !normalized.startsWith('04_architecture/drafts/') &&
    !normalized.startsWith('04_architecture/generated/');
}

export function collectManagedRootStatus(projectDir, config) {
  const { contextRoot, managedRoots, mirrorExcludeRoots } = getMirrorSettings(config);

  return managedRoots.map((root) => {
    const sourceRoot = path.join(config.vaultRoot, root);
    const targetRoot = path.join(contextRoot, root);
    const sourceCount = listMarkdownFiles(sourceRoot).filter((filePath) => {
      const relativePath = normalizePathValue(path.relative(sourceRoot, filePath));
      return !isExcludedMirrorPath(path.join(root, relativePath), mirrorExcludeRoots);
    }).length;
    const targetCount = listMarkdownFiles(targetRoot).filter((filePath) => {
      const relativePath = normalizePathValue(path.relative(targetRoot, filePath));
      return !isExcludedMirrorPath(path.join(root, relativePath), mirrorExcludeRoots);
    }).length;

    return {
      root,
      sourceCount,
      targetCount,
      sourcePath: sourceRoot,
      targetPath: targetRoot
    };
  });
}

export function syncManagedRoots(projectDir, config, options = {}) {
  const {
    useCache = false,
    cacheTtlMs = DEFAULT_SYNC_CACHE_TTL_MS,
    pruneCallback = DEFAULT_PRUNE
  } = options;

  if (useCache) {
    const cached = readSyncCache(projectDir, cacheTtlMs);
    if (cached) {
      return cached;
    }
  }

  if (config.vaultAvailable === false) {
    const result = { ok: false, message: 'vault not found, skipping sync', summary: [], skipped: true };
    if (useCache) {
      writeSyncCache(projectDir, result);
    }
    return result;
  }

  // vaultRoot === contextRoot: mirroring a directory onto itself would quarantine
  // its own exclude-only artifact folders (Drafts/Generated). Skip — there is no
  // separate source to mirror from, and self-prune is pure data risk.
  if (isSamePath(config.vaultRoot, config.contextRoot)) {
    const result = {
      ok: true,
      message: 'vaultRoot equals contextRoot — mirror skipped (no self-prune)',
      summary: [],
      skipped: true,
      reason: 'vault-equals-context'
    };
    if (useCache) {
      writeSyncCache(projectDir, result);
    }
    return result;
  }

  const { contextRoot, managedRoots, mirrorExcludeRoots } = getMirrorSettings(config);
  const summary = [];
  const removedArchitectureProfiles = [];
  const quarantineWarnings = [];
  const warnByteThreshold = quarantineWarnBytes();
  const now = new Date();
  let totalQuarantined = 0;

  try {
    ensureDir(contextRoot);

    for (const root of managedRoots) {
      const sourceRoot = path.join(config.vaultRoot, root);
      const targetRoot = path.join(contextRoot, root);
      const sourceFiles = listMarkdownFiles(sourceRoot);
      const sourceRelativePaths = new Set();
      let copied = 0;
      let removed = 0;
      let quarantined = 0;

      ensureDir(targetRoot);

      for (const sourceFile of sourceFiles) {
        const relativePath = normalizePathValue(path.relative(sourceRoot, sourceFile));
        const mirrorRelativePath = normalizePathValue(path.join(root, relativePath));
        if (isExcludedMirrorPath(mirrorRelativePath, mirrorExcludeRoots)) {
          continue;
        }

        sourceRelativePaths.add(relativePath);
        const targetFile = path.join(targetRoot, relativePath);
        ensureDir(path.dirname(targetFile));

        if (!fs.existsSync(targetFile) || hashFile(sourceFile) !== hashFile(targetFile)) {
          fs.copyFileSync(sourceFile, targetFile);
          copied += 1;
        }
      }

      const targetFiles = listMarkdownFiles(targetRoot);
      for (const targetFile of targetFiles) {
        const relativePath = normalizePathValue(path.relative(targetRoot, targetFile));
        const mirrorRelativePath = normalizePathValue(path.join(root, relativePath));
        const isExcluded = isExcludedMirrorPath(mirrorRelativePath, mirrorExcludeRoots);
        const isMissingFromSource = !sourceRelativePaths.has(relativePath);
        if (isExcluded || isMissingFromSource) {
          // Capture architecture profile content BEFORE the move; rename invalidates the path.
          if (
            root === '04_Architecture' &&
            isMissingFromSource &&
            shouldCascadeArchitectureRemoval(mirrorRelativePath)
          ) {
            removedArchitectureProfiles.push({
              relativePath: mirrorRelativePath,
              content: fs.readFileSync(targetFile, 'utf8')
            });
          }
          const { bytes } = moveFileToQuarantine(contextRoot, targetFile, mirrorRelativePath, now);
          if (bytes > warnByteThreshold) {
            const warnLine = `[obsidian-sync][warn] large prune candidate: ${mirrorRelativePath} (${bytes} bytes) -> quarantined`;
            try { process.stderr.write(`${warnLine}\n`); } catch { /* ignore */ }
            quarantineWarnings.push({ relativePath: mirrorRelativePath, bytes });
          }
          quarantined += 1;
          totalQuarantined += 1;
          removed += 1;
        }
      }

      summary.push({
        root,
        copied,
        removed,
        quarantined,
        sourceCount: sourceRelativePaths.size,
        sourcePath: sourceRoot,
        targetPath: targetRoot
      });
    }

    cleanupExcludedMirrorRoots(contextRoot, mirrorExcludeRoots, now);

    purgeExpiredQuarantine(contextRoot);

    const prune = pruneCallback(projectDir, config, removedArchitectureProfiles);
    const result = {
      ok: true,
      message: 'ok',
      summary,
      prune,
      quarantine: {
        dir: quarantineRoot(contextRoot),
        movedCount: totalQuarantined,
        warnings: quarantineWarnings
      }
    };
    if (useCache) {
      writeSyncCache(projectDir, result);
    }

    return result;
  } catch (error) {
    return { ok: false, message: error.message, summary };
  }
}

// Additional exports for project wrappers
export { hashFile, ensureDir, listMarkdownFiles };
