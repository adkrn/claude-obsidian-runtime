import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  triggerKeywordOverlap,
  improvedSimilarity,
  DEFAULT_SIMILARITY_WEIGHTS
} from '../similarity.mjs';

// ── triggerKeywordOverlap (Phase A — G1) ─────────────────────────

test('triggerKeywordOverlap: absent trigger_keywords → 0 (graceful)', () => {
  assert.equal(triggerKeywordOverlap(['scene', 'fade'], { tokens: ['x'] }), 0);
});

test('triggerKeywordOverlap: empty array → 0', () => {
  assert.equal(triggerKeywordOverlap(['scene'], { trigger_keywords: [] }), 0);
});

test('triggerKeywordOverlap: empty promptTokens → 0 (no divide-by-zero)', () => {
  assert.equal(triggerKeywordOverlap([], { trigger_keywords: ['scene'] }), 0);
});

test('triggerKeywordOverlap: overlapCount / promptTokens.length', () => {
  // prompt has 4 tokens, 2 of them appear in trigger_keywords → 2/4 = 0.5
  const item = { trigger_keywords: ['scene', 'fade', 'unrelated'] };
  assert.equal(triggerKeywordOverlap(['scene', 'fade', 'foo', 'bar'], item), 0.5);
});

test('triggerKeywordOverlap: case-insensitive match', () => {
  const item = { trigger_keywords: ['Scene', 'FADE'] };
  // promptTokens are already lowercased by tokenizeSearchText; tk may be mixed case.
  assert.equal(triggerKeywordOverlap(['scene', 'fade'], item), 1);
});

test('triggerKeywordOverlap: clamped to [0,1] when tk superset of prompt', () => {
  const item = { trigger_keywords: ['scene', 'fade', 'extra'] };
  // every prompt token matches → 2/2 = 1.0, never exceeds 1
  assert.ok(triggerKeywordOverlap(['scene', 'fade'], item) <= 1);
});

// ── improvedSimilarity — Phase A composition (jaccard + W_TK * tkOverlap) ──

test('improvedSimilarity: no trigger_keywords → equals base jaccard', () => {
  const ctx = { promptTokens: ['a', 'b'] };
  const item = { tokens: ['a', 'b', 'c'] };
  // jaccard(['a','b'],['a','b','c']) = 2/3; tk term = 0
  const sim = improvedSimilarity(ctx, item, {});
  assert.ok(Math.abs(sim - (2 / 3)) < 1e-9);
});

test('improvedSimilarity: trigger_keywords lifts score above base jaccard', () => {
  const ctx = { promptTokens: ['scene', 'fade'] };
  const base = { tokens: ['scene', 'fade'] };           // jaccard = 1.0
  const withTk = { tokens: ['scene', 'fade'], trigger_keywords: ['scene', 'fade'] };
  const baseSim = improvedSimilarity(ctx, base, {});
  const tkSim = improvedSimilarity(ctx, withTk, {});
  assert.ok(tkSim > baseSim, `tk should lift: ${tkSim} > ${baseSim}`);
});

test('improvedSimilarity: exact Phase A formula (jaccard + W_TK * overlap/len)', () => {
  const ctx = { promptTokens: ['scene', 'fade', 'x', 'y'] };
  const item = { tokens: ['scene'], trigger_keywords: ['scene', 'fade'] };
  // jaccard(['scene','fade','x','y'],['scene']) = 1/4 = 0.25
  // tkOverlap = 2/4 = 0.5 ; W_TK default 0.5 → +0.25
  const w = DEFAULT_SIMILARITY_WEIGHTS;
  const expected = 0.25 + w.triggerKeywordWeight * 0.5;
  const sim = improvedSimilarity(ctx, item, {});
  assert.ok(Math.abs(sim - expected) < 1e-9, `got ${sim}, expected ${expected}`);
});

test('improvedSimilarity: weights override via opts.weights', () => {
  const ctx = { promptTokens: ['scene', 'fade'] };
  const item = { tokens: ['scene', 'fade'], trigger_keywords: ['scene', 'fade'] };
  // W_TK = 0 → equals base jaccard 1.0
  const sim = improvedSimilarity(ctx, item, { weights: { triggerKeywordWeight: 0 } });
  assert.ok(Math.abs(sim - 1) < 1e-9);
});

test('improvedSimilarity: defensive on missing fields', () => {
  assert.equal(improvedSimilarity({}, {}, {}), 0);
  assert.equal(improvedSimilarity({ promptTokens: [] }, { tokens: [] }, {}), 0);
});
