import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  triggerKeywordOverlap,
  improvedSimilarity,
  buildIdf,
  bm25Lite,
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

// ── buildIdf / bm25Lite (Phase B — G2) ───────────────────────────

test('buildIdf: smoothed idf, N=1 df=1 → ln(2/2)+1 = 1', () => {
  const { idf, avgdl, n } = buildIdf([['a', 'b']]);
  assert.equal(n, 1);
  assert.equal(avgdl, 2);
  // each token appears in the single doc → df=1, N=1 → ln(2/2)+1 = 1
  assert.ok(Math.abs(idf.get('a') - 1) < 1e-9);
});

test('buildIdf: rare token has higher idf than ubiquitous token', () => {
  // 'common' in all 4 docs; 'rare' in 1.
  const corpus = [
    ['common', 'rare'],
    ['common', 'x'],
    ['common', 'y'],
    ['common', 'z']
  ];
  const { idf } = buildIdf(corpus);
  assert.ok(idf.get('rare') > idf.get('common'),
    `rare(${idf.get('rare')}) should exceed common(${idf.get('common')})`);
});

test('buildIdf: handles empty / non-array corpus defensively', () => {
  const a = buildIdf([]);
  assert.equal(a.n, 0);
  assert.equal(a.avgdl, 0);
  assert.equal(a.idf.size, 0);
  const b = buildIdf(null);
  assert.equal(b.n, 0);
});

test('bm25Lite: self-score normalization → identical query/doc near 1.0', () => {
  const { idf, avgdl } = buildIdf([['scene', 'fade'], ['other', 'tokens']]);
  // doc == query, b=0 (no length penalty) → self-normalized to 1.0
  const s = bm25Lite(['scene', 'fade'], ['scene', 'fade'], idf, { avgdl, b: 0 });
  assert.ok(Math.abs(s - 1) < 1e-9, `expected ~1.0, got ${s}`);
});

test('bm25Lite: returns within [0,1]', () => {
  const corpus = [['a', 'b', 'c'], ['b', 'c', 'd'], ['c', 'd', 'e']];
  const { idf, avgdl } = buildIdf(corpus);
  for (const doc of corpus) {
    const s = bm25Lite(['a', 'b'], doc, idf, { avgdl });
    assert.ok(s >= 0 && s <= 1, `out of range: ${s}`);
  }
});

test('bm25Lite: empty query or no overlap → 0', () => {
  const { idf, avgdl } = buildIdf([['a', 'b']]);
  assert.equal(bm25Lite([], ['a', 'b'], idf, { avgdl }), 0);
  assert.equal(bm25Lite(['z'], ['a', 'b'], idf, { avgdl }), 0);
});

test('bm25Lite: a query token absent from idf contributes 0, never NaN', () => {
  const { idf, avgdl } = buildIdf([['a', 'b']]);
  const s = bm25Lite(['a', 'unknown'], ['a', 'b'], idf, { avgdl });
  assert.ok(Number.isFinite(s));
  assert.ok(s > 0 && s <= 1);
});

test('bm25Lite suppresses boilerplate: for a fixed query, the rare overlap dominates', () => {
  // Retrieval ranks DIFFERENT docs against the SAME query. Query mentions both a
  // ubiquitous boilerplate token ('workflow') and a rare discriminating one
  // ('vector3s'). A doc matching only the rare token must outrank a doc matching
  // only the boilerplate token — that is G2 (idf suppresses high-frequency noise).
  const corpus = [
    ['workflow', 'vector3s'],
    ['workflow', 'a'],
    ['workflow', 'b'],
    ['workflow', 'c'],
    ['workflow', 'd']
  ];
  const { idf, avgdl, n } = buildIdf(corpus);
  const query = ['workflow', 'vector3s'];
  const docRareOnly = ['vector3s', 'zzz'];     // matches only the high-idf token
  const docCommonOnly = ['workflow', 'zzz'];   // matches only the low-idf token
  const rare = bm25Lite(query, docRareOnly, idf, { avgdl, n });
  const common = bm25Lite(query, docCommonOnly, idf, { avgdl, n });
  assert.ok(rare > common,
    `rare-token doc(${rare}) should beat boilerplate-token doc(${common})`);
});

test('improvedSimilarity: idf+bm25 opts switch base off jaccard', () => {
  const corpus = [['scene', 'fade'], ['x', 'y']];
  const { idf, avgdl } = buildIdf(corpus);
  const ctx = { promptTokens: ['scene', 'fade'] };
  const item = { tokens: ['scene', 'fade'] };
  const sim = improvedSimilarity(ctx, item, { idf, avgdl, bm25: bm25Lite });
  // base now bm25 (not jaccard); strong match should be high (~1)
  assert.ok(sim > 0.5, `expected strong bm25 base, got ${sim}`);
});
