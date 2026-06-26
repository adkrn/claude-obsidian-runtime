import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WEIGHTS,
  daysSince,
  importanceScore,
  jaccardSimilarity,
  recencyScore,
  scoreItem,
  scoreItems
} from '../retrieval-scoring.mjs';

test('jaccardSimilarity returns 0 for empty sets', () => {
  assert.equal(jaccardSimilarity([], []), 0);
  assert.equal(jaccardSimilarity(['a'], []), 0);
});

test('jaccardSimilarity computes intersection / union', () => {
  assert.equal(jaccardSimilarity(['a', 'b'], ['a', 'b']), 1);
  assert.equal(jaccardSimilarity(['a', 'b'], ['a']), 0.5);
  assert.equal(jaccardSimilarity(['a', 'b', 'c'], ['c', 'd']), 0.25);
});

test('importanceScore clamps to [0,1]', () => {
  assert.equal(importanceScore(0), 0);
  assert.equal(importanceScore(5), 0.5);
  assert.equal(importanceScore(10), 1);
  assert.equal(importanceScore(15), 1);
  assert.equal(importanceScore(undefined), 0);
});

test('daysSince returns 0 for future timestamps', () => {
  const now = new Date('2026-04-23T00:00:00Z');
  const future = new Date('2026-04-24T00:00:00Z').toISOString();
  assert.equal(daysSince(future, now), 0);
});

test('recencyScore decays exponentially', () => {
  const now = new Date('2026-04-23T00:00:00Z');
  const today = now.toISOString();
  const tenDaysAgo = new Date('2026-04-13T00:00:00Z').toISOString();
  assert.equal(recencyScore(today, 0.05, now), 1);
  const decayed = recencyScore(tenDaysAgo, 0.05, now);
  assert.ok(decayed < 1 && decayed > 0);
  assert.ok(Math.abs(decayed - Math.exp(-0.5)) < 1e-9);
});

test('scoreItem applies default weights and accepts override', () => {
  const now = new Date('2026-04-23T00:00:00Z');
  const item = {
    importance: 9,
    last_accessed_at: now.toISOString(),
    tokens: ['a', 'b']
  };
  const ctx = { promptTokens: ['a'], now };
  const defaultScore = scoreItem(item, ctx);
  // recency = 1, importance = 0.9, relevance = 0.5
  // expected = 1*1 + 1*0.9 + 1.5*0.5 = 2.65
  assert.ok(Math.abs(defaultScore - 2.65) < 1e-9);

  const flat = scoreItem(item, {
    ...ctx,
    weights: { alphaRecency: 1, alphaImportance: 1, alphaRelevance: 1, decayRatePerDay: 0.05 }
  });
  // expected = 1 + 0.9 + 0.5 = 2.4
  assert.ok(Math.abs(flat - 2.4) < 1e-9);
});

test('scoreItems sorts descending and stable', () => {
  const now = new Date('2026-04-23T00:00:00Z');
  const items = [
    { id: 'low', importance: 3, last_accessed_at: now.toISOString(), tokens: [] },
    { id: 'high', importance: 9, last_accessed_at: now.toISOString(), tokens: [] },
    { id: 'mid', importance: 6, last_accessed_at: now.toISOString(), tokens: [] }
  ];
  const ranked = scoreItems(items, { promptTokens: [], now });
  assert.deepEqual(ranked.map((entry) => entry.item.id), ['high', 'mid', 'low']);
});

test('DEFAULT_WEIGHTS frozen and matches spec', () => {
  assert.equal(DEFAULT_WEIGHTS.alphaRecency, 1.0);
  assert.equal(DEFAULT_WEIGHTS.alphaImportance, 1.0);
  assert.equal(DEFAULT_WEIGHTS.alphaRelevance, 1.5);
  assert.equal(DEFAULT_WEIGHTS.decayRatePerDay, 0.05);
});

// ── relevanceFn seam (Phase A — G1 base) ─────────────────────────

test('seam: relevanceFn NOT injected → identical jaccard behavior (465 invariant)', () => {
  const now = new Date('2026-04-23T00:00:00Z');
  const item = {
    importance: 9,
    last_accessed_at: now.toISOString(),
    tokens: ['a', 'b']
  };
  // No relevanceFn in ctx → must fall back to jaccard(['a'],['a','b'])=0.5.
  // recency=1, importance=0.9, relevance=1.5*0.5 → 2.65 (unchanged baseline).
  const score = scoreItem(item, { promptTokens: ['a'], now });
  assert.ok(Math.abs(score - 2.65) < 1e-9);
});

test('seam: relevanceFn injected → used for relevance term (alphaRelevance * fn)', () => {
  const now = new Date('2026-04-23T00:00:00Z');
  const item = {
    importance: 9,
    last_accessed_at: now.toISOString(),
    tokens: ['a', 'b']
  };
  // Inject a constant relevanceFn → relevance term becomes 1.5 * 0.2 = 0.3.
  // recency=1, importance=0.9 → 1 + 0.9 + 0.3 = 2.2.
  const score = scoreItem(item, {
    promptTokens: ['a'],
    now,
    relevanceFn: () => 0.2
  });
  assert.ok(Math.abs(score - 2.2) < 1e-9);
});

test('seam: relevanceFn receives (item, ctx) and stays synchronous', () => {
  const now = new Date('2026-04-23T00:00:00Z');
  const item = { importance: 0, last_accessed_at: '', tokens: ['x'] };
  let seenItem = null;
  let seenCtx = null;
  const ctx = {
    promptTokens: ['x'],
    now,
    relevanceFn: (it, c) => { seenItem = it; seenCtx = c; return 0; }
  };
  const score = scoreItem(item, ctx);
  // recency=0 (empty date), importance=0, relevance=0 → 0. No promise leak.
  assert.equal(typeof score, 'number');
  assert.equal(seenItem, item);
  assert.equal(seenCtx, ctx);
});

test('seam: non-function relevanceFn is ignored → jaccard fallback', () => {
  const now = new Date('2026-04-23T00:00:00Z');
  const item = { importance: 9, last_accessed_at: now.toISOString(), tokens: ['a', 'b'] };
  const score = scoreItem(item, { promptTokens: ['a'], now, relevanceFn: 'not-a-fn' });
  assert.ok(Math.abs(score - 2.65) < 1e-9);
});
