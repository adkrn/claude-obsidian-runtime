import { test } from 'node:test';
import assert from 'node:assert/strict';
import { append, query } from '../episodic-store.mjs';
import { createFixtureProject } from './_fixture.mjs';

test('append + query round-trips a single event', (t) => {
  const fx = createFixtureProject();
  t.after(() => fx.cleanup());

  append(fx.projectDir, {
    eventType: 'file_modified',
    scope: 'backend',
    toolName: 'Edit',
    filePath: 'backend/src/foo.ts',
    taskId: 'T1',
    sessionId: 'S1',
    ts: '2026-04-23T00:00:00.000Z'
  });

  const events = query(fx.projectDir, {});
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'file_modified');
  assert.equal(events[0].scope, 'backend');
});

test('query filters by scope and eventType', (t) => {
  const fx = createFixtureProject();
  t.after(() => fx.cleanup());

  append(fx.projectDir, { eventType: 'file_modified', scope: 'backend', taskId: 'T1', ts: '2026-04-23T00:00:00.000Z' });
  append(fx.projectDir, { eventType: 'file_read', scope: 'backend', taskId: 'T1', ts: '2026-04-23T00:01:00.000Z' });
  append(fx.projectDir, { eventType: 'file_modified', scope: 'frontend', taskId: 'T1', ts: '2026-04-23T00:02:00.000Z' });

  const backendOnly = query(fx.projectDir, { scope: 'backend' });
  assert.equal(backendOnly.length, 2);

  const reads = query(fx.projectDir, { eventType: 'file_read' });
  assert.equal(reads.length, 1);
  assert.equal(reads[0].scope, 'backend');

  const eitherType = query(fx.projectDir, { eventType: ['file_read', 'file_modified'], scope: 'backend' });
  assert.equal(eitherType.length, 2);
});

test('query honors sinceIso and limit', (t) => {
  const fx = createFixtureProject();
  t.after(() => fx.cleanup());

  for (let i = 0; i < 5; i += 1) {
    append(fx.projectDir, {
      eventType: 'verification_run',
      scope: 'workflow',
      taskId: 'T2',
      ts: `2026-04-23T00:0${i}:00.000Z`
    });
  }

  const since = query(fx.projectDir, { sinceIso: '2026-04-23T00:03:00.000Z' });
  assert.equal(since.length, 2);

  const limited = query(fx.projectDir, { limit: 3 });
  assert.equal(limited.length, 3);
  assert.equal(limited[0].ts, '2026-04-23T00:02:00.000Z');
});

test('append uses current timestamp when ts missing', (t) => {
  const fx = createFixtureProject();
  t.after(() => fx.cleanup());

  const result = append(fx.projectDir, { eventType: 'tool_failed', scope: 'repo' });
  assert.ok(result.ts);
  assert.ok(Number.isFinite(Date.parse(result.ts)));
  const events = query(fx.projectDir, {});
  assert.equal(events.length, 1);
});
