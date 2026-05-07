// DESIGN_MANUS_D §8 — buildAdditionalContext prefix-stability AC tests (14 cases).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildAdditionalContext,
  buildLastObservationLine,
  computeRuntimeHomeHash,
  buildRuntimeSessionStartContext
} from '../session-start.mjs';
import { stableStringify } from '../../core/cache-stable-stringify.mjs';

function makeProjectDir(manifest = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-start-prefix-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  if (manifest) {
    fs.writeFileSync(
      path.join(dir, '.claude', 'runtime-manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf8'
    );
  }
  return dir;
}

const SESSION_STARTED_AT = '2026-05-07T11:00:00.000Z';

const TASK_FIXTURE = {
  task: {
    taskId: 'T-001',
    title: 'Fix prefix stability',
    matchedScopes: ['runtime', 'eval'],
    readFirst: [
      { path: 'src/foo.mjs', why: 'entry point' },
      { path: 'docs/spec.md', why: 'design spec' }
    ],
    lastWorklog: { relativePath: '10_Worklogs/Auto/2026-05-07.md' }
  }
};

const WORKLOG_FIXTURE = {
  modifiedFileCount: 2,
  failureCount: 0,
  hookEventName: 'SessionEnd',
  worklogRelativePath: '10_Worklogs/Auto/2026-05-06.md'
};

function callBuild(overrides = {}) {
  return buildAdditionalContext({
    projectDir: overrides.projectDir || '/tmp/no-such-dir',
    env: overrides.env || { CLAUDE_RUNTIME_HOME: '/path/to/runtime' },
    sessionId: 'sess-A',
    sessionStartedAt: SESSION_STARTED_AT,
    currentTask: TASK_FIXTURE,
    latestWorklog: WORKLOG_FIXTURE,
    orphanPointerNote: '',
    lastObservationLine: null,
    errorBlock: null,
    ...overrides
  });
}

// ── #1 prefix_consistent_two_calls_same_task ─────────────────────
describe('D-1 prefix_consistent_two_calls_same_task', () => {
  it('Identity + Task sections are byte-equal across two calls with different session_id', () => {
    const env = { CLAUDE_RUNTIME_HOME: '/path/A' };
    const projectDir = makeProjectDir({ projectTag: 'tag-A', managedRoots: ['a','b','c'] });
    const a = buildAdditionalContext({
      projectDir, env, sessionId: 'sess-1', sessionStartedAt: SESSION_STARTED_AT,
      currentTask: TASK_FIXTURE, latestWorklog: null,
      orphanPointerNote: '', lastObservationLine: null, errorBlock: null
    });
    const b = buildAdditionalContext({
      projectDir, env, sessionId: 'sess-2', sessionStartedAt: '2026-06-01T00:00:00Z',
      currentTask: TASK_FIXTURE, latestWorklog: null,
      orphanPointerNote: '', lastObservationLine: null, errorBlock: null
    });
    const aPrefix = a.split('\n## Session Volatile')[0];
    const bPrefix = b.split('\n## Session Volatile')[0];
    assert.equal(aPrefix, bPrefix);
  });
});

// ── #2 session_id_isolated_in_volatile ───────────────────────────
describe('D-2 session_id_isolated_in_volatile', () => {
  it('## Project Identity section is byte-equal even when session_id differs', () => {
    const env = { CLAUDE_RUNTIME_HOME: '/path/B' };
    const projectDir = makeProjectDir({ projectTag: 'pt', managedRoots: [] });
    const a = callBuild({ projectDir, env, sessionId: 'sA' });
    const b = callBuild({ projectDir, env, sessionId: 'sB' });
    const idSection = (text) => text.split('\n## Task Context')[0];
    assert.equal(idSection(a), idSection(b));
    // session_id appears in Volatile, not Identity
    assert.ok(a.includes('- session_id: sA'));
    assert.ok(b.includes('- session_id: sB'));
  });
});

// ── #3 task_omit_when_no_pointer ─────────────────────────────────
describe('D-3 task_omit_when_no_pointer', () => {
  it('Task Context omitted when currentTask is null', () => {
    const projectDir = makeProjectDir({ projectTag: 'p', managedRoots: [] });
    const out = callBuild({ projectDir, currentTask: null });
    assert.ok(!out.includes('## Task Context'));
    assert.ok(!out.includes('## Recent Failures'));
    assert.ok(out.includes('## Project Identity'));
    assert.ok(out.includes('## Session Volatile'));
  });
});

// ── #4 task_omit_when_orphan_pointer ─────────────────────────────
describe('D-4 task_omit_when_orphan_pointer', () => {
  it('Task Context omitted + last_worklog_summary notes carries orphan tag', () => {
    const projectDir = makeProjectDir({ projectTag: 'p', managedRoots: [] });
    const out = callBuild({
      projectDir,
      currentTask: null,
      orphanPointerNote: 'task pointer orphan'
    });
    assert.ok(!out.includes('## Task Context'));
    assert.ok(out.includes('notes=task pointer orphan'));
  });
});

// ── #5 scopes_sorted_alphabetic ──────────────────────────────────
describe('D-5 scopes_sorted_alphabetic', () => {
  it('matchedScopes are emitted in alphabetic asc order', () => {
    const projectDir = makeProjectDir({ projectTag: 'p', managedRoots: [] });
    const task = {
      task: {
        ...TASK_FIXTURE.task,
        matchedScopes: ['zeta', 'alpha', 'mu']
      }
    };
    const out = callBuild({ projectDir, currentTask: task });
    assert.ok(out.includes('- active_scopes: alpha, mu, zeta'));
  });
});

// ── #6 read_first_path_alphabetic ────────────────────────────────
describe('D-6 read_first_path_alphabetic', () => {
  it('read_first lines emit in path asc, regardless of input order', () => {
    const projectDir = makeProjectDir({ projectTag: 'p', managedRoots: [] });
    const task = {
      task: {
        ...TASK_FIXTURE.task,
        readFirst: [
          { path: 'c.md', why: 'c' },
          { path: 'a.md', why: 'a' },
          { path: 'b.md', why: 'b' }
        ]
      }
    };
    const out = callBuild({ projectDir, currentTask: task });
    const idxA = out.indexOf('- a.md');
    const idxB = out.indexOf('- b.md');
    const idxC = out.indexOf('- c.md');
    assert.ok(idxA > 0 && idxA < idxB && idxB < idxC, `got order a=${idxA} b=${idxB} c=${idxC}`);
  });
});

// ── #7 recent_failures_omit_when_empty ───────────────────────────
describe('D-7 recent_failures_omit_when_empty', () => {
  it('## Recent Failures section is fully omitted when errorBlock is null', () => {
    const projectDir = makeProjectDir({ projectTag: 'p', managedRoots: [] });
    const out = callBuild({ projectDir, errorBlock: null });
    assert.ok(!out.includes('## Recent Failures'));
  });
});

// ── #8 stable_stringify_object_key_order (covered in cache-stable-stringify.test.mjs) ─
describe('D-8 stable_stringify_object_key_order', () => {
  it('two object literals with different key insertion order serialize identically', () => {
    const a = stableStringify({ z: 1, a: 2 });
    const b = stableStringify({ a: 2, z: 1 });
    assert.equal(a, b);
  });
});

// ── #9 stable_stringify_array_input_order_preserved ──────────────
describe('D-9 stable_stringify_array_input_order_preserved', () => {
  it('arrays emit in input order (caller sorts before passing)', () => {
    const out = stableStringify(['z', 'a', 'm']);
    assert.equal(out, '["z","a","m"]');
  });
});

// ── #10 volatile_section_keys_alphabetic ─────────────────────────
describe('D-10 volatile_section_keys_alphabetic', () => {
  it('Session Volatile sub-keys appear in last_observation < last_worklog < last_worklog_summary < session_id < session_started_at order', () => {
    const projectDir = makeProjectDir({ projectTag: 'p', managedRoots: [] });
    const out = callBuild({
      projectDir,
      lastObservationLine: '- last_observation: tool_use @ src/foo.mjs (size=12 KB)',
      latestWorklog: WORKLOG_FIXTURE
    });
    const lines = out.split('\n');
    const start = lines.findIndex((l) => l === '## Session Volatile');
    assert.ok(start > 0);
    const order = lines.slice(start + 1).map((l) => l.match(/^- (\w+):/)?.[1]).filter(Boolean);
    const expected = ['last_observation', 'last_worklog', 'last_worklog_summary', 'session_id', 'session_started_at'];
    assert.deepEqual(order, expected);
  });
});

// ── #11 identity_section_keys_alphabetic ─────────────────────────
describe('D-11 identity_section_keys_alphabetic', () => {
  it('Project Identity sub-keys appear in managed_roots < project_id < runtime < runtime_home_hash order', () => {
    const projectDir = makeProjectDir({ projectTag: 'p', managedRoots: [] });
    const out = callBuild({ projectDir });
    const lines = out.split('\n');
    const start = lines.findIndex((l) => l === '## Project Identity');
    const order = lines.slice(start + 1, start + 5).map((l) => l.match(/^- (\w+):/)?.[1]);
    assert.deepEqual(order, ['managed_roots', 'project_id', 'runtime', 'runtime_home_hash']);
  });
});

// ── #12 json_envelope_stable ─────────────────────────────────────
describe('D-12 json_envelope_stable', () => {
  it('hookSpecificOutput envelope is byte-stable across two builds with the same projectDir/task', () => {
    const projectDir = makeProjectDir({ projectTag: 'p', managedRoots: [] });
    // No session pointer state → both calls see no ownedTask, but the volatile
    // section has different session_id. Identity section must still be stable
    // when wrapped via stableStringify with the same shape.
    const o1 = buildRuntimeSessionStartContext(projectDir, { session_id: 'one' });
    const o2 = buildRuntimeSessionStartContext(projectDir, { session_id: 'two' });
    // Stringify each and verify the JSON keys are sorted identically.
    const s1 = stableStringify(o1);
    const s2 = stableStringify(o2);
    // Both share the same outer shape `{"hookSpecificOutput":{"additionalContext":...,"hookEventName":"SessionStart"}}`
    assert.match(s1, /^\{"hookSpecificOutput":\{"additionalContext":/);
    assert.match(s2, /^\{"hookSpecificOutput":\{"additionalContext":/);
    // The JSON shape (key order) must be identical.
    const shape1 = s1.replace(/"additionalContext":"[^"]*"/, '"additionalContext":"<X>"');
    const shape2 = s2.replace(/"additionalContext":"[^"]*"/, '"additionalContext":"<X>"');
    assert.equal(shape1, shape2);
  });
});

// ── #13 runtime_home_hash_machine_invariant ──────────────────────
describe('D-13 runtime_home_hash_machine_invariant', () => {
  it('same CLAUDE_RUNTIME_HOME absolute path → same 8-char hash; different path → different hash', () => {
    const a = computeRuntimeHomeHash({ CLAUDE_RUNTIME_HOME: '/path/X' });
    const b = computeRuntimeHomeHash({ CLAUDE_RUNTIME_HOME: '/path/X' });
    const c = computeRuntimeHomeHash({ CLAUDE_RUNTIME_HOME: '/path/Y' });
    assert.equal(a.length, 8);
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.match(a, /^[0-9a-f]{8}$/);
  });
});

// ── #14 section_omit_no_blank_separator ──────────────────────────
describe('D-14 section_omit_no_blank_separator', () => {
  it('no orphan separators or blank section markers remain when sections are omitted', () => {
    const projectDir = makeProjectDir({ projectTag: 'p', managedRoots: [] });
    const out = callBuild({ projectDir, currentTask: null, errorBlock: null });
    // Should contain only Identity + Volatile (Task and Failures omitted).
    assert.ok(!out.includes('## Task Context'));
    assert.ok(!out.includes('## Recent Failures'));
    // Two consecutive blank lines would indicate ghost section separator.
    assert.ok(!out.includes('\n\n\n'));
  });
});

// ── ancillary: buildLastObservationLine returns null for empty input ─
describe('I-aux buildLastObservationLine empty input', () => {
  it('returns null when no off-load events present', () => {
    assert.equal(buildLastObservationLine([]), null);
    assert.equal(buildLastObservationLine(null), null);
  });
});
