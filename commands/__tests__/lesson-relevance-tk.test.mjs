import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildLessonReadFirst } from '../task-start.mjs';

// Phase A (G1) — trigger_keywords must influence the live ranking path
// (buildLessonReadFirst), not just the applicable_when gate.

function makeProject(lessons) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-tk-'));
  const kDir = path.join(dir, '.claude', 'runtime', 'knowledge');
  fs.mkdirSync(kDir, { recursive: true });
  fs.writeFileSync(
    path.join(kDir, 'lessons.jsonl'),
    lessons.map((l) => JSON.stringify(l)).join('\n') + '\n',
    'utf8'
  );
  return dir;
}

const NOW = new Date('2026-06-26T00:00:00Z');

function baseLesson(id, extra = {}) {
  return {
    id,
    kind: 'lesson',
    scope: 'repo',
    title: id,
    summary: '',
    rules: ['some rule'],
    tokens: ['scene', 'transition'], // identical token base for both
    path: `08_Lessons/${id}.md`,
    sourceDoc: `08_Lessons/${id}.md`,
    last_accessed_at: NOW.toISOString(),
    importance: 5,
    ...extra
  };
}

test('buildLessonReadFirst: trigger_keywords lift a lesson above an equal-token peer', () => {
  // Two lessons with IDENTICAL tokens (same jaccard vs prompt). Only "withTk"
  // carries trigger_keywords matching the prompt. With topN=1 the higher-scored
  // lesson is the only survivor — proving tk changed the ranking.
  const withTk = baseLesson('with-tk', { trigger_keywords: ['fade', 'shader'] });
  const noTk = baseLesson('no-tk');
  const dir = makeProject([noTk, withTk]); // order: noTk first to defeat tie-by-index

  const result = buildLessonReadFirst({
    projectDir: dir,
    promptTokens: ['scene', 'transition', 'fade', 'shader'],
    matchedScopes: ['repo'],
    candidatePaths: [],
    manifest: null,
    contextRoot: '',
    topN: 1,
    now: NOW
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].lessonId, 'with-tk');
});

test('buildLessonReadFirst: W_TK=0 override neutralizes trigger_keywords', () => {
  // With W_TK forced to 0, the two equal-token lessons tie on relevance and the
  // tk lesson no longer wins purely on tk. Stable tie → original index order,
  // so the first-listed (no-tk) survives topN=1.
  const withTk = baseLesson('with-tk', { trigger_keywords: ['fade', 'shader'] });
  const noTk = baseLesson('no-tk');
  const dir = makeProject([noTk, withTk]);

  const result = buildLessonReadFirst({
    projectDir: dir,
    promptTokens: ['scene', 'transition', 'fade', 'shader'],
    matchedScopes: ['repo'],
    candidatePaths: [],
    manifest: { retrievalWeights: { triggerKeywordWeight: 0 } },
    contextRoot: '',
    topN: 1,
    now: NOW
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].lessonId, 'no-tk');
});

test('buildLessonReadFirst: char-trigram lifts a spacing-variant lesson (G3)', () => {
  // Prompt "씬전환" tokenizes differently from a lesson titled "씬 전환", so token
  // overlap is weak. The char-trigram aux term (fed via promptText) should let the
  // spacing-variant lesson win topN=1 over an unrelated peer.
  const variant = {
    ...baseLesson('variant'),
    title: '씬 전환 처리',
    summary: '씬 전환',
    tokens: ['처리'],
    path: '08_Lessons/variant.md',
    sourceDoc: '08_Lessons/variant.md'
  };
  const unrelated = {
    ...baseLesson('unrelated'),
    title: 'audio mixer',
    summary: 'volume fade',
    tokens: ['audio', 'mixer'],
    path: '08_Lessons/unrelated.md',
    sourceDoc: '08_Lessons/unrelated.md'
  };
  const dir = makeProject([unrelated, variant]);

  const result = buildLessonReadFirst({
    projectDir: dir,
    promptTokens: ['씬전환'],
    promptText: '씬전환 구현',
    matchedScopes: ['repo'],
    candidatePaths: [],
    manifest: null,
    contextRoot: '',
    topN: 1,
    now: NOW
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].lessonId, 'variant');
});

test('buildLessonReadFirst: lessons without trigger_keywords still work (graceful)', () => {
  // No trigger_keywords anywhere → behaves like the old jaccard path, no crash.
  const a = baseLesson('a');
  const b = baseLesson('b', { tokens: ['unrelated'] });
  const dir = makeProject([a, b]);

  const result = buildLessonReadFirst({
    projectDir: dir,
    promptTokens: ['scene', 'transition'],
    matchedScopes: ['repo'],
    candidatePaths: [],
    manifest: null,
    contextRoot: '',
    topN: 2,
    now: NOW
  });

  // 'a' (jaccard 1.0) must outrank 'b' (jaccard 0). Both returned; check 'a' present.
  const ids = result.map((r) => r.lessonId);
  assert.ok(ids.includes('a'));
});
