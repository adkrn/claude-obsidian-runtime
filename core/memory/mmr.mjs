/**
 * MMR diversity penalty + cache-friendly emit ordering.
 *
 * Spec: DESIGN_MANUS_C §4-B (simple penalty form) + §5-A (path asc).
 *
 * Pure module — no I/O, no project paths.
 *
 * Pipeline (C §4-D, after F gate):
 *   F gate (scoreItem ctx) → 3-axis score (scoreItem) → applyMMR → emitSortByPath.
 *
 * Inputs to applyMMR are expected to come from `scoreItems(...)` after the
 * caller filters out -Infinity entries (gate-excluded items, F §5-A).
 */

import { jaccardSimilarity } from './retrieval-scoring.mjs';

export const DEFAULT_DIVERSITY_LAMBDA = 0.2;
export const DEFAULT_DIVERSITY_JACCARD_THRESHOLD = 0.7;

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizeForwardSlash(value) {
  return typeof value === 'string' ? value.replace(/\\/g, '/') : '';
}

/**
 * @param {{ item: { tokens?: string[], path?: string }, score: number, index?: number }[]} scoredItems
 * @param {{ lambda?: number, jaccardThreshold?: number }} [options]
 * @returns {{ item, score, mmrScore: number, penalized: boolean, index: number }[]}
 */
export function applyMMR(scoredItems, options = {}) {
  const list = Array.isArray(scoredItems) ? scoredItems : [];
  if (list.length === 0) return [];

  const rawLambda = options.lambda;
  const lambda = rawLambda === undefined ? DEFAULT_DIVERSITY_LAMBDA : clamp01(rawLambda);
  const rawThreshold = options.jaccardThreshold;
  const jaccardThreshold = Number.isFinite(rawThreshold)
    ? rawThreshold
    : DEFAULT_DIVERSITY_JACCARD_THRESHOLD;

  // λ <= 0 → MMR disabled, return input as-is with no penalty (preserve order).
  if (lambda <= 0) {
    return list.map((entry, idx) => ({
      item: entry.item,
      score: entry.score,
      mmrScore: entry.score,
      penalized: false,
      index: Number.isFinite(entry.index) ? entry.index : idx
    }));
  }

  const selected = [];
  const result = [];

  for (let i = 0; i < list.length; i += 1) {
    const entry = list[i];
    const candidateTokens = Array.isArray(entry?.item?.tokens) ? entry.item.tokens : [];

    let maxSim = 0;
    for (const sel of selected) {
      const sim = jaccardSimilarity(
        candidateTokens,
        Array.isArray(sel.item?.tokens) ? sel.item.tokens : []
      );
      if (sim > maxSim) maxSim = sim;
    }

    let mmrScore = entry.score;
    let penalized = false;
    if (maxSim >= jaccardThreshold) {
      mmrScore = entry.score * (1 - lambda);
      penalized = true;
    }

    const out = {
      item: entry.item,
      score: entry.score,
      mmrScore,
      penalized,
      index: Number.isFinite(entry.index) ? entry.index : i
    };
    result.push(out);
    selected.push(entry);
  }

  // Re-sort by mmrScore desc, ties by original index asc (stable input order).
  result.sort((a, b) => {
    if (b.mmrScore !== a.mmrScore) return b.mmrScore - a.mmrScore;
    return a.index - b.index;
  });

  return result;
}

/**
 * Sort items by path ascending (locale-independent ASCII compare,
 * forward-slash normalized). Stable: equal paths preserve input order.
 *
 * Spec: DESIGN_MANUS_C §5-A-4 + DESIGN_MANUS_D §5-C-1.
 */
export function emitSortByPath(items) {
  if (!Array.isArray(items)) return [];
  return items
    .slice()
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const pa = normalizeForwardSlash(a.item?.path);
      const pb = normalizeForwardSlash(b.item?.path);
      if (pa < pb) return -1;
      if (pa > pb) return 1;
      return a.index - b.index;
    })
    .map((entry) => entry.item);
}
