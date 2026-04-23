// Compare engine: pure functions over two EvalReport JSONs.
// Design-C §2-C + §3-D. No I/O.
//
// Exports:
//   compareReports(reportA, reportB) → CompareResult
//   formatCompareTable(result, mode='text'|'json') → string

const TOKEN_DELTA_WARN = 0.15; // ±15% threshold (AC-11).
const WALLTIME_DELTA_WARN = 0.20; // ±20% threshold.
const DISTRIBUTION_SKEW_WARN = 0.10; // 10% relative skew.

function asObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

function numberOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function collectSchemaKeys(goldenRuns) {
  const set = new Set();
  if (!Array.isArray(goldenRuns)) return set;
  for (const run of goldenRuns) {
    const keys = Array.isArray(run?.rawSchemaKeys) ? run.rawSchemaKeys : [];
    for (const k of keys) set.add(String(k));
  }
  return set;
}

function jaccardOfSets(a, b) {
  if (a.size === 0 && b.size === 0) return 1.0;
  let intersection = 0;
  for (const k of a) {
    if (b.has(k)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 1.0 : intersection / union;
}

function sumField(runs, field) {
  if (!Array.isArray(runs)) return 0;
  let sum = 0;
  for (const r of runs) {
    const v = Number(r?.[field]);
    if (Number.isFinite(v)) sum += v;
  }
  return sum;
}

function relativeSkew(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  const max = Math.max(Math.abs(a), Math.abs(b));
  if (max === 0) return 0;
  return Math.abs(a - b) / max;
}

function safePercent(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (b === 0) {
    return a === 0 ? 0 : null;
  }
  return Math.abs(a - b) / Math.abs(b);
}

function roundMaybe(v, digits = 4) {
  if (!Number.isFinite(v)) return v;
  const factor = Math.pow(10, digits);
  return Math.round(v * factor) / factor;
}

export function compareReports(reportA, reportB) {
  if (!reportA || typeof reportA !== 'object') {
    throw new TypeError('compareReports: reportA required');
  }
  if (!reportB || typeof reportB !== 'object') {
    throw new TypeError('compareReports: reportB required');
  }

  // --- Equivalence axis: schemaMatch + distributionSkew ---
  const keysA = collectSchemaKeys(reportA.goldenRuns);
  const keysB = collectSchemaKeys(reportB.goldenRuns);
  const schemaMatch = jaccardOfSets(keysA, keysB);

  const distributionSkew = {
    readFirstCountSkew: relativeSkew(
      sumField(reportA.goldenRuns, 'readFirstCount'),
      sumField(reportB.goldenRuns, 'readFirstCount')
    ),
    codeHitsCountSkew: relativeSkew(
      sumField(reportA.goldenRuns, 'codeHitsCount'),
      sumField(reportB.goldenRuns, 'codeHitsCount')
    ),
    guardrailsCountSkew: relativeSkew(
      sumField(reportA.goldenRuns, 'guardrailsCount'),
      sumField(reportB.goldenRuns, 'guardrailsCount')
    ),
    matchedScopesCountSkew: relativeSkew(
      sumField(reportA.goldenRuns, 'matchedScopesCount') ||
        (Array.isArray(reportA.goldenRuns)
          ? reportA.goldenRuns.reduce((s, r) => s + (Array.isArray(r?.actualScopes) ? r.actualScopes.length : 0), 0)
          : 0),
      sumField(reportB.goldenRuns, 'matchedScopesCount') ||
        (Array.isArray(reportB.goldenRuns)
          ? reportB.goldenRuns.reduce((s, r) => s + (Array.isArray(r?.actualScopes) ? r.actualScopes.length : 0), 0)
          : 0)
    )
  };
  const maxDistributionSkew = Math.max(
    distributionSkew.readFirstCountSkew,
    distributionSkew.codeHitsCountSkew,
    distributionSkew.guardrailsCountSkew,
    distributionSkew.matchedScopesCountSkew
  );

  // --- Presence axis (informational) ---
  const presenceA = numberOrNull(asObject(reportA.presence).checksPassed);
  const presenceB = numberOrNull(asObject(reportB.presence).checksPassed);
  const presenceMatch =
    presenceA === null || presenceB === null ? null : presenceA === presenceB;

  // --- Quality axis: use Quality section deltas (averages). ---
  const qa = asObject(reportA.quality);
  const qb = asObject(reportB.quality);
  const quality = {
    precisionAt5: {
      a: numberOrNull(qa.precisionAt5),
      b: numberOrNull(qb.precisionAt5),
      delta: null
    },
    recallAt10: {
      a: numberOrNull(qa.recallAt10),
      b: numberOrNull(qb.recallAt10),
      delta: null
    },
    mrr: {
      a: numberOrNull(qa.mrr),
      b: numberOrNull(qb.mrr),
      delta: null
    },
    ndcgAt10: {
      a: numberOrNull(qa.ndcgAt10),
      b: numberOrNull(qb.ndcgAt10),
      delta: null
    }
  };
  for (const key of Object.keys(quality)) {
    const cell = quality[key];
    if (cell.a !== null && cell.b !== null) {
      cell.delta = cell.a - cell.b;
    }
  }

  // --- LessonReuse axis ---
  const la = asObject(reportA.lessonReuse);
  const lb = asObject(reportB.lessonReuse);
  const lessonReuse = {
    reuseRate: {
      a: numberOrNull(la.reuseRate),
      b: numberOrNull(lb.reuseRate),
      delta: null
    }
  };
  if (lessonReuse.reuseRate.a !== null && lessonReuse.reuseRate.b !== null) {
    lessonReuse.reuseRate.delta = lessonReuse.reuseRate.a - lessonReuse.reuseRate.b;
  }

  // --- Performance axis ---
  const pa = asObject(reportA.performance);
  const pb = asObject(reportB.performance);
  const tokenA = numberOrNull(pa.tokenWma7d);
  const tokenB = numberOrNull(pb.tokenWma7d);
  const wallA = numberOrNull(pa.avgTaskStartMs);
  const wallB = numberOrNull(pb.avgTaskStartMs);
  const tokenDeltaPercent =
    tokenA !== null && tokenB !== null ? safePercent(tokenA, tokenB) : null;
  const wallTimeDeltaPercent =
    wallA !== null && wallB !== null ? safePercent(wallA, wallB) : null;
  const tokenWithin =
    tokenDeltaPercent === null || tokenDeltaPercent <= TOKEN_DELTA_WARN;
  const wallWithin =
    wallTimeDeltaPercent === null || wallTimeDeltaPercent <= WALLTIME_DELTA_WARN;
  const performance = {
    tokenWma7d: { a: tokenA, b: tokenB, deltaPercent: tokenDeltaPercent },
    avgTaskStartMs: { a: wallA, b: wallB, deltaPercent: wallTimeDeltaPercent },
    tokenDeltaPercent,
    wallTimeDeltaPercent,
    withinThreshold: tokenWithin && wallWithin
  };

  // --- Verdict ---
  const failReasons = [];
  const warnReasons = [];
  if (schemaMatch < 1.0) failReasons.push(`schemaMatch=${roundMaybe(schemaMatch)}`);
  if (maxDistributionSkew > DISTRIBUTION_SKEW_WARN * 2) {
    failReasons.push(`distributionSkew=${roundMaybe(maxDistributionSkew)}`);
  } else if (maxDistributionSkew > DISTRIBUTION_SKEW_WARN) {
    warnReasons.push(`distributionSkew=${roundMaybe(maxDistributionSkew)}`);
  }
  if (tokenDeltaPercent !== null) {
    if (tokenDeltaPercent > TOKEN_DELTA_WARN) {
      failReasons.push(`tokenDeltaPercent=${roundMaybe(tokenDeltaPercent)}`);
    }
  }
  if (wallTimeDeltaPercent !== null) {
    if (wallTimeDeltaPercent > WALLTIME_DELTA_WARN) {
      failReasons.push(`wallTimeDeltaPercent=${roundMaybe(wallTimeDeltaPercent)}`);
    }
  }

  const verdict = failReasons.length > 0 ? 'fail' : warnReasons.length > 0 ? 'warn' : 'pass';

  return {
    projectA: reportA.projectId || '',
    projectB: reportB.projectId || '',
    reportedAtA: reportA.reportedAt || '',
    reportedAtB: reportB.reportedAt || '',
    presence: { a: presenceA, b: presenceB, match: presenceMatch },
    equivalence: {
      schemaMatch,
      distributionSkew,
      maxDistributionSkew
    },
    quality,
    lessonReuse,
    performance,
    verdict,
    warnings: warnReasons,
    failures: failReasons
  };
}

function formatPairText(label, cell) {
  const a = cell.a === null ? '–' : Number(cell.a).toFixed(3);
  const b = cell.b === null ? '–' : Number(cell.b).toFixed(3);
  const delta = cell.delta === null || cell.delta === undefined
    ? '–'
    : Number(cell.delta).toFixed(3);
  return `  ${label.padEnd(18)} A=${a.padStart(8)}  B=${b.padStart(8)}  Δ=${delta.padStart(8)}`;
}

function formatPercent(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '–';
  return `${(v * 100).toFixed(1)}%`;
}

export function formatCompareTable(result, mode = 'text') {
  if (mode === 'json') {
    return JSON.stringify(result, null, 2);
  }
  const lines = [];
  lines.push('Eval compare');
  lines.push(`  A: ${result.projectA} @ ${result.reportedAtA}`);
  lines.push(`  B: ${result.projectB} @ ${result.reportedAtB}`);
  lines.push('');
  lines.push('Presence / Equivalence');
  const presenceMatch = result.presence.match;
  const presenceLine =
    presenceMatch === null ? 'unknown' : presenceMatch ? 'match' : 'diverges';
  lines.push(`  presence           ${presenceLine}`);
  lines.push(`  schemaMatch        ${result.equivalence.schemaMatch.toFixed(3)}`);
  lines.push(
    `  distributionSkew   max=${formatPercent(result.equivalence.maxDistributionSkew)}`
  );
  lines.push('');
  lines.push('Quality');
  lines.push(formatPairText('precisionAt5', result.quality.precisionAt5));
  lines.push(formatPairText('recallAt10', result.quality.recallAt10));
  lines.push(formatPairText('mrr', result.quality.mrr));
  lines.push(formatPairText('ndcgAt10', result.quality.ndcgAt10));
  lines.push('');
  lines.push('LessonReuse');
  lines.push(formatPairText('reuseRate', result.lessonReuse.reuseRate));
  lines.push('');
  lines.push('Performance');
  lines.push(
    `  tokenWma7d         A=${
      result.performance.tokenWma7d.a === null ? '–' : Number(result.performance.tokenWma7d.a).toFixed(0)
    }  B=${
      result.performance.tokenWma7d.b === null ? '–' : Number(result.performance.tokenWma7d.b).toFixed(0)
    }  Δ=${formatPercent(result.performance.tokenDeltaPercent)}`
  );
  lines.push(
    `  avgTaskStartMs     A=${
      result.performance.avgTaskStartMs.a === null ? '–' : Number(result.performance.avgTaskStartMs.a).toFixed(0)
    }  B=${
      result.performance.avgTaskStartMs.b === null ? '–' : Number(result.performance.avgTaskStartMs.b).toFixed(0)
    }  Δ=${formatPercent(result.performance.wallTimeDeltaPercent)}`
  );
  lines.push(
    `  withinThreshold    ${result.performance.withinThreshold ? 'yes' : 'no'}`
  );
  lines.push('');
  lines.push(`Verdict: ${result.verdict.toUpperCase()}`);
  if (result.failures.length > 0) {
    lines.push(`  failures: ${result.failures.join('; ')}`);
  }
  if (result.warnings.length > 0) {
    lines.push(`  warnings: ${result.warnings.join('; ')}`);
  }
  return lines.join('\n');
}
