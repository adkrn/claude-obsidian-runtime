import test from 'node:test';
import assert from 'node:assert/strict';

import {
  precisionAt,
  recallAt,
  mrr,
  ndcgAt,
  jaccardSim,
  chiSquared
} from '../metrics.mjs';

test('precisionAt: normal case 2/5', () => {
  const retrieved = ['a', 'b', 'c', 'd', 'e'];
  const relevant = new Set(['a', 'c']);
  assert.equal(precisionAt(retrieved, relevant, 5), 0.4);
});

test('precisionAt: k larger than list still divides by k', () => {
  const retrieved = ['a', 'b'];
  const relevant = new Set(['a', 'b']);
  assert.equal(precisionAt(retrieved, relevant, 5), 0.4);
});

test('precisionAt: k=0 returns 0 (no divide-by-zero)', () => {
  assert.equal(precisionAt(['a', 'b'], new Set(['a']), 0), 0);
});

test('recallAt: normal case 2/3', () => {
  const retrieved = ['a', 'b', 'c', 'x', 'y'];
  const relevant = new Set(['a', 'b', 'z']);
  assert.equal(recallAt(retrieved, relevant, 10), 2 / 3);
});

test('recallAt: empty relevant returns 0 (divide-by-zero guard)', () => {
  assert.equal(recallAt(['a', 'b'], new Set(), 10), 0);
});

test('recallAt: k smaller than list cuts off', () => {
  const retrieved = ['a', 'b', 'c', 'd'];
  const relevant = new Set(['c', 'd']);
  assert.equal(recallAt(retrieved, relevant, 2), 0);
});

test('mrr: first edited at index 0 → 1.0', () => {
  assert.equal(mrr(['a', 'b', 'c'], 'a'), 1);
});

test('mrr: first edited at index 2 → 1/3', () => {
  assert.equal(mrr(['a', 'b', 'c'], 'c'), 1 / 3);
});

test('mrr: missing path returns 0', () => {
  assert.equal(mrr(['a', 'b'], 'z'), 0);
  assert.equal(mrr(['a', 'b'], null), 0);
});

test('ndcgAt: ideal order yields 1.0', () => {
  const ranked = ['a', 'b', 'c'];
  const scores = { a: 1, b: 1, c: 0 };
  assert.equal(ndcgAt(ranked, scores, 3), 1);
});

test('ndcgAt: reversed order yields lower than ideal', () => {
  const ranked = ['c', 'b', 'a'];
  const scores = { a: 1, b: 1, c: 0 };
  const result = ndcgAt(ranked, scores, 3);
  assert.ok(result < 1 && result > 0, `ndcg should be in (0,1), got ${result}`);
});

test('ndcgAt: all-zero relevance returns 0 (no divide-by-zero)', () => {
  assert.equal(ndcgAt(['a', 'b'], { a: 0, b: 0 }, 2), 0);
});

test('jaccardSim: identical sets → 1.0', () => {
  assert.equal(jaccardSim(['x', 'y'], ['y', 'x']), 1);
});

test('jaccardSim: disjoint sets → 0', () => {
  assert.equal(jaccardSim(['a'], ['b']), 0);
});

test('jaccardSim: empty/empty → 0 (no divide-by-zero)', () => {
  assert.equal(jaccardSim([], []), 0);
});

test('chiSquared: identical distributions → low stat, high p', () => {
  const result = chiSquared([10, 20, 5], [10, 20, 5]);
  assert.equal(result.stat, 0);
  assert.equal(result.df, 2);
  assert.ok(result.p > 0.95, `p should be near 1, got ${result.p}`);
});

test('chiSquared: divergent distributions → high stat, low p', () => {
  const result = chiSquared([30, 0, 0], [0, 30, 0]);
  assert.ok(result.stat > 10, `stat should be large, got ${result.stat}`);
  assert.ok(result.p < 0.05, `p should be < 0.05, got ${result.p}`);
});

test('chiSquared: empty arrays return df=0, p=1', () => {
  const result = chiSquared([], []);
  assert.equal(result.stat, 0);
  assert.equal(result.df, 0);
  assert.equal(result.p, 1);
});

test('chiSquared: rejects mismatched lengths', () => {
  assert.throws(() => chiSquared([1, 2], [1, 2, 3]), /equal length/);
});
