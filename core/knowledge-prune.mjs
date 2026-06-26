/**
 * knowledge-prune.mjs — pure stale/duplicate DETECTION for knowledge jsonl rows.
 *
 * READ-ONLY by contract. Nothing here deletes, unlinks, quarantines, or mutates
 * a row or a file. It only *reports* candidates for a human to review and act on.
 * The conservative-forgetting half of A-MEM (cognee Forget / MemoryBank curve),
 * minus the forgetting — surfacing is the whole job (03_ROADMAP Phase D).
 *
 * Why so conservative: a past incident permanently lost mirror-only files via a
 * direct unlink. So this module never proposes an automatic action; it produces
 * a list, and the operator decides. See 03_ROADMAP Phase D + project data-safety.
 *
 * Signals:
 *   - stale  = updatedAt older than staleDays AND the row is unaccessed.
 *              (access_count is 0 or absent — note that access tracking is not yet
 *               wired, so in practice this reduces to "old"; kept explicit so the
 *               check tightens automatically once access_count is populated.)
 *   - duplicate = same scope AND (token jaccard >= threshold OR file overlap >= min).
 *                 Mirrors learning-curate's findDuplicateCandidate heuristic, but
 *                 pairwise across all rows rather than candidate-vs-existing.
 */

import { daysSince, jaccardSimilarity } from './memory/retrieval-scoring.mjs';
import { tokenizeSearchText } from './runtime-lib.mjs';

export const DEFAULT_PRUNE_OPTS = Object.freeze({
  staleDays: 120,
  // Real near-duplicates sit high. Same-module lessons naturally share ~half
  // their tokens (jaccard ~0.5), so a 0.5 default floods the report (185 pairs
  // on Pasim62). 0.7 keeps only genuinely-overlapping pairs. Lower via --jaccard
  // to cast a wider net when actively de-duping a scope.
  jaccardThreshold: 0.7,
  fileOverlapMin: 2,
  // File overlap is only a *corroborating* signal: same files but unrelated text
  // is NOT a duplicate (lessons from the same module share files constantly).
  // Measured on Pasim62 (64 lessons, one module): file-overlap-alone gave
  // 1272/1654 noise pairs; overlap+jaccard>=0.3 still gave 382. Real near-dupes
  // sit at high jaccard, so overlap only corroborates when jaccard is already
  // substantial. Tunable via --jaccard for the main signal.
  fileOverlapMinJaccard: 0.6
});

/**
 * A row counts as unaccessed when access_count is 0 or the field was never written.
 * Conservative: any positive count means "keep" (never propose for removal).
 */
export function isUnaccessed(row) {
  const c = row?.access_count;
  return c === undefined || c === null || c === 0;
}

/** Tokens for similarity: prefer precomputed row.tokens, else derive from title+summary. */
export function rowTokens(row) {
  if (Array.isArray(row?.tokens) && row.tokens.length > 0) return row.tokens;
  return tokenizeSearchText(`${row?.title || ''} ${row?.summary || ''}`);
}

function baseNames(files) {
  return new Set(
    (Array.isArray(files) ? files : []).map((f) => String(f).split(/[\\/]/).pop().toLowerCase())
  );
}

/**
 * Rows older than staleDays AND unaccessed. Pure.
 * @returns Array<{ ...row, ageDays }> (shallow-copied with ageDays added)
 */
export function findStaleRows(rows, opts = {}) {
  const staleDays = opts.staleDays ?? DEFAULT_PRUNE_OPTS.staleDays;
  const nowDate = opts.nowDate || new Date();
  const out = [];
  for (const row of rows || []) {
    if (!row) continue;
    if (!isUnaccessed(row)) continue;
    const ageDays = daysSince(row.updatedAt, nowDate);
    if (Number.isFinite(ageDays) && ageDays >= staleDays) {
      out.push({ ...row, ageDays: Math.round(ageDays) });
    }
  }
  // Oldest first — the strongest forget candidates lead.
  out.sort((a, b) => b.ageDays - a.ageDays);
  return out;
}

/**
 * Pairwise duplicate candidates within the same scope. Pure.
 * @returns Array<{ a, b, jaccard, fileOverlap }>
 */
export function findDuplicatePairs(rows, opts = {}) {
  const jaccardThreshold = opts.jaccardThreshold ?? DEFAULT_PRUNE_OPTS.jaccardThreshold;
  const fileOverlapMin = opts.fileOverlapMin ?? DEFAULT_PRUNE_OPTS.fileOverlapMin;
  const fileOverlapMinJaccard = opts.fileOverlapMinJaccard ?? DEFAULT_PRUNE_OPTS.fileOverlapMinJaccard;
  const list = (rows || []).filter(Boolean);
  const pairs = [];

  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i];
      const b = list[j];
      if (a.scope !== b.scope) continue;

      const aFiles = baseNames(a.relatedFiles);
      const bFiles = baseNames(b.relatedFiles);
      const fileOverlap = Array.from(aFiles).filter((fn) => bFiles.has(fn)).length;
      const jaccard = jaccardSimilarity(rowTokens(a), rowTokens(b));

      // Duplicate if tokens are strongly similar, OR files overlap AND tokens are
      // at least moderately similar. File overlap alone is NOT enough (noise).
      const byJaccard = jaccard >= jaccardThreshold;
      const byFiles = fileOverlap >= fileOverlapMin && jaccard >= fileOverlapMinJaccard;
      if (byJaccard || byFiles) {
        pairs.push({
          a: { id: a.id, title: a.title, updatedAt: a.updatedAt, sourceDoc: a.sourceDoc || '' },
          b: { id: b.id, title: b.title, updatedAt: b.updatedAt, sourceDoc: b.sourceDoc || '' },
          scope: a.scope,
          jaccard: Number(jaccard.toFixed(3)),
          fileOverlap
        });
      }
    }
  }
  // Most-suspicious first — a human reviews from the top down.
  pairs.sort((x, y) => y.jaccard - x.jaccard || y.fileOverlap - x.fileOverlap);
  return pairs;
}

/**
 * Aggregate read-only report. Pure — never mutates input rows.
 * @returns { totalRows, staleCount, duplicateCount, stale[], duplicatePairs[] }
 */
export function buildPruneReport(rows, opts = {}) {
  const list = (rows || []).filter(Boolean);
  const stale = findStaleRows(list, opts).map((r) => ({
    id: r.id,
    kind: r.kind,
    scope: r.scope,
    title: r.title,
    ageDays: r.ageDays,
    access_count: r.access_count ?? 0,
    updatedAt: r.updatedAt,
    sourceDoc: r.sourceDoc || ''
  }));
  const duplicatePairs = findDuplicatePairs(list, opts);
  return {
    totalRows: list.length,
    staleCount: stale.length,
    duplicateCount: duplicatePairs.length,
    stale,
    duplicatePairs
  };
}
