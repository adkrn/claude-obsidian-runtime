// DESIGN_MANUS_C §7 — MMR diversity penalty + emitSortByPath AC tests (14 cases).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyMMR,
  emitSortByPath,
  DEFAULT_DIVERSITY_LAMBDA,
  DEFAULT_DIVERSITY_JACCARD_THRESHOLD
} from '../mmr.mjs';

function makeScored(items) {
  return items.map((entry, index) => ({
    item: entry.item,
    score: entry.score,
    index
  }));
}

// ── #1 mmr_disabled_when_lambda_zero ─────────────────────────────
describe('C-1 mmr_disabled_when_lambda_zero', () => {
  it('lambda=0 returns input unchanged with no penalties', () => {
    const input = makeScored([
      { item: { tokens: ['a', 'b'], path: 'x.md' }, score: 1.0 },
      { item: { tokens: ['a', 'b'], path: 'y.md' }, score: 0.9 },
      { item: { tokens: ['a', 'b'], path: 'z.md' }, score: 0.8 }
    ]);
    const out = applyMMR(input, { lambda: 0 });
    assert.equal(out.length, 3);
    out.forEach((e, i) => {
      assert.equal(e.penalized, false);
      assert.equal(e.mmrScore, input[i].score);
    });
  });
});

// ── #2 mmr_uniform_context_diversifies ───────────────────────────
describe('C-2 mmr_uniform_context_diversifies', () => {
  it('all-identical tokens → entries 2..N penalized', () => {
    const input = makeScored([
      { item: { tokens: ['x'], path: 'a.md' }, score: 1.0 },
      { item: { tokens: ['x'], path: 'b.md' }, score: 0.9 },
      { item: { tokens: ['x'], path: 'c.md' }, score: 0.8 },
      { item: { tokens: ['x'], path: 'd.md' }, score: 0.7 },
      { item: { tokens: ['x'], path: 'e.md' }, score: 0.6 }
    ]);
    const out = applyMMR(input, { lambda: 0.2, jaccardThreshold: 0.7 });
    // First entry never has prior selection → never penalized.
    const first = out.find((e) => e.item.path === 'a.md');
    assert.equal(first.penalized, false);
    // The rest see jaccard=1.0 with the first → all penalized.
    const others = out.filter((e) => e.item.path !== 'a.md');
    others.forEach((e) => assert.equal(e.penalized, true));
    // mmrScore = score * (1 - 0.2) = 0.8 * score
    others.forEach((e) => assert.ok(Math.abs(e.mmrScore - e.score * 0.8) < 1e-9));
  });
});

// ── #3 mmr_diverse_context_unchanged ─────────────────────────────
describe('C-3 mmr_diverse_context_unchanged', () => {
  it('all-different tokens → no penalties, mmrScore == score', () => {
    const input = makeScored([
      { item: { tokens: ['a'], path: 'p1' }, score: 1.0 },
      { item: { tokens: ['b'], path: 'p2' }, score: 0.9 },
      { item: { tokens: ['c'], path: 'p3' }, score: 0.8 }
    ]);
    const out = applyMMR(input, { lambda: 0.5, jaccardThreshold: 0.7 });
    out.forEach((e) => {
      assert.equal(e.penalized, false);
      assert.equal(e.mmrScore, e.score);
    });
  });
});

// ── #4 mmr_partial_overlap_penalized ─────────────────────────────
describe('C-4 mmr_partial_overlap_penalized', () => {
  it('only entries crossing the jaccard threshold are penalized', () => {
    // entry 1: tokens [a,b,c] — first, never penalized
    // entry 2: tokens [a,b,c] — jaccard 1.0 vs e1 → penalized
    // entry 3: tokens [d,e,f] — jaccard 0 vs both → not penalized
    // entry 4: tokens [a,b,c] — jaccard 1.0 vs e1 → penalized
    const input = makeScored([
      { item: { tokens: ['a','b','c'], path: 'p1' }, score: 1.0 },
      { item: { tokens: ['a','b','c'], path: 'p2' }, score: 0.9 },
      { item: { tokens: ['d','e','f'], path: 'p3' }, score: 0.8 },
      { item: { tokens: ['a','b','c'], path: 'p4' }, score: 0.7 }
    ]);
    const out = applyMMR(input, { lambda: 0.3, jaccardThreshold: 0.7 });
    const get = (p) => out.find((e) => e.item.path === p);
    assert.equal(get('p1').penalized, false);
    assert.equal(get('p2').penalized, true);
    assert.equal(get('p3').penalized, false);
    assert.equal(get('p4').penalized, true);
  });
});

// ── #5 mmr_lambda_clamped ────────────────────────────────────────
describe('C-5 mmr_lambda_clamped', () => {
  it('lambda < 0 clamps to 0 (disabled); lambda > 1 clamps to 1', () => {
    const input = makeScored([
      { item: { tokens: ['x'], path: 'a' }, score: 1.0 },
      { item: { tokens: ['x'], path: 'b' }, score: 0.5 }
    ]);
    const negOut = applyMMR(input, { lambda: -0.5 });
    // clamped to 0 → disabled → mmrScore == score
    assert.equal(negOut[0].mmrScore, 1.0);
    assert.equal(negOut[1].mmrScore, 0.5);

    const overOut = applyMMR(input, { lambda: 1.5, jaccardThreshold: 0.7 });
    // clamped to 1 → penalized.mmrScore = score * (1-1) = 0
    const second = overOut.find((e) => e.item.path === 'b');
    assert.equal(second.penalized, true);
    assert.equal(second.mmrScore, 0);
  });
});

// ── #6 gate_excluded_filtered_before_mmr ─────────────────────────
describe('C-6 gate_excluded_filtered_before_mmr', () => {
  it('caller filters -Infinity entries before applyMMR (input shape contract)', () => {
    // Simulate the documented call site: scored output of scoreItems has
    // -Infinity for gate-excluded entries; caller drops them with a filter
    // before invoking applyMMR.
    const scored = [
      { item: { tokens: ['x'] }, score: 1.0 },
      { item: { tokens: ['x'] }, score: -Infinity },
      { item: { tokens: ['x'] }, score: 0.5 },
      { item: { tokens: ['x'] }, score: -Infinity }
    ].map((entry, index) => ({ ...entry, index }));
    const filtered = scored.filter((s) => Number.isFinite(s.score));
    const out = applyMMR(filtered, { lambda: 0.2 });
    // Only 2 entries reach MMR.
    assert.equal(out.length, 2);
    out.forEach((e) => assert.ok(Number.isFinite(e.mmrScore)));
  });
});

// ── #7 order_preserved_when_no_penalty ───────────────────────────
describe('C-7 order_preserved_when_no_penalty', () => {
  it('descending score input + unique tokens → applyMMR preserves desc order', () => {
    const input = makeScored([
      { item: { tokens: ['a'], path: 'p1' }, score: 0.9 },
      { item: { tokens: ['b'], path: 'p2' }, score: 0.7 },
      { item: { tokens: ['c'], path: 'p3' }, score: 0.5 }
    ]);
    const out = applyMMR(input, { lambda: 0.3 });
    assert.deepEqual(out.map((e) => e.item.path), ['p1', 'p2', 'p3']);
  });
});

// ── #8 path_sort_alphabetic ──────────────────────────────────────
describe('C-8 path_sort_alphabetic', () => {
  it('emitSortByPath returns items in path asc order', () => {
    const out = emitSortByPath([
      { path: 'z.md' },
      { path: 'a.md' },
      { path: 'm.md' }
    ]);
    assert.deepEqual(out.map((i) => i.path), ['a.md', 'm.md', 'z.md']);
  });
});

// ── #9 path_sort_locale_independent ──────────────────────────────
describe('C-9 path_sort_locale_independent', () => {
  it('Korean/English mix sorts via ASCII compare, not locale', () => {
    const out = emitSortByPath([
      { path: 'b.md' },
      { path: '한.md' },
      { path: 'a.md' }
    ]);
    // ASCII: 'a' < 'b' < <Korean codepoints>
    assert.deepEqual(out.map((i) => i.path), ['a.md', 'b.md', '한.md']);
  });
});

// ── #10 path_sort_forward_slash_normalized ───────────────────────
describe('C-10 path_sort_forward_slash_normalized', () => {
  it('Windows backslash paths normalize before sorting', () => {
    const out = emitSortByPath([
      { path: 'src\\foo.mjs' },
      { path: 'src/bar.mjs' }
    ]);
    // After normalization "src/bar.mjs" < "src/foo.mjs"
    assert.equal(out[0].path, 'src/bar.mjs');
    assert.equal(out[1].path, 'src\\foo.mjs');
  });
});

// ── #11 mmr_then_emit_two_calls_consistent ───────────────────────
describe('C-11 mmr_then_emit_two_calls_consistent', () => {
  it('same chain run twice produces byte-equal stringification', () => {
    const input = makeScored([
      { item: { tokens: ['a'], path: 'z.md' }, score: 0.9 },
      { item: { tokens: ['b'], path: 'a.md' }, score: 0.8 }
    ]);
    const run = () => {
      const mmr = applyMMR(input, { lambda: 0.2, jaccardThreshold: 0.7 });
      const top = mmr.slice(0, 2).map((e) => e.item);
      return JSON.stringify(emitSortByPath(top));
    };
    assert.equal(run(), run());
  });
});

// ── #12 score_change_emit_order_stable_when_topn_same ────────────
describe('C-12 score_change_emit_order_stable_when_topn_same', () => {
  it('different scores but same N items selected → emit order identical', () => {
    const items = [
      { tokens: ['a'], path: 'p1.md' },
      { tokens: ['b'], path: 'p2.md' },
      { tokens: ['c'], path: 'p3.md' }
    ];
    const a = applyMMR(makeScored(items.map((it, i) => ({ item: it, score: 1.0 - i * 0.1 }))), { lambda: 0.2 });
    const b = applyMMR(makeScored(items.map((it, i) => ({ item: it, score: 0.5 - i * 0.05 }))), { lambda: 0.2 });
    const aPaths = emitSortByPath(a.slice(0, 3).map((e) => e.item)).map((i) => i.path);
    const bPaths = emitSortByPath(b.slice(0, 3).map((e) => e.item)).map((i) => i.path);
    assert.deepEqual(aPaths, bPaths);
  });
});

// ── #13 mmr_default_lambda_when_unset ────────────────────────────
describe('C-13 mmr_default_lambda_when_unset', () => {
  it('options.lambda undefined → DEFAULT_DIVERSITY_LAMBDA (0.2) applies', () => {
    assert.equal(DEFAULT_DIVERSITY_LAMBDA, 0.2);
    const input = makeScored([
      { item: { tokens: ['x'], path: 'a' }, score: 1.0 },
      { item: { tokens: ['x'], path: 'b' }, score: 1.0 }
    ]);
    const out = applyMMR(input);
    const second = out.find((e) => e.item.path === 'b');
    assert.equal(second.penalized, true);
    assert.ok(Math.abs(second.mmrScore - 0.8) < 1e-9);
  });
});

// ── #14 mmr_default_threshold_when_unset ─────────────────────────
describe('C-14 mmr_default_threshold_when_unset', () => {
  it('options.jaccardThreshold undefined → DEFAULT_DIVERSITY_JACCARD_THRESHOLD (0.7) applies', () => {
    assert.equal(DEFAULT_DIVERSITY_JACCARD_THRESHOLD, 0.7);
    // Build entries with jaccard exactly 2/3 ≈ 0.667 (below 0.7) — should NOT penalize.
    const input = makeScored([
      { item: { tokens: ['a','b','c'], path: 'p1' }, score: 1.0 },
      { item: { tokens: ['a','b','d'], path: 'p2' }, score: 0.9 }
    ]);
    const out = applyMMR(input, { lambda: 0.5 });
    const second = out.find((e) => e.item.path === 'p2');
    assert.equal(second.penalized, false);
  });
});
