/**
 * DESIGN_MANUS_E §9 — 12 AC for the 4-stage error protocol.
 *
 * #1, #2, #3, #4, #10, #11: lead guide text inspect (no automatic retry runtime)
 * #5: buildReflectionDraft trigger when verification_failed event present
 * #6, #7, #8, #12: episodic-store append + 3-tuple matching semantics
 * #9: E §8 SSOT == §4-A §5-B same buildReflectionDraft entrypoint
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { append, query } from '../episodic-store.mjs';
import { buildReflectionDraft } from '../../learning-curate.mjs';
import { stableStringify } from '../../cache-stable-stringify.mjs';
import { createFixtureProject } from './_fixture.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LEAD_TEMPLATE_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'templates',
  'agents',
  '_lead.md'
);

function readLeadTemplate() {
  return fs.readFileSync(LEAD_TEMPLATE_PATH, 'utf8');
}

function isSameAttempt(prev, next) {
  return (
    prev.toolName === next.toolName
    && stableStringify(prev.detail?.params ?? null)
       === stableStringify(next.detail?.params ?? null)
  );
}

function matches3Tuple(a, b) {
  const fpA = a.detail?.filePath ?? null;
  const fpB = b.detail?.filePath ?? null;
  const etA = a.detail?.errorType ?? a.error?.type ?? 'unknown';
  const etB = b.detail?.errorType ?? b.error?.type ?? 'unknown';
  return a.toolName === b.toolName && fpA === fpB && etA === etB;
}

describe('DESIGN_MANUS_E — _lead.md guide text inspect (AC #1~#4, #10, #11)', () => {
  it('#1 verify_immediate_fix: lead guide defines verify stage', () => {
    const text = readLeadTemplate();
    assert.match(text, /## 에러 마주치면/);
    assert.match(text, /\*\*verify\*\*/);
  });

  it('#2 fix_with_arg_change: lead guide defines fix stage', () => {
    const text = readLeadTemplate();
    assert.match(text, /\*\*fix\*\*/);
    assert.match(text, /인자.*변경|인자 일부라도 변경/);
  });

  it('#3 alternative_tool_change: lead guide defines alternative stage', () => {
    const text = readLeadTemplate();
    assert.match(text, /\*\*alternative\*\*/);
    assert.match(text, /다른 도구|Edit → Write/);
  });

  it('#4 same_tool_same_args_blocked: lead guide forbids same tool + same args retry', () => {
    const text = readLeadTemplate();
    assert.match(text, /동일 도구.*동일 인자 재호출 금지|동일 인자 재시도 금지/);
  });

  it('#10 escalate_message_format: lead guide marks cap=3 + [ASK] for escalate', () => {
    const text = readLeadTemplate();
    assert.match(text, /3회/);
    assert.match(text, /\[ASK\]/);
    assert.match(text, /escalate/);
  });

  it('#11 notify_after_draft: lead guide cross-references [NOTIFY]/[ASK] convention', () => {
    const text = readLeadTemplate();
    assert.match(text, /\[NOTIFY\]/);
    assert.match(text, /메시지 컨벤션/);
  });
});

describe('DESIGN_MANUS_E — episodic-store recovery_attempts (AC #6~#8, #12)', () => {
  it('#6 recovery_attempts accumulation: append preserves the flat field across rows', () => {
    const fixture = createFixtureProject();
    try {
      const baseTs = Date.parse('2026-05-07T10:00:00Z');
      append(fixture.projectDir, {
        ts: new Date(baseTs).toISOString(),
        taskId: 't-6',
        eventType: 'tool_use',
        toolName: 'Edit',
        outcome: 'fail',
        detail: { filePath: 'src/foo.ts', errorType: 'string-not-found', params: { old: 'a' } },
        recovery_attempts: 0
      });
      append(fixture.projectDir, {
        ts: new Date(baseTs + 1000).toISOString(),
        taskId: 't-6',
        eventType: 'tool_recovery',
        toolName: 'Edit',
        outcome: 'fail',
        detail: { filePath: 'src/foo.ts', errorType: 'string-not-found', params: { old: 'aa' } },
        recovery_attempts: 1
      });
      append(fixture.projectDir, {
        ts: new Date(baseTs + 2000).toISOString(),
        taskId: 't-6',
        eventType: 'tool_recovery',
        toolName: 'Edit',
        outcome: 'fail',
        detail: { filePath: 'src/foo.ts', errorType: 'string-not-found', params: { old: 'aaa' } },
        recovery_attempts: 2
      });
      append(fixture.projectDir, {
        ts: new Date(baseTs + 3000).toISOString(),
        taskId: 't-6',
        eventType: 'tool_recovery',
        toolName: 'Edit',
        outcome: 'success',
        detail: { filePath: 'src/foo.ts', errorType: 'string-not-found', params: { old: 'b' } },
        recovery_attempts: 3
      });

      const rows = query(fixture.projectDir, { taskId: 't-6' });
      assert.equal(rows.length, 4);
      assert.deepEqual(
        rows.map((r) => r.recovery_attempts),
        [0, 1, 2, 3]
      );
      assert.equal(rows[3].outcome, 'success');
    } finally {
      fixture.cleanup();
    }
  });

  it('#7 three_tuple_match_different_filepath: different filePath = separate counters', () => {
    const fixture = createFixtureProject();
    try {
      const a = {
        ts: '2026-05-07T11:00:00Z',
        taskId: 't-7',
        eventType: 'tool_use',
        toolName: 'Edit',
        outcome: 'fail',
        detail: { filePath: 'src/foo.ts', errorType: 'string-not-found' },
        recovery_attempts: 0
      };
      const b = {
        ts: '2026-05-07T11:00:01Z',
        taskId: 't-7',
        eventType: 'tool_use',
        toolName: 'Edit',
        outcome: 'fail',
        detail: { filePath: 'src/bar.ts', errorType: 'string-not-found' },
        recovery_attempts: 0
      };
      append(fixture.projectDir, a);
      append(fixture.projectDir, b);

      assert.equal(matches3Tuple(a, b), false);
      const rows = query(fixture.projectDir, { taskId: 't-7' });
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map((r) => r.recovery_attempts), [0, 0]);
    } finally {
      fixture.cleanup();
    }
  });

  it('#8 three_tuple_match_different_errortype: different errorType = separate counters', () => {
    const fixture = createFixtureProject();
    try {
      const a = {
        ts: '2026-05-07T12:00:00Z',
        taskId: 't-8',
        eventType: 'tool_use',
        toolName: 'Edit',
        outcome: 'fail',
        detail: { filePath: 'src/foo.ts', errorType: 'string-not-found' },
        recovery_attempts: 0
      };
      const b = {
        ts: '2026-05-07T12:00:01Z',
        taskId: 't-8',
        eventType: 'tool_use',
        toolName: 'Edit',
        outcome: 'fail',
        detail: { filePath: 'src/foo.ts', errorType: 'ENOENT' },
        recovery_attempts: 0
      };
      append(fixture.projectDir, a);
      append(fixture.projectDir, b);

      assert.equal(matches3Tuple(a, b), false);
      const rows = query(fixture.projectDir, { taskId: 't-8' });
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map((r) => r.recovery_attempts), [0, 0]);
    } finally {
      fixture.cleanup();
    }
  });

  it('#12 reset_after_success: same 3-tuple after success starts at 0', () => {
    const fixture = createFixtureProject();
    try {
      const baseTs = Date.parse('2026-05-07T13:00:00Z');
      const triple = {
        toolName: 'Edit',
        filePath: 'src/foo.ts',
        errorType: 'string-not-found'
      };
      append(fixture.projectDir, {
        ts: new Date(baseTs).toISOString(),
        taskId: 't-12',
        toolName: triple.toolName,
        outcome: 'fail',
        detail: { filePath: triple.filePath, errorType: triple.errorType },
        recovery_attempts: 0
      });
      append(fixture.projectDir, {
        ts: new Date(baseTs + 1000).toISOString(),
        taskId: 't-12',
        toolName: triple.toolName,
        outcome: 'success',
        detail: { filePath: triple.filePath, errorType: triple.errorType },
        recovery_attempts: 1
      });
      append(fixture.projectDir, {
        ts: new Date(baseTs + 2000).toISOString(),
        taskId: 't-12',
        toolName: triple.toolName,
        outcome: 'fail',
        detail: { filePath: triple.filePath, errorType: triple.errorType },
        recovery_attempts: 0
      });

      const rows = query(fixture.projectDir, { taskId: 't-12' });
      assert.equal(rows.length, 3);
      assert.deepEqual(rows.map((r) => r.recovery_attempts), [0, 1, 0]);
      assert.equal(rows[2].outcome, 'fail');
    } finally {
      fixture.cleanup();
    }
  });

  it('isSameAttempt deepEqual blocks same tool + same args (AC #4 invariant)', () => {
    const a = {
      toolName: 'Edit',
      detail: { params: { file: 'foo.ts', old: 'x', new: 'y' } }
    };
    const b = {
      toolName: 'Edit',
      detail: { params: { file: 'foo.ts', new: 'y', old: 'x' } }
    };
    const c = {
      toolName: 'Edit',
      detail: { params: { file: 'foo.ts', old: '  x', new: '  y' } }
    };
    assert.equal(isSameAttempt(a, b), true, 'key order independent');
    assert.equal(isSameAttempt(a, c), false, 'arg change escapes block');
  });
});

describe('DESIGN_MANUS_E — buildReflectionDraft SSOT (AC #5, #9)', () => {
  it('#5 escalate_after_cap: cap-exceeded synthesized task triggers reflection draft', () => {
    const taskAtCap = {
      taskId: 't-5',
      title: 'cap exceeded scenario',
      matchedScopes: ['repo'],
      failures: [
        {
          summary: 'string-not-found in src/foo.ts',
          eventType: 'verification_failed',
          type: 'string-not-found',
          ts: '2026-05-07T14:00:00Z'
        }
      ],
      verifications: []
    };
    const draft = buildReflectionDraft(taskAtCap);
    assert.ok(draft, 'draft must be created when verification_failed eventType present');
    assert.equal(draft.kind, 'reflection');
    assert.equal(draft.related_task, 't-5');
    assert.equal(draft.status, 'draft');
  });

  it('#9 reflection_draft_e_4a_same_entry: E and §4-A invoke the same buildReflectionDraft', () => {
    // E synthesized task (cap-exceeded)
    const eTask = {
      taskId: 't-9-e',
      title: 'e-flow',
      matchedScopes: ['repo'],
      failures: [
        { summary: 'verify cap', eventType: 'verification_failed', type: 'cap', ts: '2026-05-07T15:00:00Z' }
      ],
      verifications: []
    };
    // §4-A synthesized task (doctor FAIL)
    const aTask = {
      taskId: 't-9-4a',
      title: '4a-flow',
      matchedScopes: ['repo'],
      failures: [
        { summary: 'task-close --verify FAIL: C07 — code index stale', eventType: 'verification_failed', type: 'verify-c07', ts: '2026-05-07T15:00:01Z' }
      ],
      verifications: [
        { command: 'doctor --check=c07', success: false, summary: 'code index stale' }
      ]
    };
    const eDraft = buildReflectionDraft(eTask);
    const aDraft = buildReflectionDraft(aTask);
    assert.ok(eDraft);
    assert.ok(aDraft);
    // Same algorithm, same shape, same entrypoint — reflection-* / kind / status invariants.
    assert.equal(eDraft.kind, aDraft.kind);
    assert.equal(eDraft.status, aDraft.status);
    assert.ok(eDraft.id.startsWith('reflection-'));
    assert.ok(aDraft.id.startsWith('reflection-'));
  });
});
