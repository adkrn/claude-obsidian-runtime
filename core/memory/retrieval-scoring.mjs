/**
 * Generative Agents 3-axis retrieval scoring (Park 2023).
 *
 *   score = α_recency    * exp(-decayRate * daysSince(last_accessed_at))
 *         + α_importance * (importance / 10)
 *         + α_relevance  * jaccardSimilarity(promptTokens, item.tokens)
 *
 * Defaults (Design-A §2-E, §Z-3-A A-4):
 *   α_recency=1.0, α_importance=1.0, α_relevance=1.5, decayRate=0.05
 *
 * Override via runtime-manifest.json `retrievalWeights`.
 *
 * Pure module — no I/O, no project-specific paths.
 */

export const DEFAULT_WEIGHTS = Object.freeze({
  alphaRecency: 1.0,
  alphaImportance: 1.0,
  alphaRelevance: 1.5,
  decayRatePerDay: 0.05
});

const MS_PER_DAY = 1000 * 60 * 60 * 24;

function toFiniteNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function resolveWeights(overrides) {
  if (!overrides || typeof overrides !== 'object') {
    return DEFAULT_WEIGHTS;
  }
  return {
    alphaRecency: toFiniteNumber(overrides.alphaRecency, DEFAULT_WEIGHTS.alphaRecency),
    alphaImportance: toFiniteNumber(overrides.alphaImportance, DEFAULT_WEIGHTS.alphaImportance),
    alphaRelevance: toFiniteNumber(overrides.alphaRelevance, DEFAULT_WEIGHTS.alphaRelevance),
    decayRatePerDay: toFiniteNumber(overrides.decayRatePerDay, DEFAULT_WEIGHTS.decayRatePerDay)
  };
}

export function daysSince(isoString, nowDate = new Date()) {
  if (!isoString) return Infinity;
  const ts = Date.parse(isoString);
  if (!Number.isFinite(ts)) return Infinity;
  const deltaMs = nowDate.getTime() - ts;
  if (deltaMs <= 0) return 0;
  return deltaMs / MS_PER_DAY;
}

export function recencyScore(isoString, decayRate = DEFAULT_WEIGHTS.decayRatePerDay, nowDate = new Date()) {
  const days = daysSince(isoString, nowDate);
  if (!Number.isFinite(days)) return 0;
  return Math.exp(-decayRate * days);
}

export function importanceScore(importance) {
  const value = toFiniteNumber(importance, 0);
  if (value <= 0) return 0;
  if (value >= 10) return 1;
  return value / 10;
}

export function jaccardSimilarity(left, right) {
  const a = new Set((left || []).filter(Boolean).map(String));
  const b = new Set((right || []).filter(Boolean).map(String));
  if (a.size === 0 && b.size === 0) return 0;

  let intersectionSize = 0;
  for (const token of a) {
    if (b.has(token)) intersectionSize += 1;
  }
  const unionSize = a.size + b.size - intersectionSize;
  if (unionSize === 0) return 0;
  return intersectionSize / unionSize;
}

/**
 * @param {object} item
 *   - importance: number (1..10)
 *   - last_accessed_at: ISO-8601 string
 *   - tokens: string[]
 * @param {object} ctx
 *   - promptTokens: string[]
 *   - weights?: { alphaRecency, alphaImportance, alphaRelevance, decayRatePerDay }
 *   - now?: Date (test injection)
 * @returns {number} score
 */
export function scoreItem(item, ctx = {}) {
  if (!item || typeof item !== 'object') return 0;
  const weights = resolveWeights(ctx.weights);
  const now = ctx.now instanceof Date ? ctx.now : new Date();
  const promptTokens = Array.isArray(ctx.promptTokens) ? ctx.promptTokens : [];
  const itemTokens = Array.isArray(item.tokens) ? item.tokens : [];

  const recency = recencyScore(item.last_accessed_at, weights.decayRatePerDay, now);
  const importance = importanceScore(item.importance);
  const relevance = jaccardSimilarity(promptTokens, itemTokens);

  return (
    weights.alphaRecency * recency +
    weights.alphaImportance * importance +
    weights.alphaRelevance * relevance
  );
}

/**
 * Score a batch of items and return them sorted descending by score.
 * Stable: ties preserve original order.
 */
export function scoreItems(items, ctx = {}) {
  const list = Array.isArray(items) ? items : [];
  const indexed = list.map((item, index) => ({ item, index, score: scoreItem(item, ctx) }));
  indexed.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.index - right.index;
  });
  return indexed.map((entry) => ({ item: entry.item, score: entry.score }));
}
