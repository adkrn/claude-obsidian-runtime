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

// ── applicable_when retrieval gate (DESIGN_MANUS_F §4) ─────────────

function escapeRegexLiteral(ch) {
  return ch.replace(/[.+^$()|[\]{}\\]/g, '\\$&');
}

/**
 * minimatch-compatible subset (no external dep). Supports:
 *   - `*`   : any chars except `/`
 *   - `**`  : any chars including `/` (also matches zero segments)
 *   - `?`   : single char except `/`
 * Forward-slash paths only — caller normalizes.
 */
export function globMatch(pattern, candidatePath) {
  if (typeof pattern !== 'string' || typeof candidatePath !== 'string') return false;
  if (pattern.length === 0) return false;
  let regex = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        regex += '.*';
        i += 1;
      } else {
        regex += '[^/]*';
      }
    } else if (ch === '?') {
      regex += '[^/]';
    } else {
      regex += escapeRegexLiteral(ch);
    }
  }
  const re = new RegExp(`^${regex}$`);
  return re.test(candidatePath);
}

function toLowerSet(arr) {
  const out = new Set();
  if (!Array.isArray(arr)) return out;
  for (const v of arr) {
    if (typeof v !== 'string') continue;
    const t = v.trim().toLowerCase();
    if (t.length > 0) out.add(t);
  }
  return out;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Evaluate the structured `applicable_when` gate (F §4-B).
 *
 * Returns { passed, evaluated, failedGates [, legacyString] }.
 *
 *   - applicable_when undefined/null/empty-string → passed=true
 *   - non-empty legacy string                     → passed=true, legacyString=true
 *   - non-object/array/etc                        → passed=true (defensive)
 *   - object with sub-fields                      → AND across defined sub-fields
 */
export function evaluateGate(item, ctx = {}) {
  const raw = item && typeof item === 'object' ? item.applicable_when : undefined;
  if (raw === undefined || raw === null) {
    return { passed: true, evaluated: [], failedGates: [] };
  }
  if (typeof raw === 'string') {
    if (raw === '') return { passed: true, evaluated: [], failedGates: [] };
    return { passed: true, evaluated: [], failedGates: [], legacyString: true };
  }
  if (!isPlainObject(raw)) {
    return { passed: true, evaluated: [], failedGates: [] };
  }

  const candidatePaths = Array.isArray(ctx.candidatePaths) ? ctx.candidatePaths : [];
  const signalTokenSet = toLowerSet(ctx.signalTokens);
  const activeScopeSet = new Set(
    (Array.isArray(ctx.activeScopes) ? ctx.activeScopes : [])
      .filter((s) => typeof s === 'string' && s.length > 0)
  );

  const evaluated = [];
  const failed = [];

  if (Array.isArray(raw.path_glob) && raw.path_glob.length > 0) {
    evaluated.push('path_glob');
    let ok = false;
    for (const pattern of raw.path_glob) {
      for (const p of candidatePaths) {
        if (globMatch(pattern, p)) { ok = true; break; }
      }
      if (ok) break;
    }
    if (!ok) failed.push('path_glob');
  }

  if (Array.isArray(raw.trigger_keywords) && raw.trigger_keywords.length > 0) {
    evaluated.push('trigger_keywords');
    const tkSet = toLowerSet(raw.trigger_keywords);
    let overlap = 0;
    for (const t of tkSet) {
      if (signalTokenSet.has(t)) { overlap += 1; break; }
    }
    if (overlap < 1) failed.push('trigger_keywords');
  }

  const scopeIdRaw = raw.scope_id;
  const scopeIds = Array.isArray(scopeIdRaw)
    ? scopeIdRaw.filter((s) => typeof s === 'string' && s.length > 0)
    : (typeof scopeIdRaw === 'string' && scopeIdRaw.length > 0 ? [scopeIdRaw] : []);
  if (scopeIds.length > 0) {
    evaluated.push('scope_id');
    let ok = false;
    for (const id of scopeIds) {
      if (activeScopeSet.has(id)) { ok = true; break; }
    }
    if (!ok) failed.push('scope_id');
  }

  return { passed: failed.length === 0, evaluated, failedGates: failed };
}

/**
 * @param {object} item
 *   - importance: number (1..10)
 *   - last_accessed_at: ISO-8601 string
 *   - tokens: string[]
 *   - applicable_when?: object | string | null  (F §4-A)
 * @param {object} ctx
 *   - promptTokens: string[]
 *   - relevanceFn?: (item, ctx) => number  (Phase A seam; default = jaccard)
 *   - weights?: { alphaRecency, alphaImportance, alphaRelevance, decayRatePerDay }
 *   - now?: Date (test injection)
 *   - candidatePaths?: string[]   (F §5-B)
 *   - signalTokens?: string[]     (F §5-B; defaults to promptTokens)
 *   - activeScopes?: string[]     (F §5-B)
 *   - gateMode?: 'exclude' | 'penalty'  (F §5-C; default 'exclude')
 *   - gatePenalty?: number        (F §5-C; default 0.1, only when gateMode='penalty')
 * @returns {number} score, or -Infinity when gate excludes
 */
export function scoreItem(item, ctx = {}) {
  if (!item || typeof item !== 'object') return 0;
  const weights = resolveWeights(ctx.weights);
  const now = ctx.now instanceof Date ? ctx.now : new Date();
  const promptTokens = Array.isArray(ctx.promptTokens) ? ctx.promptTokens : [];
  const itemTokens = Array.isArray(item.tokens) ? item.tokens : [];

  const recency = recencyScore(item.last_accessed_at, weights.decayRatePerDay, now);
  const importance = importanceScore(item.importance);
  // Relevance seam (Phase A — G1): callers may inject a richer relevance
  // function (trigger_keywords / IDF / n-gram, or later cosine). When absent
  // or not a function, fall back to token Jaccard so existing behavior — and
  // every test written against it — is byte-identical.
  const relevance = typeof ctx.relevanceFn === 'function'
    ? ctx.relevanceFn(item, ctx)
    : jaccardSimilarity(promptTokens, itemTokens);

  const rawScore = (
    weights.alphaRecency * recency +
    weights.alphaImportance * importance +
    weights.alphaRelevance * relevance
  );

  const gateCtx = {
    candidatePaths: Array.isArray(ctx.candidatePaths) ? ctx.candidatePaths : [],
    signalTokens: Array.isArray(ctx.signalTokens) ? ctx.signalTokens : promptTokens,
    activeScopes: Array.isArray(ctx.activeScopes) ? ctx.activeScopes : []
  };
  const result = evaluateGate(item, gateCtx);
  if (result.passed) return rawScore;

  if (ctx.gateMode === 'penalty') {
    const penalty = Number.isFinite(ctx.gatePenalty) ? ctx.gatePenalty : 0.1;
    return rawScore * penalty;
  }
  return -Infinity;
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
