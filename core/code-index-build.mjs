#!/usr/bin/env node

/**
 * Code Index Build Engine (Shared)
 *
 * Generic file indexing engine for Obsidian-Claude runtime.
 * Project-specific domain mapping is injected via options.domainMapper.
 *
 * Usage:
 *   import { buildCodeIndex, buildIndexRow, deriveSurfaceType, deriveSurfaceName } from 'claude-obsidian-runtime/code-index';
 *   const manifest = buildCodeIndex(projectDir, { domainMapper, full: true });
 */

import fs from 'fs';
import path from 'path';
import {
  ensureDir,
  listFilesRecursive,
  normalizePath
} from './utils.mjs';
import {
  ensureRuntimeLayout,
  inferScopeFromPath,
  loadJsonl,
  tokenizeSearchText,
  uniqueStrings,
  writeJsonFile
} from './runtime-lib.mjs';

// ── Constants ────────────────────────────────────────────────────

const ALLOWED_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.json', '.yaml', '.yml', '.md'
]);

const PUBLIC_SURFACE_TYPES = new Set([
  'route', 'route-handler', 'page', 'layout',
  'service', 'controller', 'websocket', 'store',
  'context', 'hook', 'provider', 'middleware',
  'component', 'config'
]);

const FULL_REBUILD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ── Helpers ──────────────────────────────────────────────────────

function isIndexableFile(filePath) {
  const normalized = normalizePath(filePath).toLowerCase();
  const extension = path.extname(normalized);

  if (!ALLOWED_EXTENSIONS.has(extension)) {
    return false;
  }

  if (
    normalized.includes('/node_modules/') ||
    normalized.includes('/.next/') ||
    normalized.includes('/dist/') ||
    normalized.includes('/build/') ||
    normalized.includes('/coverage/') ||
    normalized.includes('/public/images/') ||
    normalized.includes('/public/icons/') ||
    normalized.includes('/public/comics/') ||
    normalized.includes('/android/') ||
    normalized.includes('/ios/') ||
    normalized.includes('/database/dumps/') ||
    normalized.includes('/archive/')
  ) {
    return false;
  }

  return true;
}

function toRelativeProjectPath(projectDir, filePath) {
  return normalizePath(path.relative(projectDir, filePath));
}

function deriveSurfaceType(relativePath) {
  const normalized = normalizePath(relativePath).toLowerCase();
  const baseName = path.basename(normalized);

  if (baseName === 'page.tsx') return 'page';
  if (baseName === 'layout.tsx') return 'layout';
  if (baseName === 'route.ts' || baseName === 'route.js') return 'route-handler';
  if (normalized.includes('/routes/')) return 'route';
  if (normalized.includes('/controllers/')) return 'controller';
  if (normalized.includes('/services/')) return 'service';
  if (normalized.includes('/websocket/')) return 'websocket';
  if (normalized.includes('/middleware/')) return 'middleware';
  if (normalized.includes('/jobs/')) return 'job';
  if (normalized.includes('/models/associations/')) return 'association';
  if (normalized.includes('/models/')) return 'model';
  if (normalized.includes('/hooks/')) return 'hook';
  if (normalized.includes('/stores/')) return 'store';
  if (normalized.includes('/contexts/')) return 'context';
  if (normalized.includes('/components/')) return 'component';
  if (normalized.includes('/config/')) return 'config';
  if (normalized.includes('/constants/')) return 'constant';
  if (normalized.includes('/utils/')) return 'utility';
  if (normalized.includes('/lib/')) return 'lib';
  if (normalized.includes('/types/')) return 'type';
  if (normalized.includes('/validators/')) return 'validator';
  if (normalized.includes('/commands/')) return 'command';
  if (normalized.includes('/scripts/')) return 'script';
  if (normalized.includes('/_meta/')) return 'meta';

  return 'file';
}

function deriveSurfaceName(relativePath) {
  const normalized = normalizePath(relativePath);
  const ext = path.extname(normalized);
  const baseName = path.basename(normalized, ext);

  if (baseName === 'page' || baseName === 'layout' || baseName === 'route') {
    const parent = normalizePath(path.dirname(normalized)).split('/').slice(-1)[0] || baseName;
    return parent;
  }

  return baseName;
}

function extractSymbols(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (!['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(extension)) {
    return [];
  }

  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }

  const symbols = new Set();
  const patterns = [
    /export\s+(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    /export\s+const\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    /export\s+class\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    /function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g,
    /class\s+([A-Za-z_][A-Za-z0-9_]*)\s+/g,
    /const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?\(/g,
    /const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?\{/g
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const symbol = match[1];
      if (symbol && symbol.length >= 3) {
        symbols.add(symbol);
      }
      if (symbols.size >= 20) break;
    }
    if (symbols.size >= 20) break;
  }

  return Array.from(symbols).slice(0, 20);
}

function normalizeDocPath(docName) {
  return docName ? `04_Architecture/${docName}` : '';
}

function buildKeywords(relativePath, symbols, mapping, surfaceType) {
  const architectureBase = mapping.architectureDoc
    ? path.basename(mapping.architectureDoc, '.md')
    : '';

  return uniqueStrings([
    ...tokenizeSearchText(relativePath),
    ...symbols.flatMap((symbol) => tokenizeSearchText(symbol)),
    ...tokenizeSearchText(mapping.domain),
    ...tokenizeSearchText(mapping.domainLabel),
    ...tokenizeSearchText(surfaceType),
    ...tokenizeSearchText(architectureBase)
  ]).slice(0, 40);
}

/**
 * Build a single index row for a file.
 * @param {string} projectDir
 * @param {string} filePath
 * @param {string} scope
 * @param {function} [domainMapper] - (relativePath, scope) => { domain, domainLabel, architectureDoc }
 */
function buildIndexRow(projectDir, filePath, scope, domainMapper) {
  const relativePath = toRelativeProjectPath(projectDir, filePath);
  const surfaceType = deriveSurfaceType(relativePath);
  const surfaceName = deriveSurfaceName(relativePath);
  const symbols = extractSymbols(filePath);

  const defaultMapping = { domain: scope, domainLabel: scope, architectureDoc: '' };
  const mapping = domainMapper
    ? domainMapper(relativePath, scope) || defaultMapping
    : defaultMapping;

  return {
    path: relativePath,
    scope: scope || inferScopeFromPath(relativePath),
    domain: mapping.domain,
    domainLabel: mapping.domainLabel,
    architectureDoc: mapping.architectureDoc,
    relatedDocs: uniqueStrings([
      normalizeDocPath(mapping.architectureDoc)
    ].filter(Boolean)),
    surfaceType,
    surfaceName,
    isPublicSurface: PUBLIC_SURFACE_TYPES.has(surfaceType),
    symbols,
    keywords: buildKeywords(relativePath, symbols, mapping, surfaceType),
    updatedAt: new Date().toISOString()
  };
}

function collectFilesForTarget(projectDir, target) {
  const files = [];

  for (const relativeRoot of target.roots) {
    const absoluteRoot = path.join(projectDir, ...relativeRoot.split('/'));
    if (!fs.existsSync(absoluteRoot)) {
      continue;
    }

    const stats = fs.statSync(absoluteRoot);
    if (stats.isFile()) {
      if (isIndexableFile(absoluteRoot)) {
        files.push(absoluteRoot);
      }
      continue;
    }

    files.push(...listFilesRecursive(absoluteRoot, (fp) => isIndexableFile(fp)));
  }

  return uniqueStrings(files.map((fp) => path.resolve(fp)));
}

function writeJsonl(filePath, rows) {
  ensureDir(path.dirname(filePath));
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, body ? `${body}\n` : '', 'utf8');
}

// ── Incremental Rebuild ──────────────────────────────────────────

function getFileMtime(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function loadPreviousManifest(runtimePaths) {
  const manifestPath = path.join(runtimePaths.codeIndexRoot, 'manifest.json');
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

function shouldForceFullRebuild(previousManifest) {
  if (!previousManifest?.generatedAt) return true;
  const generatedTime = Date.parse(previousManifest.generatedAt);
  if (Number.isNaN(generatedTime)) return true;
  return Date.now() - generatedTime > FULL_REBUILD_TTL_MS;
}

function loadPreviousIndexRows(runtimePaths, outputFile) {
  const indexPath = path.join(runtimePaths.codeIndexRoot, outputFile);
  return loadJsonl(indexPath);
}

// ── Main Export ──────────────────────────────────────────────────

/**
 * Build code index for a project.
 *
 * @param {string} projectDir - Project root directory
 * @param {object} [options]
 * @param {boolean} [options.full] - Force full rebuild
 * @param {function} [options.domainMapper] - (relativePath, scope) => { domain, domainLabel, architectureDoc }
 * @param {Array} [options.indexTargets] - Override index targets. Falls back to obsidianConfig.indexTargets or DEFAULT_INDEX_TARGETS.
 * @param {function} [options.loadConfig] - () => obsidianConfig. If not provided, no config-based targets are used.
 * @returns {object} manifest
 */
export function buildCodeIndex(projectDir, options = {}) {
  const runtimePaths = ensureRuntimeLayout(projectDir);
  const generatedAt = new Date().toISOString();
  const previousManifest = loadPreviousManifest(runtimePaths);
  const forceFullRebuild = options.full || shouldForceFullRebuild(previousManifest);
  const previousMtimes = (!forceFullRebuild && previousManifest?.fileMtimes) || {};
  const isIncremental = !forceFullRebuild && Object.keys(previousMtimes).length > 0;

  const indexTargets = options.indexTargets
    || (options.loadConfig ? (options.loadConfig()?.indexTargets || []) : []);

  if (indexTargets.length === 0) {
    return { generatedAt, mode: 'full', indexes: [], fileMtimes: {}, warning: 'no indexTargets' };
  }

  const domainMapper = options.domainMapper || null;

  const manifest = {
    generatedAt,
    mode: isIncremental ? 'incremental' : 'full',
    indexes: [],
    fileMtimes: {}
  };

  const publicSurfaceRows = [];
  let changedCount = 0;
  let unchangedCount = 0;

  for (const target of indexTargets) {
    const files = collectFilesForTarget(projectDir, target);
    const previousRows = isIncremental
      ? loadPreviousIndexRows(runtimePaths, target.output)
      : [];
    const previousRowMap = new Map(previousRows.map((row) => [row.path, row]));

    const rows = [];
    for (const filePath of files) {
      const relativePath = toRelativeProjectPath(projectDir, filePath);
      const currentMtime = getFileMtime(filePath);
      manifest.fileMtimes[relativePath] = currentMtime;

      if (isIncremental && previousMtimes[relativePath] === currentMtime && previousRowMap.has(relativePath)) {
        rows.push(previousRowMap.get(relativePath));
        unchangedCount += 1;
      } else {
        rows.push(buildIndexRow(projectDir, filePath, target.scope, domainMapper));
        changedCount += 1;
      }
    }

    rows.sort((left, right) => left.path.localeCompare(right.path));

    const outputPath = path.join(runtimePaths.codeIndexRoot, target.output);
    writeJsonl(outputPath, rows);

    publicSurfaceRows.push(
      ...rows.filter((row) => row.isPublicSurface)
    );

    const countsByDomain = rows.reduce((accumulator, row) => {
      accumulator[row.domain] = (accumulator[row.domain] || 0) + 1;
      return accumulator;
    }, {});

    manifest.indexes.push({
      scope: target.scope,
      output: normalizePath(outputPath),
      fileCount: rows.length,
      domainCount: Object.keys(countsByDomain).length,
      countsByDomain
    });
  }

  const publicSurfacesPath = path.join(runtimePaths.codeIndexRoot, 'public-surfaces.jsonl');
  writeJsonl(
    publicSurfacesPath,
    publicSurfaceRows.sort((left, right) => left.path.localeCompare(right.path))
  );

  manifest.publicSurfaces = {
    output: normalizePath(publicSurfacesPath),
    fileCount: publicSurfaceRows.length
  };

  if (isIncremental) {
    manifest.incremental = {
      changed: changedCount,
      unchanged: unchangedCount,
      total: changedCount + unchangedCount
    };
  }

  writeJsonFile(
    path.join(runtimePaths.codeIndexRoot, 'manifest.json'),
    manifest
  );

  return manifest;
}

export {
  buildIndexRow,
  deriveSurfaceType,
  deriveSurfaceName,
  extractSymbols,
  isIndexableFile,
  collectFilesForTarget,
  writeJsonl,
  normalizeDocPath,
  buildKeywords,
  PUBLIC_SURFACE_TYPES,
  ALLOWED_EXTENSIONS
};
