// DESIGN_MANUS_B §10 — session-start "Related Past Failures" injection AC tests.
// Covers: B-1 zero_errors_omit, B-2 under_threshold_fallback, B-3 scored_with_gate,
//         B-4 all_fail_gate, B-5 linked_reflection_ref, B-10 injection_token_budget,
//         B-11 no_task_worklog_signal.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendJsonl,
  ensureRuntimeLayout,
  getRuntimePaths
} from '../../core/runtime-lib.mjs';
import {
  buildErrorInjectionBlock,
  collectSignalContext
} from '../session-start.mjs';

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-start-errors-'));
  ensureRuntimeLayout(dir);
  return dir;
}

function makeErrorRow(overrides = {}) {
  return {
    id: 'err-x',
    timestamp: '2026-05-01T00:00:00Z',
    taskId: 'task-A',
    tool: 'Edit',
    errorType: 'string-not-found',
    summary: 'string not found',
    filePath: 'src/foo.ts',
    scope: 'runtime',
    tokens: ['string', 'not', 'found', 'foo'],
    applicable_when: { scope_id: 'runtime' },
    recoveryAttempts: 0,
    resolved: false,
    linkedReflectionPath: null,
    importance: 5,
    last_accessed_at: '2026-05-01T00:00:00Z',
    ...overrides
  };
}

const NOW = new Date('2026-05-07T00:00:00Z');
const SCORED_CTX = {
  activeScopes: ['runtime'],
  candidatePaths: ['src/foo.ts'],
  signalTokens: ['foo']
};

// ── B-1 zero_errors_omit ─────────────────────────────────────────
describe('B-1 zero_errors_omit: empty errors → null block (omit)', () => {
  it('returns null', () => {
    assert.equal(buildErrorInjectionBlock([], SCORED_CTX, { now: NOW }), null);
  });
});

// ── B-2 under_threshold_fallback ─────────────────────────────────
describe('B-2 under_threshold_fallback: < 5 errors → time-based fallback w/ label', () => {
  it('headers fallback + sorts by timestamp desc', () => {
    const errors = [
      makeErrorRow({ id: 'err-1', timestamp: '2026-04-29T00:00:00Z', errorType: 'ENOENT' }),
      makeErrorRow({ id: 'err-2', timestamp: '2026-05-01T00:00:00Z', errorType: 'string-not-found' }),
      makeErrorRow({ id: 'err-3', timestamp: '2026-04-30T00:00:00Z', errorType: 'permission-denied' })
    ];
    const block = buildErrorInjectionBlock(errors, SCORED_CTX, { now: NOW });
    assert.ok(typeof block === 'string');
    assert.ok(block.startsWith('### Related Past Failures (fallback: time-based, errors < 5)'));
    const lines = block.split('\n').filter((l) => l.startsWith('- '));
    // first entry should be the most recent
    assert.ok(lines[0].includes('string-not-found'));
    assert.ok(lines[1].includes('permission-denied'));
    assert.ok(lines[2].includes('ENOENT'));
  });
});

// ── B-3 scored_with_gate ─────────────────────────────────────────
describe('B-3 scored_with_gate: gate filters mismatched scope, top-3 from passed', () => {
  it('keeps only scope=runtime errors', () => {
    const errors = [];
    for (let i = 0; i < 5; i += 1) {
      errors.push(makeErrorRow({
        id: `err-runtime-${i}`,
        scope: 'runtime',
        applicable_when: { scope_id: 'runtime' },
        recoveryAttempts: 3 - (i % 2) // varied importance
      }));
    }
    for (let i = 0; i < 5; i += 1) {
      errors.push(makeErrorRow({
        id: `err-other-${i}`,
        scope: 'other',
        applicable_when: { scope_id: 'other' }
      }));
    }
    const block = buildErrorInjectionBlock(errors, SCORED_CTX, { now: NOW });
    assert.ok(typeof block === 'string');
    assert.ok(block.startsWith('### Related Past Failures (avoid repeating)'));
    // Only runtime errors should appear in lines.
    assert.ok(!block.includes('err-other'));
    const itemLines = block.split('\n').filter((l) => l.startsWith('- '));
    assert.equal(itemLines.length, 3);
  });
});

// ── B-4 all_fail_gate ────────────────────────────────────────────
describe('B-4 all_fail_gate: all errors fail gate → block omitted', () => {
  it('returns null when no error passes gate', () => {
    const errors = [];
    for (let i = 0; i < 6; i += 1) {
      errors.push(makeErrorRow({
        id: `err-${i}`,
        scope: 'foo',
        applicable_when: { scope_id: 'foo' }
      }));
    }
    const block = buildErrorInjectionBlock(errors, SCORED_CTX, { now: NOW });
    assert.equal(block, null);
  });
});

// ── B-5 linked_reflection_ref ────────────────────────────────────
describe('B-5 linked_reflection_ref: linked reflection appears as → 참조 line', () => {
  it('emits the reflection reference line', () => {
    const errors = [];
    // need >= 5 to use scored mode. Pad rows have low importance + no token overlap.
    for (let i = 0; i < 4; i += 1) {
      errors.push(makeErrorRow({
        id: `err-pad-${i}`,
        importance: 1,
        tokens: ['unrelated'],
        last_accessed_at: '2025-01-01T00:00:00Z' // very old → low recency
      }));
    }
    errors.push(makeErrorRow({
      id: 'err-linked',
      importance: 10,
      linkedReflectionPath: '08_Reflections/2026-04-foo.md',
      resolved: true,
      tokens: ['foo', 'string', 'not', 'found'],
      last_accessed_at: '2026-05-06T00:00:00Z'
    }));
    const block = buildErrorInjectionBlock(errors, SCORED_CTX, { now: NOW });
    assert.ok(typeof block === 'string', 'block should be a string');
    assert.ok(
      block.includes('→ 참조: 08_Reflections/2026-04-foo.md'),
      `expected reflection ref in:\n${block}`
    );
  });
});

// ── B-10 injection_token_budget ──────────────────────────────────
describe('B-10 injection_token_budget: 3 errors stay under ~200 tokens', () => {
  it('output is small', () => {
    const errors = [
      makeErrorRow({ id: 'e1', recoveryAttempts: 3, errorType: 'string-not-found' }),
      makeErrorRow({ id: 'e2', recoveryAttempts: 2, errorType: 'ENOENT', filePath: 'C:/long/path/to/file.ts' }),
      makeErrorRow({ id: 'e3', recoveryAttempts: 1, errorType: 'permission-denied' }),
      makeErrorRow({ id: 'e4' }),
      makeErrorRow({ id: 'e5' })
    ];
    const block = buildErrorInjectionBlock(errors, SCORED_CTX, { now: NOW });
    assert.ok(typeof block === 'string');
    // Rough char→token estimate: ~4 chars per token. Cap budget at 200 tokens => 800 chars.
    assert.ok(block.length < 800, `block too long: ${block.length} chars`);
  });
});

// ── B-11 no_task_worklog_signal ──────────────────────────────────
describe('B-11 no_task_worklog_signal: currentTask=null + worklog summary → tokens from summary', () => {
  it('uses worklog summary tokens, defaultScope, empty candidatePaths', () => {
    const ctx = collectSignalContext(
      null,
      { summary: 'Auth refresh token rotation hook failure' },
      { defaultScope: 'runtime' }
    );
    assert.deepEqual(ctx.activeScopes, ['runtime']);
    assert.deepEqual(ctx.candidatePaths, []);
    assert.ok(ctx.signalTokens.includes('auth') || ctx.signalTokens.includes('refresh'));
  });
});

// ── ancillary: end-to-end via errors.jsonl ───────────────────────
describe('end-to-end: errors.jsonl seeded → buildErrorInjectionBlock loads via filesystem', () => {
  it('reads through loadErrors transparently (smoke)', () => {
    const projectDir = makeProject();
    const file = path.join(getRuntimePaths(projectDir).knowledgeRoot, 'errors.jsonl');
    appendJsonl(file, makeErrorRow({ id: 'err-fs', timestamp: '2026-05-06T00:00:00Z' }));
    appendJsonl(file, makeErrorRow({ id: 'err-fs2', timestamp: '2026-05-05T00:00:00Z' }));
    appendJsonl(file, makeErrorRow({ id: 'err-fs3', timestamp: '2026-05-04T00:00:00Z' }));
    // Below threshold (3 < 5) → fallback mode
    // We import loadErrors lazily here
    return import('../../core/error-indexer.mjs').then(({ loadErrors }) => {
      const errors = loadErrors(projectDir);
      assert.equal(errors.length, 3);
      const block = buildErrorInjectionBlock(errors, SCORED_CTX, { now: NOW });
      assert.ok(typeof block === 'string');
      assert.ok(block.startsWith('### Related Past Failures (fallback'));
    });
  });
});
