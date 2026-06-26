/**
 * similarity.mjs — lightweight lexical relevance (Phase A/B, G1–G3).
 *
 * Pure module, ZERO dependencies, fully synchronous. Plugs into the
 * `relevanceFn` seam of retrieval-scoring.mjs (scoreItem). No network, no
 * embeddings — by design, for the ~60-lesson scale (arXiv 2410.09662: BM25
 * efficient well past this; embedding threshold ~1000).
 *
 * Composition (additive, weighted):
 *   relevance = base                                   (token overlap)
 *             + W_TK  * triggerKeywordOverlap           (G1 — session signal)
 *             + W_NG  * trigramJaccard                  (G3 — morphological)   [Phase B]
 *
 * `base` is token Jaccard in Phase A; Phase B swaps it for IDF-weighted
 * overlap (BM25-lite) when an idf map is supplied via opts.
 *
 * All terms are 0..1; the weighted sum is additive (not renormalized) so a
 * lesson WITH trigger_keywords can rank above an otherwise-equal lesson
 * without — that is the intended G1 lift. Callers feed the result through
 * alphaRelevance, so absolute scale is tuned there (Phase C).
 */

import { jaccardSimilarity } from './retrieval-scoring.mjs';

export const DEFAULT_SIMILARITY_WEIGHTS = Object.freeze({
  triggerKeywordWeight: 0.5, // W_TK
  trigramWeight: 0.15        // W_NG (Phase B)
});

function toFiniteNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function resolveWeights(overrides) {
  if (!overrides || typeof overrides !== 'object') return DEFAULT_SIMILARITY_WEIGHTS;
  return {
    triggerKeywordWeight: toFiniteNumber(
      overrides.triggerKeywordWeight,
      DEFAULT_SIMILARITY_WEIGHTS.triggerKeywordWeight
    ),
    trigramWeight: toFiniteNumber(
      overrides.trigramWeight,
      DEFAULT_SIMILARITY_WEIGHTS.trigramWeight
    )
  };
}

function lowerStringSet(arr) {
  const out = new Set();
  if (!Array.isArray(arr)) return out;
  for (const v of arr) {
    if (typeof v !== 'string') continue;
    const t = v.trim().toLowerCase();
    if (t.length > 0) out.add(t);
  }
  return out;
}

/**
 * G1 — fraction of prompt tokens that appear in the lesson's trigger_keywords.
 *
 *   overlapCount(promptTokens ∩ trigger_keywords) / promptTokens.length
 *
 * Graceful: returns 0 when trigger_keywords is absent/empty (most projects
 * other than Pasim62 today) or when promptTokens is empty. Always 0..1.
 *
 * @param {string[]} promptTokens  already-lowercased prompt tokens
 * @param {object} item            lesson row (uses item.trigger_keywords)
 * @returns {number} 0..1
 */
export function triggerKeywordOverlap(promptTokens, item) {
  const prompt = Array.isArray(promptTokens) ? promptTokens : [];
  if (prompt.length === 0) return 0;
  const tk = lowerStringSet(item && item.trigger_keywords);
  if (tk.size === 0) return 0;

  let overlap = 0;
  const seen = new Set();
  for (const raw of prompt) {
    if (typeof raw !== 'string') continue;
    const t = raw.toLowerCase();
    if (seen.has(t)) continue; // count each distinct prompt token once
    seen.add(t);
    if (tk.has(t)) overlap += 1;
  }
  const ratio = overlap / prompt.length;
  return ratio > 1 ? 1 : ratio;
}

/**
 * Base token-overlap relevance. Phase A: Jaccard. Phase B: when opts.idf is a
 * Map, switch to IDF-weighted overlap (bm25Lite). Kept here so improvedSimilarity
 * stays the single composition point.
 */
function baseRelevance(promptTokens, item, opts) {
  const itemTokens = Array.isArray(item && item.tokens) ? item.tokens : [];
  // Phase B hook: IDF-weighted base when an idf map is provided.
  if (opts && opts.idf instanceof Map && typeof opts.bm25 === 'function') {
    return opts.bm25(promptTokens, itemTokens, opts.idf, opts);
  }
  return jaccardSimilarity(promptTokens, itemTokens);
}

/**
 * Composite lightweight relevance for the relevanceFn seam.
 *
 * @param {object} ctx   - { promptTokens: string[] }
 * @param {object} item  - lesson row ({ tokens, trigger_keywords, ... })
 * @param {object} opts  - { weights?, idf?, avgdl?, bm25?, trigram? }
 * @returns {number} relevance (>= 0; base+terms each 0..1)
 */
export function improvedSimilarity(ctx, item, opts = {}) {
  const promptTokens = Array.isArray(ctx && ctx.promptTokens) ? ctx.promptTokens : [];
  const weights = resolveWeights(opts.weights);

  const base = baseRelevance(promptTokens, item, opts);
  const tkTerm = weights.triggerKeywordWeight * triggerKeywordOverlap(promptTokens, item);

  // Phase B trigram term (wired in Step 4). Inert until opts.trigram supplied.
  let ngTerm = 0;
  if (typeof opts.trigram === 'function') {
    ngTerm = weights.trigramWeight * opts.trigram(ctx, item);
  }

  return base + tkTerm + ngTerm;
}
