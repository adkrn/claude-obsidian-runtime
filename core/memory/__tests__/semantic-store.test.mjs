import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendLessonRow,
  computeImportance,
  findLesson,
  listLessons,
  touchAccess,
  upsertLesson
} from '../semantic-store.mjs';
import { createFixtureProject } from './_fixture.mjs';

test('computeImportance maps confidence -> 1..10', () => {
  assert.equal(computeImportance({ confidence: 'high' }), 9);
  assert.equal(computeImportance({ confidence: 'medium' }), 6);
  assert.equal(computeImportance({ confidence: 'low' }), 3);
  assert.equal(computeImportance({}), 6);
  assert.equal(computeImportance({ importance: 7 }), 7);
  assert.equal(computeImportance({ importance: 99 }), 6); // out of range -> fallback
});

test('upsertLesson inserts then updates same id', (t) => {
  const fx = createFixtureProject();
  t.after(() => fx.cleanup());

  upsertLesson(fx.projectDir, {
    id: 'lesson-001',
    title: 'first',
    summary: 's',
    confidence: 'high',
    tokens: ['a', 'b'],
    related_task: 'T1'
  });
  upsertLesson(fx.projectDir, {
    id: 'lesson-001',
    title: 'first updated',
    summary: 's2',
    confidence: 'high',
    tokens: ['a', 'b']
  });

  const all = listLessons(fx.projectDir);
  assert.equal(all.length, 1);
  const found = findLesson(fx.projectDir, 'lesson-001');
  assert.equal(found.title, 'first updated');
  assert.equal(found.importance, 9);
});

test('upsertLesson triggers A-Mem evolution on neighbors', (t) => {
  const fx = createFixtureProject();
  t.after(() => fx.cleanup());

  upsertLesson(fx.projectDir, {
    id: 'lesson-old',
    title: 'old',
    summary: 's',
    confidence: 'medium',
    tokens: ['hook', 'capture', 'event']
  });

  const result = upsertLesson(fx.projectDir, {
    id: 'lesson-new',
    title: 'new',
    summary: 's',
    confidence: 'medium',
    tokens: ['hook', 'capture', 'event']
  });

  assert.equal(result.evolved.length, 1);
  assert.equal(result.evolved[0].lessonId, 'lesson-old');

  const old = findLesson(fx.projectDir, 'lesson-old');
  assert.equal(old.evolved_at.length, 1);
  assert.equal(old.evolved_at[0].from_lesson, 'lesson-new');
});

test('touchAccess increments access_count and bumps last_accessed_at', (t) => {
  const fx = createFixtureProject();
  t.after(() => fx.cleanup());

  upsertLesson(fx.projectDir, {
    id: 'L1',
    title: 'x',
    summary: 's',
    confidence: 'low',
    tokens: ['a'],
    last_accessed_at: '2026-01-01T00:00:00.000Z',
    access_count: 0
  });

  const r = touchAccess(fx.projectDir, 'L1', '2026-04-23T00:00:00.000Z');
  assert.equal(r.ok, true);
  assert.equal(r.access_count, 1);
  const found = findLesson(fx.projectDir, 'L1');
  assert.equal(found.last_accessed_at, '2026-04-23T00:00:00.000Z');
  assert.equal(found.access_count, 1);

  const r2 = touchAccess(fx.projectDir, 'missing');
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'not_found');
});

test('appendLessonRow writes raw row without merge', (t) => {
  const fx = createFixtureProject();
  t.after(() => fx.cleanup());

  appendLessonRow(fx.projectDir, { id: 'A', title: 't1', confidence: 'high', tokens: [] });
  appendLessonRow(fx.projectDir, { id: 'A', title: 't2', confidence: 'high', tokens: [] });
  const rows = listLessons(fx.projectDir);
  assert.equal(rows.length, 2);
});
