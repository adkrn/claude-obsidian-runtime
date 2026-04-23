// Pure metric functions for the 4-axis evaluation frame.
// No side effects, no external dependencies (Node built-ins only).
// Spec: DESIGN_C §2-B + §3-C.

export function precisionAt(retrieved, relevant, k = 5) {
  if (!Array.isArray(retrieved) || !(relevant instanceof Set)) {
    throw new TypeError('precisionAt: retrieved must be string[], relevant must be Set<string>');
  }
  if (!Number.isFinite(k) || k <= 0) {
    return 0;
  }
  const top = retrieved.slice(0, k);
  let hit = 0;
  for (const p of top) {
    if (relevant.has(p)) hit += 1;
  }
  return hit / k;
}

export function recallAt(retrieved, relevant, k = 10) {
  if (!Array.isArray(retrieved) || !(relevant instanceof Set)) {
    throw new TypeError('recallAt: retrieved must be string[], relevant must be Set<string>');
  }
  if (relevant.size === 0) {
    return 0;
  }
  if (!Number.isFinite(k) || k <= 0) {
    return 0;
  }
  const top = retrieved.slice(0, k);
  let hit = 0;
  for (const p of top) {
    if (relevant.has(p)) hit += 1;
  }
  return hit / relevant.size;
}

export function mrr(rankedList, firstEditedPath) {
  if (!Array.isArray(rankedList)) {
    throw new TypeError('mrr: rankedList must be string[]');
  }
  if (!firstEditedPath) {
    return 0;
  }
  const idx = rankedList.indexOf(firstEditedPath);
  if (idx < 0) {
    return 0;
  }
  return 1 / (idx + 1);
}

export function ndcgAt(rankedList, relevanceScores, k = 10) {
  if (!Array.isArray(rankedList) || !relevanceScores || typeof relevanceScores !== 'object') {
    throw new TypeError('ndcgAt: rankedList must be string[], relevanceScores must be Record<string, number>');
  }
  if (!Number.isFinite(k) || k <= 0) {
    return 0;
  }
  const top = rankedList.slice(0, k);
  const dcg = top.reduce((acc, p, i) => {
    const rel = Number(relevanceScores[p] ?? 0);
    return acc + rel / Math.log2(i + 2);
  }, 0);
  const idealOrder = Object.entries(relevanceScores)
    .map(([p, score]) => ({ path: p, score: Number(score) || 0 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  const idcg = idealOrder.reduce((acc, entry, i) => acc + entry.score / Math.log2(i + 2), 0);
  if (idcg === 0) {
    return 0;
  }
  return dcg / idcg;
}

export function jaccardSim(aTokens, bTokens) {
  if (!Array.isArray(aTokens) || !Array.isArray(bTokens)) {
    throw new TypeError('jaccardSim: both inputs must be arrays');
  }
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  if (a.size === 0 && b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const unionSize = a.size + b.size - intersection;
  return unionSize === 0 ? 0 : intersection / unionSize;
}

// Wilson-Hilferty approximation for chi-squared p-value.
// q = chi-squared statistic, df = degrees of freedom.
function chiSquaredPValue(stat, df) {
  if (!Number.isFinite(stat) || !Number.isFinite(df) || df <= 0) {
    return 1;
  }
  if (stat <= 0) {
    return 1;
  }
  // Wilson-Hilferty: (X/df)^(1/3) ~ N(1 - 2/(9 df), 2/(9 df))
  const ratio = stat / df;
  const cubeRoot = Math.cbrt(ratio);
  const meanShift = 1 - 2 / (9 * df);
  const variance = 2 / (9 * df);
  const z = (cubeRoot - meanShift) / Math.sqrt(variance);
  // Upper-tail p-value = 1 - Phi(z)
  return 1 - normalCdf(z);
}

// Standard normal CDF using Abramowitz & Stegun 7.1.26 approximation.
function normalCdf(z) {
  if (!Number.isFinite(z)) {
    return z > 0 ? 1 : 0;
  }
  const sign = z < 0 ? -1 : 1;
  const absZ = Math.abs(z) / Math.SQRT2;
  // erf approximation
  const a1 =  0.254829592;
  const a2 = -0.284496736;
  const a3 =  1.421413741;
  const a4 = -1.453152027;
  const a5 =  1.061405429;
  const p  =  0.3275911;
  const t = 1 / (1 + p * absZ);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absZ * absZ);
  const erf = sign * y;
  return 0.5 * (1 + erf);
}

export function chiSquared(observedA, observedB) {
  if (!Array.isArray(observedA) || !Array.isArray(observedB)) {
    throw new TypeError('chiSquared: both inputs must be number[]');
  }
  if (observedA.length !== observedB.length) {
    throw new RangeError('chiSquared: input arrays must have equal length');
  }
  const k = observedA.length;
  if (k === 0) {
    return { stat: 0, df: 0, p: 1 };
  }
  // Two-sample chi-squared homogeneity test.
  // For each category i: expected = (rowTotal_X * colTotal_i) / grandTotal
  const rowA = observedA.reduce((s, v) => s + (Number(v) || 0), 0);
  const rowB = observedB.reduce((s, v) => s + (Number(v) || 0), 0);
  const grand = rowA + rowB;
  if (grand === 0) {
    return { stat: 0, df: Math.max(0, k - 1), p: 1 };
  }
  let stat = 0;
  for (let i = 0; i < k; i += 1) {
    const colTotal = (Number(observedA[i]) || 0) + (Number(observedB[i]) || 0);
    const expA = (rowA * colTotal) / grand;
    const expB = (rowB * colTotal) / grand;
    if (expA > 0) {
      const diffA = (Number(observedA[i]) || 0) - expA;
      stat += (diffA * diffA) / expA;
    }
    if (expB > 0) {
      const diffB = (Number(observedB[i]) || 0) - expB;
      stat += (diffB * diffB) / expB;
    }
  }
  const df = Math.max(1, k - 1);
  const p = chiSquaredPValue(stat, df);
  return { stat, df, p };
}
