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

// ── IDF / BM25-lite (Phase B — G2) ───────────────────────────────

export const DEFAULT_BM25 = Object.freeze({ k1: 1.5, b: 0.75 });

/**
 * Build a smoothed IDF map + corpus stats from an array of token arrays.
 *
 *   idf(t) = ln((N + 1) / (df + 1)) + 1
 *
 * The +1 smoothing keeps idf positive even for a token in every doc, and
 * defined for unseen tokens (df=0 → ln(N+1)+1). Doc length uses the token
 * array length (already a deduped set in this codebase, capped at 24).
 *
 * @param {string[][]} corpus
 * @returns {{ idf: Map<string,number>, avgdl: number, n: number }}
 */
export function buildIdf(corpus) {
  const docs = Array.isArray(corpus) ? corpus.filter(Array.isArray) : [];
  const n = docs.length;
  if (n === 0) return { idf: new Map(), avgdl: 0, n: 0 };

  const df = new Map();
  let totalLen = 0;
  for (const doc of docs) {
    totalLen += doc.length;
    const seen = new Set();
    for (const raw of doc) {
      if (typeof raw !== 'string') continue;
      const t = raw.toLowerCase();
      if (seen.has(t)) continue;
      seen.add(t);
      df.set(t, (df.get(t) || 0) + 1);
    }
  }

  const idf = new Map();
  for (const [t, d] of df) {
    idf.set(t, Math.log((n + 1) / (d + 1)) + 1);
  }
  return { idf, avgdl: totalLen / n, n };
}

function idfOf(idf, token, n) {
  if (idf instanceof Map && idf.has(token)) return idf.get(token);
  // Unseen token: treat as df=0 → ln((N+1)/1)+1. Falls back to a small positive
  // when N unknown so an out-of-corpus query token still contributes sensibly.
  const N = Number.isFinite(n) ? n : 1;
  return Math.log(N + 1) + 1;
}

/**
 * BM25-lite relevance of a query against a doc, self-score normalized to [0,1].
 *
 * Standard BM25 term sum over query∩doc, then divided by the query's self-score
 * (query scored against itself as the ideal doc) so the best achievable match
 * maps to ~1.0 regardless of query length or corpus idf magnitude — stable
 * across corpora (no fixed ceiling drift).
 *
 * Note: in this codebase `tokens` is a deduped set, so tf is effectively 1 and
 * the k1 saturation term degenerates to a constant — bm25Lite ≈ IDF-weighted
 * overlap here. That is intentional and still far better than plain Jaccard
 * (it kills high-frequency boilerplate tokens via low idf — G2).
 *
 * @param {string[]} queryTokens
 * @param {string[]} docTokens
 * @param {Map<string,number>} idf
 * @param {{ k1?, b?, avgdl?, n? }} [opts]
 * @returns {number} 0..1
 */
export function bm25Lite(queryTokens, docTokens, idf, opts = {}) {
  const query = Array.isArray(queryTokens) ? queryTokens : [];
  const doc = Array.isArray(docTokens) ? docTokens : [];
  if (query.length === 0 || doc.length === 0) return 0;

  const k1 = Number.isFinite(opts.k1) ? opts.k1 : DEFAULT_BM25.k1;
  const b = Number.isFinite(opts.b) ? opts.b : DEFAULT_BM25.b;
  const avgdl = Number.isFinite(opts.avgdl) && opts.avgdl > 0 ? opts.avgdl : doc.length;
  const n = opts.n;

  const docSet = new Set(doc.map((t) => (typeof t === 'string' ? t.toLowerCase() : t)));
  const dl = doc.length;
  const norm = k1 * (1 - b + b * (dl / avgdl));

  // Distinct query tokens (tf in query irrelevant for the doc-side BM25 sum).
  const qSet = [];
  const seenQ = new Set();
  for (const raw of query) {
    if (typeof raw !== 'string') continue;
    const t = raw.toLowerCase();
    if (seenQ.has(t)) continue;
    seenQ.add(t);
    qSet.push(t);
  }
  if (qSet.length === 0) return 0;

  // BM25 with doc-side tf=1 (deduped set): term = idf * (1*(k1+1))/(1 + norm).
  const tfPart = (k1 + 1) / (1 + norm);
  let raw = 0;
  for (const t of qSet) {
    if (docSet.has(t)) raw += idfOf(idf, t, n) * tfPart;
  }
  if (raw === 0) return 0;

  // Self-score: query as its own ideal doc (same length → same norm baseline).
  // Use the query's own length for the ideal doc so normalization is per-query.
  const selfDl = qSet.length;
  const selfNorm = k1 * (1 - b + b * (selfDl / avgdl));
  const selfTfPart = (k1 + 1) / (1 + selfNorm);
  let self = 0;
  for (const t of qSet) self += idfOf(idf, t, n) * selfTfPart;
  if (self <= 0) return 0;

  const score = raw / self;
  return score > 1 ? 1 : score;
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
