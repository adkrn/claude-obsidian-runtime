import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  listProcedures,
  recordProcedureUse,
  upsertProcedure
} from '../procedural-store.mjs';
import { createFixtureProject } from './_fixture.mjs';

test('upsertProcedure inserts and updates by id', (t) => {
  const fx = createFixtureProject();
  t.after(() => fx.cleanup());

  upsertProcedure(fx.projectDir, {
    id: 'proc-1',
    title: 'create endpoint',
    scope: 'backend',
    pattern_signature: 'new_api_endpoint',
    distilled_from_tasks: ['T1', 'T2', 'T3']
  });
  upsertProcedure(fx.projectDir, {
    id: 'proc-1',
    title: 'updated',
    scope: 'backend',
    pattern_signature: 'new_api_endpoint',
    distilled_from_tasks: ['T1', 'T2', 'T3', 'T4']
  });

  const all = listProcedures(fx.projectDir, {});
  assert.equal(all.length, 1);
  assert.equal(all[0].title, 'updated');
  assert.equal(all[0].distilled_from_tasks.length, 4);
});

test('listProcedures filters by scope and pattern', (t) => {
  const fx = createFixtureProject();
  t.after(() => fx.cleanup());

  upsertProcedure(fx.projectDir, { id: 'p-be', scope: 'backend', pattern_signature: 'a' });
  upsertProcedure(fx.projectDir, { id: 'p-fe', scope: 'frontend', pattern_signature: 'b' });

  assert.equal(listProcedures(fx.projectDir, { scope: 'backend' }).length, 1);
  assert.equal(listProcedures(fx.projectDir, { pattern: 'b' }).length, 1);
  assert.equal(listProcedures(fx.projectDir, { scope: 'workflow' }).length, 0);
});

test('recordProcedureUse increments access_count', (t) => {
  const fx = createFixtureProject();
  t.after(() => fx.cleanup());

  upsertProcedure(fx.projectDir, { id: 'proc-x', scope: 'workflow', pattern_signature: 'sig' });
  const result = recordProcedureUse(fx.projectDir, 'proc-x', '2026-04-23T00:00:00.000Z');
  assert.equal(result.ok, true);
  assert.equal(result.access_count, 1);
  const after = listProcedures(fx.projectDir, { pattern: 'sig' })[0];
  assert.equal(after.access_count, 1);
  assert.equal(after.last_accessed_at, '2026-04-23T00:00:00.000Z');

  const missing = recordProcedureUse(fx.projectDir, 'nope');
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'not_found');
});
