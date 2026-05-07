// DESIGN_MANUS_B §10 — error-indexer AC tests (subset run here; remaining
// session-start integration cases live in commands/__tests__/session-start-errors.test.mjs).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendJsonl,
  ensureRuntimeLayout,
  getRuntimePaths
} from '../runtime-lib.mjs';
import {
  autofillApplicableWhen,
  computeErrorImportance,
  indexErrorEvent,
  linkReflection,
  loadErrors,
  markResolved
} from '../error-indexer.mjs';

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'error-indexer-'));
  ensureRuntimeLayout(dir);
  return dir;
}

function errorsFile(projectDir) {
  return path.join(getRuntimePaths(projectDir).knowledgeRoot, 'errors.jsonl');
}

// ── B-6 high_importance ─────────────────────────────────────────
describe('B-6 high_importance: 3 attempts + unresolved + no link → importance=9', () => {
  it('matches §9-B formula', () => {
    const importance = computeErrorImportance({
      recoveryAttempts: 3,
      resolved: false,
      linkedReflectionPath: null
    });
    // base 3 + min(3*1.5, 4.5)=4.5 + 1.5 (unresolved) = 9
    assert.equal(importance, 9);
  });
});

// ── B-7 max_importance_cap ──────────────────────────────────────
describe('B-7 max_importance_cap: linked reflection bonus caps at 10', () => {
  it('caps at 10', () => {
    const importance = computeErrorImportance({
      recoveryAttempts: 3,
      resolved: false,
      linkedReflectionPath: '08_Reflections/2026-04.md'
    });
    // 3 + 4.5 + 1.5 + 1 = 10 (cap)
    assert.equal(importance, 10);
  });
});

// ── B-8 scope_no_post_hoc ───────────────────────────────────────
describe('B-8 scope_no_post_hoc: missing event.scope + non-matching task → null', () => {
  it('refuses to fill scope from a different task pointer', () => {
    const projectDir = makeProject();
    const event = {
      eventId: 'evt-1',
      ts: '2026-05-01T10:00:00Z',
      taskId: 'task-A',
      toolName: 'Edit',
      outcome: 'fail',
      detail: { errorType: 'string-not-found', filePath: 'src/foo.ts', message: 'not found' }
      // scope intentionally omitted
    };
    const res = indexErrorEvent(projectDir, event, {
      currentTaskPointer: { taskId: 'task-OTHER', matchedScopes: ['runtime'] }
    });
    assert.equal(res.ok, true);
    const errors = loadErrors(projectDir);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].scope, null);
  });
});

// ── B-9 resolved_sentinel ───────────────────────────────────────
describe('B-9 resolved_sentinel: append-only, importance recomputed on rollup', () => {
  it('keeps base row intact and recomputes importance', () => {
    const projectDir = makeProject();
    const event = {
      eventId: 'evt-9',
      ts: '2026-05-01T10:00:00Z',
      taskId: 'task-A',
      scope: 'runtime',
      toolName: 'Edit',
      outcome: 'fail',
      detail: { errorType: 'string-not-found', filePath: 'src/x.ts', message: 'no', recovery_attempts: 3 }
    };
    indexErrorEvent(projectDir, event);
    let errors = loadErrors(projectDir);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].importance, 9); // 3 + 4.5 + 1.5

    const ack = markResolved(projectDir, errors[0].id, {
      ts: '2026-05-02T10:00:00Z',
      taskId: 'task-A'
    });
    assert.equal(ack.ok, true);

    // Verify file has 2 rows (append-only, base unchanged).
    const raw = fs.readFileSync(errorsFile(projectDir), 'utf8').trim().split('\n');
    assert.equal(raw.length, 2);
    const baseRow = JSON.parse(raw[0]);
    assert.equal(baseRow.resolved, false);     // base row not mutated
    assert.equal(baseRow.importance, 9);

    // Rollup state: resolved=true, importance recomputed (3 + 4.5 = 7.5 → round 8)
    errors = loadErrors(projectDir);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].resolved, true);
    assert.equal(errors[0].importance, 8);
  });
});

// ── autofillApplicableWhen sanity (B §6-C) ──────────────────────
describe('autofillApplicableWhen mapping (§6-C)', () => {
  it('builds object with path_glob/trigger_keywords/scope_id from event', () => {
    const aw = autofillApplicableWhen({
      eventId: 'e1',
      scope: 'runtime',
      toolName: 'Edit',
      detail: { errorType: 'string-not-found', filePath: 'src/foo/bar.ts' }
    });
    assert.deepEqual(aw.path_glob, ['src/foo/**']);
    assert.equal(aw.scope_id, 'runtime');
    // trigger_keywords contains tokens from errorType + toolName.
    assert.ok(aw.trigger_keywords.length > 0);
    assert.ok(aw.trigger_keywords.includes('string') || aw.trigger_keywords.includes('found') || aw.trigger_keywords.includes('not'));
  });

  it('returns null when event has no usable fields', () => {
    const aw = autofillApplicableWhen({});
    assert.equal(aw, null);
  });
});

// ── linkReflection sentinel ─────────────────────────────────────
describe('linkReflection appends sentinel and rollup picks it up', () => {
  it('rolls up linkedReflectionPath', () => {
    const projectDir = makeProject();
    indexErrorEvent(projectDir, {
      eventId: 'evt-link',
      ts: '2026-05-01T00:00:00Z',
      taskId: 'task-A',
      scope: 'runtime',
      toolName: 'Edit',
      outcome: 'fail',
      detail: { errorType: 'ENOENT', filePath: 'src/y.ts', message: 'missing' }
    });
    const before = loadErrors(projectDir);
    assert.equal(before.length, 1);
    const id = before[0].id;
    linkReflection(projectDir, id, '08_Reflections/2026-05.md');
    const after = loadErrors(projectDir);
    assert.equal(after[0].linkedReflectionPath, '08_Reflections/2026-05.md');
  });
});

// ── indexErrorEvent rejects non-fail events ─────────────────────
describe('indexErrorEvent rejects non-fail events', () => {
  it('returns ok:false reason:not_fail_event', () => {
    const projectDir = makeProject();
    const res = indexErrorEvent(projectDir, {
      eventId: 'success-1',
      ts: '2026-05-01T00:00:00Z',
      outcome: 'success',
      toolName: 'Edit',
      detail: {}
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'not_fail_event');
  });
});

// ── loadErrors windowDays filter ────────────────────────────────
describe('loadErrors windowDays filter drops old rows', () => {
  it('drops rows older than window', () => {
    const projectDir = makeProject();
    const file = errorsFile(projectDir);
    appendJsonl(file, {
      id: 'err-old',
      timestamp: '2025-01-01T00:00:00Z',
      taskId: null,
      tool: 'Edit',
      errorType: 'x',
      summary: 'old',
      filePath: null,
      scope: null,
      tokens: [],
      applicable_when: null,
      recoveryAttempts: 0,
      resolved: false,
      linkedReflectionPath: null,
      importance: 5,
      last_accessed_at: '2025-01-01T00:00:00Z'
    });
    appendJsonl(file, {
      id: 'err-new',
      timestamp: '2026-05-06T00:00:00Z',
      taskId: null,
      tool: 'Edit',
      errorType: 'x',
      summary: 'new',
      filePath: null,
      scope: null,
      tokens: [],
      applicable_when: null,
      recoveryAttempts: 0,
      resolved: false,
      linkedReflectionPath: null,
      importance: 5,
      last_accessed_at: '2026-05-06T00:00:00Z'
    });
    const filtered = loadErrors(projectDir, {
      windowDays: 30,
      now: Date.parse('2026-05-07T00:00:00Z')
    });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, 'err-new');
  });
});
