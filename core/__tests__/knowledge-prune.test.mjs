import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isUnaccessed,
  rowTokens,
  findDuplicatePairs,
  findStaleRows,
  buildPruneReport
} from '../knowledge-prune.mjs';

const NOW = new Date('2026-06-26T00:00:00.000Z');

function row(over = {}) {
  return {
    id: over.id || 'lesson-x',
    kind: 'lesson',
    scope: 'repo',
    title: over.title || 'T',
    summary: over.summary || 'S',
    relatedFiles: over.relatedFiles || [],
    tokens: over.tokens || [],
    updatedAt: over.updatedAt || NOW.toISOString(),
    ...over
  };
}

describe('isUnaccessed', () => {
  it('true when access_count is 0', () => {
    assert.equal(isUnaccessed({ access_count: 0 }), true);
  });
  it('true when access_count is absent (field never written)', () => {
    assert.equal(isUnaccessed({}), true);
  });
  it('false when access_count > 0', () => {
    assert.equal(isUnaccessed({ access_count: 3 }), false);
  });
});

describe('rowTokens', () => {
  it('uses precomputed tokens when present', () => {
    assert.deepEqual(rowTokens({ tokens: ['a', 'b'] }), ['a', 'b']);
  });
  it('derives from title+summary when tokens missing', () => {
    const t = rowTokens({ title: 'scene fade', summary: 'transition bug' });
    assert.ok(t.length > 0);
    assert.ok(t.includes('scene') || t.includes('transition'));
  });
});

describe('findStaleRows', () => {
  it('flags rows older than staleDays AND unaccessed', () => {
    const rows = [
      row({ id: 'old-unaccessed', updatedAt: '2026-01-01T00:00:00.000Z', access_count: 0 }),
      row({ id: 'recent', updatedAt: '2026-06-20T00:00:00.000Z', access_count: 0 }),
      row({ id: 'old-accessed', updatedAt: '2026-01-01T00:00:00.000Z', access_count: 5 })
    ];
    const stale = findStaleRows(rows, { staleDays: 90, nowDate: NOW });
    const ids = stale.map((s) => s.id);
    assert.ok(ids.includes('old-unaccessed'), 'old + unaccessed is stale');
    assert.ok(!ids.includes('recent'), 'recent is not stale');
    assert.ok(!ids.includes('old-accessed'), 'accessed rows are never stale (conservative)');
  });

  it('reports ageDays for each stale row', () => {
    const stale = findStaleRows([row({ id: 'a', updatedAt: '2026-03-28T00:00:00.000Z' })], { staleDays: 30, nowDate: NOW });
    assert.equal(stale.length, 1);
    assert.ok(stale[0].ageDays >= 89 && stale[0].ageDays <= 91);
  });

  it('returns empty when nothing is stale', () => {
    assert.deepEqual(findStaleRows([row({ updatedAt: NOW.toISOString() })], { staleDays: 90, nowDate: NOW }), []);
  });

  it('sorts oldest first', () => {
    const rows = [
      row({ id: 'newer', updatedAt: '2026-04-01T00:00:00.000Z' }),
      row({ id: 'oldest', updatedAt: '2026-01-01T00:00:00.000Z' }),
      row({ id: 'middle', updatedAt: '2026-02-15T00:00:00.000Z' })
    ];
    const stale = findStaleRows(rows, { staleDays: 30, nowDate: NOW });
    assert.deepEqual(stale.map((s) => s.id), ['oldest', 'middle', 'newer']);
  });
});

describe('findDuplicatePairs', () => {
  it('pairs rows with high token jaccard in the same scope', () => {
    const rows = [
      row({ id: 'a', tokens: ['scene', 'fade', 'transition', 'bug', 'fix'] }),
      row({ id: 'b', tokens: ['scene', 'fade', 'transition', 'bug', 'fix'] }),
      row({ id: 'c', tokens: ['unrelated', 'tokens', 'entirely', 'different', 'here'] })
    ];
    const pairs = findDuplicatePairs(rows, { jaccardThreshold: 0.6, fileOverlapMin: 2 });
    assert.equal(pairs.length, 1);
    const ids = [pairs[0].a.id, pairs[0].b.id].sort();
    assert.deepEqual(ids, ['a', 'b']);
    assert.ok(pairs[0].jaccard >= 0.6);
  });

  it('does NOT pair rows across different scopes', () => {
    const rows = [
      row({ id: 'a', scope: 'repo', tokens: ['scene', 'fade', 'transition'] }),
      row({ id: 'b', scope: 'workflow', tokens: ['scene', 'fade', 'transition'] })
    ];
    assert.deepEqual(findDuplicatePairs(rows, { jaccardThreshold: 0.5 }), []);
  });

  it('pairs on file overlap ONLY when tokens are also moderately similar', () => {
    const rows = [
      // shared files + moderate token overlap (jaccard ~0.43) → duplicate
      row({ id: 'a', tokens: ['scene', 'fade', 'gate', 'x'], relatedFiles: ['src/A.cs', 'src/B.cs'] }),
      row({ id: 'b', tokens: ['scene', 'fade', 'gate', 'y'], relatedFiles: ['src/A.cs', 'src/B.cs'] })
    ];
    const pairs = findDuplicatePairs(rows, { jaccardThreshold: 0.9, fileOverlapMin: 2, fileOverlapMinJaccard: 0.3 });
    assert.equal(pairs.length, 1);
    assert.ok(pairs[0].fileOverlap >= 2);
  });

  it('does NOT pair on file overlap when tokens are unrelated (noise guard)', () => {
    const rows = [
      // same files but completely different text — NOT a duplicate
      row({ id: 'a', tokens: ['alpha', 'beta', 'gamma'], relatedFiles: ['src/A.cs', 'src/B.cs'] }),
      row({ id: 'b', tokens: ['delta', 'epsilon', 'zeta'], relatedFiles: ['src/A.cs', 'src/B.cs'] })
    ];
    const pairs = findDuplicatePairs(rows, { jaccardThreshold: 0.9, fileOverlapMin: 2, fileOverlapMinJaccard: 0.3 });
    assert.deepEqual(pairs, [], 'file overlap alone must not flag unrelated lessons');
  });

  it('does not pair a row with itself', () => {
    const pairs = findDuplicatePairs([row({ id: 'solo', tokens: ['a', 'b', 'c'] })], { jaccardThreshold: 0.1 });
    assert.deepEqual(pairs, []);
  });
});

describe('buildPruneReport — read-only aggregate', () => {
  it('combines stale + duplicates with counts and is pure (no mutation)', () => {
    const rows = [
      row({ id: 'old', updatedAt: '2026-01-01T00:00:00.000Z', access_count: 0, tokens: ['p', 'q', 'r'] }),
      row({ id: 'dupA', tokens: ['scene', 'fade', 'transition', 'gate'] }),
      row({ id: 'dupB', tokens: ['scene', 'fade', 'transition', 'gate'] })
    ];
    const frozen = JSON.stringify(rows);
    const report = buildPruneReport(rows, { staleDays: 90, nowDate: NOW, jaccardThreshold: 0.6 });

    assert.equal(report.kind, undefined); // aggregate has no single kind
    assert.equal(report.totalRows, 3);
    assert.ok(report.stale.length >= 1);
    assert.ok(report.duplicatePairs.length >= 1);
    assert.equal(report.staleCount, report.stale.length);
    assert.equal(report.duplicateCount, report.duplicatePairs.length);
    // never deletes / mutates
    assert.equal(JSON.stringify(rows), frozen, 'input rows must be untouched');
  });

  it('handles empty input', () => {
    const report = buildPruneReport([], { staleDays: 90, nowDate: NOW });
    assert.equal(report.totalRows, 0);
    assert.deepEqual(report.stale, []);
    assert.deepEqual(report.duplicatePairs, []);
  });
});
