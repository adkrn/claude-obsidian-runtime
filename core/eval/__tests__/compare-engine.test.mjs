import test from 'node:test';
import assert from 'node:assert/strict';

import { compareReports, formatCompareTable } from '../compare-engine.mjs';

function baseReport(over = {}) {
  return {
    projectId: 'A',
    runtimeVersion: '3.0.0',
    reportedAt: '2026-04-23T00:00:00.000Z',
    goldenRuns: [
      {
        taskId: 't1',
        readFirstCount: 2,
        codeHitsCount: 3,
        guardrailsCount: 1,
        actualScopes: ['workflow'],
        rawSchemaKeys: ['taskId', 'readFirst', 'codeHits', 'knowledgeHits', 'guardrails', 'matchedScopes', 'matchedGroups', 'currentTaskPath', 'lastContextPath']
      }
    ],
    presence: { checksPassed: 12 },
    equivalence: { schemaMatch: 1.0, distributionSkew: 0 },
    quality: { precisionAt5: 0.8, recallAt10: 0.7, mrr: 0.9, ndcgAt10: 0.85, sampleCount: 10 },
    lessonReuse: { reuseRate: 0.4, lessonsCreatedPre: 5, lessonsRematched: 2, confidenceDist: { high: 1, medium: 3, low: 1 } },
    performance: { avgTaskStartMs: 1000, tokenWma7d: 8000, deltaVsPriorWeek: -0.05, monotoneDecreasing3d: true, perDaySeries: [] },
    ...over
  };
}

test('compareReports — identical reports yield pass + schemaMatch 1.0', () => {
  const a = baseReport({ projectId: 'A' });
  const b = baseReport({ projectId: 'B' });
  const r = compareReports(a, b);
  assert.equal(r.equivalence.schemaMatch, 1.0);
  assert.equal(r.verdict, 'pass');
  assert.ok(r.performance.withinThreshold);
});

test('compareReports — schema divergence yields fail', () => {
  const a = baseReport();
  const b = baseReport({
    goldenRuns: [{ ...baseReport().goldenRuns[0], rawSchemaKeys: ['taskId', 'readFirst'] }]
  });
  const r = compareReports(a, b);
  assert.ok(r.equivalence.schemaMatch < 1.0);
  assert.equal(r.verdict, 'fail');
});

test('compareReports — performance token delta >15% fails', () => {
  const a = baseReport();
  const b = baseReport({
    performance: { ...baseReport().performance, tokenWma7d: 10000 }
  });
  const r = compareReports(a, b);
  assert.ok(r.performance.tokenDeltaPercent > 0.15);
  assert.equal(r.verdict, 'fail');
  assert.equal(r.performance.withinThreshold, false);
});

test('formatCompareTable — text and json modes both emit strings', () => {
  const a = baseReport();
  const b = baseReport({ projectId: 'B' });
  const r = compareReports(a, b);
  const textOut = formatCompareTable(r, 'text');
  const jsonOut = formatCompareTable(r, 'json');
  assert.ok(typeof textOut === 'string' && textOut.includes('Verdict'));
  assert.ok(typeof jsonOut === 'string');
  const parsed = JSON.parse(jsonOut);
  assert.equal(parsed.verdict, r.verdict);
});

test('compareReports — divide-by-zero guard (tokenWma7d 0 on both)', () => {
  const a = baseReport({ performance: { ...baseReport().performance, tokenWma7d: 0 } });
  const b = baseReport({ performance: { ...baseReport().performance, tokenWma7d: 0 } });
  const r = compareReports(a, b);
  assert.equal(r.performance.tokenDeltaPercent, 0);
  assert.equal(r.verdict, 'pass');
});
