#!/usr/bin/env node

/**
 * Promote draft lessons from Drafts subfolders to their parent scope folder.
 * Eligibility:
 *   - draft has been hit minHitCount times (default 5)
 *   - draft is at least minAgeDays old (default 3)
 *   - draft references at least one relatedFile
 *
 * On promote, rewrites frontmatter (status: active, promoted_at) and
 * re-syncs mirrors via obsidian-sync.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadObsidianConfig } from '../core/obsidian-config.mjs';
import { syncManagedRoots } from '../core/obsidian-sync.mjs';
import {
  loadJson,
  normalizePath,
  safeReadFile,
  writeVaultArtifact
} from '../core/utils.mjs';
import {
  ensureRuntimeLayout,
  getRuntimePaths,
  loadJsonl,
  parseCliArgs,
  writeJsonlFile
} from '../core/runtime-lib.mjs';

const DEFAULT_MIN_HIT_COUNT = 5;
const DEFAULT_MIN_AGE_DAYS = 3;

function parsePromoteArgs(argv) {
  const base = parseCliArgs(argv);
  return {
    ...base,
    publish: !argv.includes('--no-publish'),
    minHitCount: base.minHitCount || DEFAULT_MIN_HIT_COUNT,
    minAgeDays: base.minAgeDays || DEFAULT_MIN_AGE_DAYS
  };
}

function loadHitCounts(projectDir) {
  const hitCountsPath = path.join(getRuntimePaths(projectDir).knowledgeRoot, 'hit-counts.json');
  return loadJson(hitCountsPath, {});
}

function daysSince(dateString) {
  const then = new Date(dateString);
  if (Number.isNaN(then.getTime())) return Infinity;
  return (Date.now() - then.getTime()) / (1000 * 60 * 60 * 24);
}

function isDraftPath(sourceDoc) {
  return normalizePath(String(sourceDoc || '')).includes('/Drafts/');
}

function computePromotedPath(sourceDoc) {
  return normalizePath(sourceDoc).replace(/\/Drafts\//, '/');
}

// Auto Lesson v3 frontmatter fields (Design-A §3-A).
// When promoting, fields already present in the draft are preserved — missing
// v3 fields are seeded with safe defaults so the promoted note is v3-complete.
const V3_DEFAULT_FIELDS = {
  type: 'lesson',
  confidence: 'low',
  importance: 3,
  access_count: 0,
  trigger_keywords: '[]',
  applicable_when: '',
  last_accessed_at: '',
  evolved_at: '',
  linked_reflection: ''
};

function detectExistingKeys(fmBlockLines) {
  const keys = new Set();
  for (const line of fmBlockLines) {
    const match = line.match(/^([A-Za-z0-9_]+):/);
    if (match) keys.add(match[1]);
  }
  return keys;
}

function updateFrontmatter(content, promotedAt) {
  const lines = content.split(/\r?\n/);
  const out = [];
  const fmBlockLines = [];
  let inFm = false, fmClosed = false, statusUpdated = false;

  // First pass — collect frontmatter block lines to know which keys already exist.
  {
    let scanning = false;
    for (const line of lines) {
      if (line.trim() === '---') {
        if (!scanning) { scanning = true; continue; }
        break;
      }
      if (scanning) fmBlockLines.push(line);
    }
  }
  const existingKeys = detectExistingKeys(fmBlockLines);

  for (const line of lines) {
    if (!fmClosed && line.trim() === '---') {
      if (!inFm) { inFm = true; out.push(line); continue; }
      if (!statusUpdated) out.push('status: active');
      out.push(`promoted_at: ${promotedAt}`);
      // v3 seed fields (only if missing).
      for (const [key, defaultValue] of Object.entries(V3_DEFAULT_FIELDS)) {
        if (!existingKeys.has(key)) {
          out.push(`${key}: ${defaultValue}`);
        }
      }
      out.push(line);
      fmClosed = true;
      continue;
    }
    if (inFm && !fmClosed && line.startsWith('status:')) {
      out.push('status: active');
      statusUpdated = true;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

function findPromotionCandidates(projectDir, { minHitCount, minAgeDays }) {
  const runtimePaths = getRuntimePaths(projectDir);
  const lessonsPath = path.join(runtimePaths.knowledgeRoot, 'lessons.jsonl');
  const rows = loadJsonl(lessonsPath);
  const hitCounts = loadHitCounts(projectDir);
  const obsidianConfig = loadObsidianConfig(projectDir);
  const candidates = [];

  for (const row of rows) {
    if (!isDraftPath(row.sourceDoc)) continue;
    const hitCount = hitCounts[row.id]?.count || 0;
    if (hitCount < minHitCount) continue;
    const ageDays = daysSince(row.updatedAt);
    if (ageDays < minAgeDays) continue;
    const relatedFiles = Array.isArray(row.relatedFiles) ? row.relatedFiles : [];
    if (relatedFiles.length === 0) continue;

    const vaultPath = path.join(obsidianConfig.vaultRoot, ...row.sourceDoc.split('/'));
    const contextPath = path.join(obsidianConfig.contextRoot, ...row.sourceDoc.split('/'));
    if (!fs.existsSync(vaultPath) && !fs.existsSync(contextPath)) continue;

    const promotedRelativePath = computePromotedPath(row.sourceDoc);
    const promotedVaultPath = path.join(obsidianConfig.vaultRoot, ...promotedRelativePath.split('/'));
    if (fs.existsSync(promotedVaultPath)) continue;

    candidates.push({
      id: row.id,
      sourceDoc: row.sourceDoc,
      promotedRelativePath,
      hitCount,
      ageDays: Math.floor(ageDays),
      relatedFileCount: relatedFiles.length,
      title: row.title || '',
      scope: row.scope || '',
      sourcePath: fs.existsSync(vaultPath) ? vaultPath : contextPath
    });
  }
  return candidates;
}

function promoteCandidates(projectDir, candidates, { publish }) {
  const obsidianConfig = loadObsidianConfig(projectDir);
  const runtimePaths = getRuntimePaths(projectDir);
  const lessonsPath = path.join(runtimePaths.knowledgeRoot, 'lessons.jsonl');
  const rows = loadJsonl(lessonsPath);
  const promotedAt = new Date().toISOString();
  const results = [];

  for (const c of candidates) {
    const content = safeReadFile(c.sourcePath);
    if (!content.trim()) { results.push({ ...c, ok: false, reason: 'empty_content' }); continue; }
    const updatedContent = updateFrontmatter(content, promotedAt);
    if (!publish) { results.push({ ...c, ok: true, dryRun: true }); continue; }

    const writeResult = writeVaultArtifact({
      projectDir,
      vaultRoot: obsidianConfig.vaultRoot,
      relativePath: c.promotedRelativePath,
      content: updatedContent,
      queueRoot: 'document/obsidian_writeback_queue'
    });

    if (writeResult.storage === 'vault' || writeResult.storage === 'queue') {
      const idx = rows.findIndex((r) => r.id === c.id);
      if (idx >= 0) {
        rows[idx] = { ...rows[idx], sourceDoc: c.promotedRelativePath, storage: 'mirror', updatedAt: promotedAt };
      }
      results.push({ ...c, ok: true, storage: writeResult.storage, path: normalizePath(writeResult.path || '') });
    } else {
      results.push({ ...c, ok: false, reason: 'write_failed', storage: writeResult.storage });
    }
  }

  if (publish && results.some((r) => r.ok)) {
    writeJsonlFile(lessonsPath, rows);
    try { syncManagedRoots(projectDir, obsidianConfig); } catch { /* non-critical */ }
  }
  return results;
}

export function promoteDraftLessons(projectDir, options = {}) {
  ensureRuntimeLayout(projectDir);
  const minHitCount = options.minHitCount || DEFAULT_MIN_HIT_COUNT;
  const minAgeDays = options.minAgeDays || DEFAULT_MIN_AGE_DAYS;
  const publish = options.publish !== false;

  const candidates = findPromotionCandidates(projectDir, { minHitCount, minAgeDays });
  if (candidates.length === 0) {
    return { ok: true, promoted: [], candidateCount: 0, message: 'no eligible drafts for promotion' };
  }

  const results = promoteCandidates(projectDir, candidates, { publish });
  const promoted = results.filter((r) => r.ok);
  return {
    ok: true,
    promoted: promoted.map((r) => ({
      id: r.id, title: r.title,
      sourceDoc: r.sourceDoc, promotedRelativePath: r.promotedRelativePath,
      hitCount: r.hitCount, ageDays: r.ageDays,
      storage: r.storage || 'dry-run', dryRun: Boolean(r.dryRun)
    })),
    candidateCount: candidates.length,
    failedCount: results.filter((r) => !r.ok).length,
    publish
  };
}

async function main() {
  const args = parsePromoteArgs(process.argv.slice(2));
  const projectDir = path.resolve(args.projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const result = promoteDraftLessons(projectDir, {
    publish: args.publish,
    minHitCount: args.minHitCount,
    minAgeDays: args.minAgeDays
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const currentFilePath = fileURLToPath(import.meta.url);
const invokedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (currentFilePath === invokedFilePath) {
  main().catch((err) => { process.stderr.write(`[lesson-promote] ${err.message}\n`); process.exit(1); });
}
