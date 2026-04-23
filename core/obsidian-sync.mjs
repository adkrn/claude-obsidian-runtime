#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

// pruneKnowledgeForRemovedArchitectures is project-specific.
// Projects inject via options.pruneCallback. Default is no-op.
const DEFAULT_PRUNE = () => ({ removedArchitectures: [], deletedDocs: [], updatedDocs: [], runtimePruned: {} });


const DEFAULT_SYNC_CACHE_TTL_MS = 5 * 60 * 1000;

export function normalizePathValue(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '');
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

function cleanupExcludedMirrorRoots(contextRoot, excludedRoots) {
  for (const root of excludedRoots) {
    if (!root) {
      continue;
    }

    const targetPath = path.join(contextRoot, root);
    try {
      if (fs.existsSync(targetPath)) {
        fs.rmSync(targetPath, { recursive: true, force: true });
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

  const { contextRoot, managedRoots, mirrorExcludeRoots } = getMirrorSettings(config);
  const summary = [];
  const removedArchitectureProfiles = [];

  try {
    ensureDir(contextRoot);

    for (const root of managedRoots) {
      const sourceRoot = path.join(config.vaultRoot, root);
      const targetRoot = path.join(contextRoot, root);
      const sourceFiles = listMarkdownFiles(sourceRoot);
      const sourceRelativePaths = new Set();
      let copied = 0;
      let removed = 0;

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
          fs.rmSync(targetFile, { force: true });
          removed += 1;
        }
      }

      summary.push({
        root,
        copied,
        removed,
        sourceCount: sourceRelativePaths.size,
        sourcePath: sourceRoot,
        targetPath: targetRoot
      });
    }

    cleanupExcludedMirrorRoots(contextRoot, mirrorExcludeRoots);

    const prune = pruneCallback(projectDir, config, removedArchitectureProfiles);
    const result = { ok: true, message: 'ok', summary, prune };
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
