import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  linkToLesson,
  listReflections,
  upsertReflection
} from '../reflective-store.mjs';
import { createFixtureProject } from './_fixture.mjs';

test('upsertReflection inserts and updates by id', (t) => {
  const fx = createFixtureProject();
  t.after(() => fx.cleanup());

  const ins = upsertReflection(fx.projectDir, {
    id: 'refl-1',
    related_task: 'T1',
    related_failures: ['evt-1'],
    confidence_of_fix: 'medium'
  });
  assert.equal(ins.created, true);

  const upd = upsertReflection(fx.projectDir, {
    id: 'refl-1',
    related_task: 'T1',
    related_failures: ['evt-1', 'evt-2'],
    confidence_of_fix: 'high'
  });
  assert.equal(upd.created, false);

  const all = listReflections(fx.projectDir, {});
  assert.equal(all.length, 1);
  assert.equal(all[0].confidence_of_fix, 'high');
  assert.equal(all[0].related_failures.length, 2);
});

test('linkToLesson pairs reflection with lesson and is idempotent', (t) => {
  const fx = createFixtureProject();
  t.after(() => fx.cleanup());

  upsertReflection(fx.projectDir, { id: 'refl-2', related_task: 'T2' });

  const r1 = linkToLesson(fx.projectDir, 'refl-2', 'lesson-99');
  assert.equal(r1.ok, true);
  assert.equal(r1.changed, true);

  const r2 = linkToLesson(fx.projectDir, 'refl-2', 'lesson-99');
  assert.equal(r2.ok, true);
  assert.equal(r2.changed, false);

  const stored = listReflections(fx.projectDir, { linkedLesson: 'lesson-99' });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].linked_lesson, 'lesson-99');
});

test('linkToLesson rejects missing reflection', (t) => {
  const fx = createFixtureProject();
  t.after(() => fx.cleanup());

  const r = linkToLesson(fx.projectDir, 'no-such-id', 'lesson-1');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_found');
});

test('listReflections filters by relatedTask and status', (t) => {
  const fx = createFixtureProject();
  t.after(() => fx.cleanup());

  upsertReflection(fx.projectDir, { id: 'r1', related_task: 'T1', status: 'draft' });
  upsertReflection(fx.projectDir, { id: 'r2', related_task: 'T2', status: 'active' });

  assert.equal(listReflections(fx.projectDir, { relatedTask: 'T1' }).length, 1);
  assert.equal(listReflections(fx.projectDir, { status: 'active' }).length, 1);
});
