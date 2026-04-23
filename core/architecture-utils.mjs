/**
 * Shared architecture pipeline utilities for Obsidian-Claude runtime.
 *
 * Provides common helpers used by detect/publish/promote scripts:
 *   - normalizePendingEntry: normalize legacy pending-docs fields
 *   - mergePendingEntries: merge new entries into existing JSONL
 *   - toArchitectureFollowUp: build task followUp format
 *   - upsertMarkedSection: insert/replace marked sections in markdown
 *   - updateFrontmatterUpdated: update frontmatter date field
 *   - buildObservedSurfaceTable: generate markdown surface table
 */

import path from 'path';
import {
  getRuntimePaths,
  loadJsonl,
  writeJsonlFile
} from './runtime-lib.mjs';
import { limitText } from './utils.mjs';

// ── Pending Entry Normalization ────────────────────────────────────

export function normalizePendingEntry(entry) {
  const {
    shouldPublish,
    published,
    publishedAt,
    draftRelativePath,
    storage,
    path: entryPath,
    publishReasons,
    ...rest
  } = entry || {};

  const shouldGenerate = entry?.shouldGenerate ?? entry?.shouldPublish ?? false;
  const generated = entry?.generated ?? entry?.published ?? false;
  const recommendPromotion = entry?.recommendPromotion ?? false;
  const recommendation = entry?.recommendation ||
    (entry?.promoted ? 'promoted' :
      (recommendPromotion ? 'promote' :
        (shouldGenerate ? 'review' : 'ignore')));

  return {
    ...rest,
    shouldGenerate,
    recommendPromotion,
    recommendation,
    generationReasons: Array.isArray(entry?.generationReasons)
      ? entry.generationReasons
      : Array.isArray(publishReasons) ? publishReasons : [],
    promotionReasons: Array.isArray(entry?.promotionReasons)
      ? entry.promotionReasons
      : recommendPromotion
        ? (Array.isArray(publishReasons) ? publishReasons : [])
        : [],
    generated,
    generatedAt: entry?.generatedAt || entry?.publishedAt || '',
    generatedRelativePath: entry?.generatedRelativePath || entry?.draftRelativePath || '',
    generatedStorage: entry?.generatedStorage || entry?.storage || '',
    generatedPath: entry?.generatedPath || entry?.path || '',
    promoted: Boolean(entry?.promoted),
    promotedAt: entry?.promotedAt || '',
    promotedStorage: entry?.promotedStorage || '',
    promotedPath: entry?.promotedPath || '',
    promotedTargetPath: entry?.promotedTargetPath || entry?.targetPath || '',
    createdAt: entry?.createdAt || entry?.updatedAt || '',
    updatedAt: entry?.updatedAt || new Date().toISOString()
  };
}

// ── Pending Entries Merge ──────────────────────────────────────────

export function mergePendingEntries(projectDir, nextEntries) {
  const pendingPath = path.join(getRuntimePaths(projectDir).architectureRoot, 'pending-docs.jsonl');
  const current = loadJsonl(pendingPath);
  const merged = new Map(current.map((e) => [e.id, normalizePendingEntry(e)]));

  for (const entry of nextEntries) {
    const previous = normalizePendingEntry(merged.get(entry.id) || {});
    merged.set(entry.id, {
      ...previous,
      ...entry,
      createdAt: previous.createdAt || entry.updatedAt,
      generated: previous.generated || false,
      generatedAt: previous.generatedAt || '',
      generatedRelativePath: previous.generatedRelativePath || '',
      generatedStorage: previous.generatedStorage || '',
      generatedPath: previous.generatedPath || '',
      promoted: previous.promoted || false,
      promotedAt: previous.promotedAt || '',
      promotedStorage: previous.promotedStorage || '',
      promotedPath: previous.promotedPath || '',
      promotedTargetPath: previous.promotedTargetPath || entry.targetPath,
      recommendation: previous.promoted
        ? 'promoted'
        : (entry.recommendation || previous.recommendation || 'review')
    });
  }

  const rows = Array.from(merged.values())
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  writeJsonlFile(pendingPath, rows);
  return rows;
}

// ── Task Architecture FollowUp ─────────────────────────────────────

export function toArchitectureFollowUp(entries) {
  return entries.map((entry) => ({
    kind: 'architecture',
    title: entry.title,
    summary: limitText(entry.summary || '', 180),
    relativePath: entry.promoted
      ? entry.targetPath
      : entry.generated
        ? entry.generatedRelativePath
        : entry.targetPath,
    targetPath: entry.targetPath,
    generatedRelativePath: entry.generatedRelativePath || '',
    storage: entry.promoted
      ? (entry.promotedStorage || 'vault')
      : entry.generated
        ? (entry.generatedStorage || 'pending')
        : 'pending',
    path: entry.promoted
      ? (entry.promotedPath || '')
      : entry.generated
        ? (entry.generatedPath || '')
        : '',
    duplicateOf: '',
    pendingId: entry.id,
    shouldGenerate: entry.shouldGenerate,
    recommendation: entry.promoted ? 'promoted' : (entry.recommendation || 'review'),
    recommendPromotion: Boolean(entry.recommendPromotion),
    promotionReasons: entry.promotionReasons || [],
    generated: Boolean(entry.generated),
    promoted: Boolean(entry.promoted)
  }));
}

// ── Markdown helpers ───────────────────────────────────────────────

export function upsertMarkedSection(content, heading, markerId, body) {
  const normalizedContent = String(content || '').trimEnd();
  const startMarker = `<!-- ${markerId}_START -->`;
  const endMarker = `<!-- ${markerId}_END -->`;
  const block = `${heading}\n${startMarker}\n${body.trim()}\n${endMarker}`;

  if (normalizedContent.includes(startMarker) && normalizedContent.includes(endMarker)) {
    const pattern = new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`, 'm');
    return normalizedContent.replace(pattern, `${startMarker}\n${body.trim()}\n${endMarker}`);
  }

  return `${normalizedContent}\n\n${block}\n`;
}

export function updateFrontmatterUpdated(content, dateStamp) {
  const text = String(content || '');
  if (!text.startsWith('---\n')) return text;

  if (/^updated:\s*.+$/m.test(text)) {
    return text.replace(/^updated:\s*.+$/m, `updated: ${dateStamp}`);
  }

  const endIndex = text.indexOf('\n---\n');
  if (endIndex === -1) return text;
  return `${text.slice(0, endIndex)}\nupdated: ${dateStamp}${text.slice(endIndex)}`;
}

export function buildObservedSurfaceTable(entry) {
  const rows = Array.isArray(entry.surfaces) ? entry.surfaces : [];
  if (rows.length === 0) return 'none';

  return `| Surface Type | Name | Path | Scope | Domain |\n|--------------|------|------|-------|--------|\n${rows
    .map((r) => `| ${r.surfaceType} | \`${r.surfaceName}\` | \`${r.path}\` | ${r.scope} | ${r.domainLabel || r.domain} |`)
    .join('\n')}`;
}

// ── Cross-task Consolidation ──────────────────────────────────────

export function consolidatePendingByDoc(entries) {
  const byDoc = new Map();
  for (const entry of entries) {
    const key = entry.targetDoc || entry.targetPath;
    if (!key) continue;
    const existing = byDoc.get(key);
    if (!existing) {
      byDoc.set(key, { ...entry, consolidatedFrom: [entry.taskId].filter(Boolean) });
    } else {
      const mergedFiles = [...new Set([...(existing.files || []), ...(entry.files || [])])];
      const mergedSurfaces = [...(existing.surfaces || []), ...(entry.surfaces || [])];
      const uniqueSurfaces = mergedSurfaces.filter((s, i, arr) =>
        arr.findIndex((o) => o.path === s.path && o.surfaceName === s.surfaceName) === i
      );
      existing.files = mergedFiles;
      existing.fileCount = mergedFiles.length;
      existing.surfaces = uniqueSurfaces;
      existing.publicSurfaceCount = (existing.publicSurfaceCount || 0) + (entry.publicSurfaceCount || 0);
      existing.shouldGenerate = existing.publicSurfaceCount >= 1 || existing.fileCount >= 2 || (existing.missingReferences || []).length >= 1;
      existing.consolidatedFrom = [...new Set([
        ...(existing.consolidatedFrom || []),
        entry.taskId
      ].filter(Boolean))];
      if (entry.promoted) existing.promoted = true;
      if (entry.generated) existing.generated = true;
      if (entry.recommendPromotion) existing.recommendPromotion = true;
      if (!existing.updatedAt || (entry.updatedAt && entry.updatedAt > existing.updatedAt)) {
        existing.updatedAt = entry.updatedAt;
      }
    }
  }
  return [...byDoc.values()];
}

// ── Pending Entry Update Helper ────────────────────────────────────

export function updatePendingEntries(projectDir, updater) {
  const pendingPath = path.join(getRuntimePaths(projectDir).architectureRoot, 'pending-docs.jsonl');
  const rows = loadJsonl(pendingPath);
  const nextRows = updater(rows);
  writeJsonlFile(pendingPath, nextRows);
  return nextRows;
}
