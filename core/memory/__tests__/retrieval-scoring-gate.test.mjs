// DESIGN_MANUS_F §8 — applicable_when retrieval gate AC tests (12 cases).
// Each test covers one row of the §8 input/expected table.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateGate,
  globMatch,
  scoreItem
} from '../retrieval-scoring.mjs';

// ── 1. empty_passes ──────────────────────────────────────────────
test('F-1 empty_passes: applicable_when undefined → passed=true', () => {
  const item = { applicable_when: undefined };
  const result = evaluateGate(item, {});
  assert.equal(result.passed, true);
  assert.deepEqual(result.evaluated, []);
  assert.deepEqual(result.failedGates, []);
});

// ── 2. legacy_string_passes ──────────────────────────────────────
test('F-2 legacy_string_passes: legacy non-empty string → passed=true + legacyString flag', () => {
  const item = { applicable_when: 'talkup-runtime / hook' };
  const result = evaluateGate(item, {});
  assert.equal(result.passed, true);
  assert.deepEqual(result.evaluated, []);
  assert.deepEqual(result.failedGates, []);
  assert.equal(result.legacyString, true);
});

// ── 3. path_glob_match ───────────────────────────────────────────
test('F-3 path_glob_match: pattern matches at least one candidate → passed', () => {
  const item = { applicable_when: { path_glob: ['src/hooks/**'] } };
  const ctx = { candidatePaths: ['src/hooks/post.mjs'] };
  const result = evaluateGate(item, ctx);
  assert.equal(result.passed, true);
  assert.deepEqual(result.evaluated, ['path_glob']);
  assert.deepEqual(result.failedGates, []);
});

// ── 4. path_glob_no_match ────────────────────────────────────────
test('F-4 path_glob_no_match: no candidate matches → failed', () => {
  const item = { applicable_when: { path_glob: ['src/hooks/**'] } };
  const ctx = { candidatePaths: ['src/utils/x.mjs'] };
  const result = evaluateGate(item, ctx);
  assert.equal(result.passed, false);
  assert.deepEqual(result.evaluated, ['path_glob']);
  assert.deepEqual(result.failedGates, ['path_glob']);
});

// ── 5. trigger_keywords_overlap ──────────────────────────────────
test('F-5 trigger_keywords_overlap: at least 1 token overlap → passed', () => {
  const item = {
    applicable_when: { trigger_keywords: ['hook', 'session-start'] }
  };
  const ctx = { signalTokens: ['session-start', 'init'] };
  const result = evaluateGate(item, ctx);
  assert.equal(result.passed, true);
  assert.deepEqual(result.evaluated, ['trigger_keywords']);
  assert.deepEqual(result.failedGates, []);
});

// ── 6. trigger_keywords_no_overlap ───────────────────────────────
test('F-6 trigger_keywords_no_overlap: zero overlap → failed', () => {
  const item = {
    applicable_when: { trigger_keywords: ['hook', 'session-start'] }
  };
  const ctx = { signalTokens: ['backend'] };
  const result = evaluateGate(item, ctx);
  assert.equal(result.passed, false);
  assert.deepEqual(result.evaluated, ['trigger_keywords']);
  assert.deepEqual(result.failedGates, ['trigger_keywords']);
});

// ── 7. scope_id_match_string ─────────────────────────────────────
test('F-7 scope_id_match_string: scope_id (string) ∈ activeScopes → passed', () => {
  const item = { applicable_when: { scope_id: 'talkup-runtime' } };
  const ctx = { activeScopes: ['talkup-runtime', 'vault'] };
  const result = evaluateGate(item, ctx);
  assert.equal(result.passed, true);
  assert.deepEqual(result.evaluated, ['scope_id']);
  assert.deepEqual(result.failedGates, []);
});

// ── 8. scope_id_no_match_array ───────────────────────────────────
test('F-8 scope_id_no_match_array: scope_id (string[]) no intersection → failed', () => {
  const item = { applicable_when: { scope_id: ['foo', 'bar'] } };
  const ctx = { activeScopes: ['baz'] };
  const result = evaluateGate(item, ctx);
  assert.equal(result.passed, false);
  assert.deepEqual(result.evaluated, ['scope_id']);
  assert.deepEqual(result.failedGates, ['scope_id']);
});

// ── 8b. empty-signal → gate can't evaluate → SKIP (pass) ─────────
// Bug: when the ctx-side signal is empty (no scope/path/keyword info from the
// caller), the gate must SKIP — "can't evaluate" ≠ "no match". Otherwise every
// scoped lesson dies on callers that don't resolve scopes (e.g. matchedScopes=[]).
test('F-8b scope_id: empty activeScopes → SKIP scope_id gate (pass, not evaluated)', () => {
  const item = { applicable_when: { scope_id: 'musicGame' } };
  const result = evaluateGate(item, { activeScopes: [] });
  assert.equal(result.passed, true);
  assert.deepEqual(result.evaluated, []);        // gate was skipped, not evaluated
  assert.deepEqual(result.failedGates, []);
});

test('F-8c scope_id: missing activeScopes entirely → SKIP (pass)', () => {
  const item = { applicable_when: { scope_id: ['musicGame', 'repo'] } };
  const result = evaluateGate(item, {});
  assert.equal(result.passed, true);
  assert.deepEqual(result.failedGates, []);
});

test('F-8d path_glob: empty candidatePaths → SKIP path_glob gate (pass)', () => {
  const item = { applicable_when: { path_glob: ['src/**'] } };
  const result = evaluateGate(item, { candidatePaths: [] });
  assert.equal(result.passed, true);
  assert.deepEqual(result.evaluated, []);
});

test('F-8e trigger_keywords: empty signalTokens → SKIP tk gate (pass)', () => {
  const item = { applicable_when: { trigger_keywords: ['hook'] } };
  const result = evaluateGate(item, { signalTokens: [] });
  assert.equal(result.passed, true);
  assert.deepEqual(result.evaluated, []);
});

// ── 9. all_gates_AND_pass ────────────────────────────────────────
test('F-9 all_gates_AND_pass: 3 gates all match → passed, evaluated has 3', () => {
  const item = {
    applicable_when: {
      path_glob: ['src/hooks/**'],
      trigger_keywords: ['hook'],
      scope_id: ['runtime']
    }
  };
  const ctx = {
    candidatePaths: ['src/hooks/post.mjs'],
    signalTokens: ['hook', 'init'],
    activeScopes: ['runtime']
  };
  const result = evaluateGate(item, ctx);
  assert.equal(result.passed, true);
  assert.deepEqual(result.evaluated, ['path_glob', 'trigger_keywords', 'scope_id']);
  assert.deepEqual(result.failedGates, []);
});

// ── 10. all_gates_AND_one_fail ───────────────────────────────────
test('F-10 all_gates_AND_one_fail: trigger_keywords miss → passed=false', () => {
  const item = {
    applicable_when: {
      path_glob: ['src/hooks/**'],
      trigger_keywords: ['hook'],
      scope_id: ['runtime']
    }
  };
  const ctx = {
    candidatePaths: ['src/hooks/post.mjs'],
    signalTokens: ['unrelated'],
    activeScopes: ['runtime']
  };
  const result = evaluateGate(item, ctx);
  assert.equal(result.passed, false);
  assert.deepEqual(result.failedGates, ['trigger_keywords']);
  assert.deepEqual(
    result.evaluated.sort(),
    ['path_glob', 'scope_id', 'trigger_keywords']
  );
});

// ── 11. scoreItem_exclude ────────────────────────────────────────
test('F-11 scoreItem_exclude: gate fail + default gateMode → -Infinity', () => {
  const now = new Date('2026-05-07T00:00:00Z');
  const item = {
    importance: 9,
    last_accessed_at: now.toISOString(),
    tokens: ['a'],
    applicable_when: { scope_id: 'unmatched' }
  };
  const score = scoreItem(item, {
    promptTokens: ['a'],
    activeScopes: ['other'],
    now
  });
  assert.equal(score, -Infinity);
});

// ── 12. scoreItem_penalty ────────────────────────────────────────
test('F-12 scoreItem_penalty: gate fail + gateMode=penalty → rawScore * 0.1', () => {
  const now = new Date('2026-05-07T00:00:00Z');
  const item = {
    importance: 9,
    last_accessed_at: now.toISOString(),
    tokens: ['a'],
    applicable_when: { scope_id: 'unmatched' }
  };
  // raw = 1*1 (recency now) + 1*(9/10) (importance) + 1.5*1.0 (jaccard ['a']∩['a']=1)
  //     = 1 + 0.9 + 1.5 = 3.4
  const raw = 1 + 0.9 + 1.5;
  const score = scoreItem(item, {
    promptTokens: ['a'],
    activeScopes: ['other'],
    gateMode: 'penalty',
    gatePenalty: 0.1,
    now
  });
  assert.ok(Math.abs(score - raw * 0.1) < 1e-9, `expected ~${raw * 0.1}, got ${score}`);
});

// ── globMatch sanity (ancillary) ─────────────────────────────────
test('globMatch supports **, *, ? subset', () => {
  assert.equal(globMatch('src/**', 'src/hooks/post.mjs'), true);
  assert.equal(globMatch('src/*.mjs', 'src/hooks/post.mjs'), false);
  assert.equal(globMatch('src/*.mjs', 'src/post.mjs'), true);
  assert.equal(globMatch('src/?.mjs', 'src/a.mjs'), true);
  assert.equal(globMatch('src/?.mjs', 'src/ab.mjs'), false);
  assert.equal(globMatch('a/**/c', 'a/b/c'), true);
  assert.equal(globMatch('a/**/c', 'a/b/d/c'), true);
});
