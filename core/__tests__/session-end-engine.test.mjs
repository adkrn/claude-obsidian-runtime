import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  HANDOFF_SECTION_HEADERS,
  buildHandoffWorklog,
  runSessionEndHooks
} from '../session-end-engine.mjs';

describe('session-end-engine.buildHandoffWorklog (Design-A §3-B)', () => {
  const task = {
    taskId: '20260423-1200-test',
    title: 'Fix auth flow',
    matchedScopes: ['backend']
  };

  it('renders all 5 headers in fixed order', () => {
    const handoff = buildHandoffWorklog({
      task,
      changedFiles: [{ path: 'a.ts', why: 'refactor' }],
      openACs: ['add e2e tests'],
      preserveHooks: ['error-detector.sh'],
      matchedScopes: ['backend'],
      decisions: ['stick with JWT'],
      oneLiner: 'run e2e tests first'
    });

    const indices = HANDOFF_SECTION_HEADERS.map((h) => handoff.markdown.indexOf(h));
    assert.ok(indices.every((i) => i >= 0), 'all headers must be present');
    for (let i = 1; i < indices.length; i += 1) {
      assert.ok(indices[i] > indices[i - 1], `header ${i} must appear after header ${i - 1}`);
    }
  });

  it('includes "변경 사항 없음" placeholder when no changed files or commits', () => {
    const handoff = buildHandoffWorklog({ task });
    assert.ok(handoff.markdown.includes('변경 사항 없음'));
  });

  it('exposes section map via return value', () => {
    const handoff = buildHandoffWorklog({ task, oneLiner: 'next' });
    assert.ok(handoff.sections['이번 세션에서 한 일']);
    assert.ok(handoff.sections['한 줄 메모']);
  });
});

describe('session-end-engine.runSessionEndHooks (Design-A §4-B)', () => {
  function makeTask(overrides = {}) {
    return {
      taskId: '20260423-1200-test',
      title: 'Test task',
      matchedScopes: ['backend'],
      files: [],
      verifications: [],
      failures: [],
      ...overrides
    };
  }

  it('runs hooks in required order: lesson → reflection → trouble → arch → worklog → procedural', () => {
    const order = [];
    const task = makeTask({
      failures: [{ summary: 'fail', eventType: 'verification_failed' }],
      verifications: [{ success: false, command: 'npm test' }]
    });

    runSessionEndHooks({
      projectDir: '/tmp/fake',
      manifest: { memoryLayers: { reflectionsEnabled: true, proceduralEnabled: true, evolutionEnabled: true } },
      task,
      events: [],
      taskHistory: [],
      hooks: {
        buildLessonDraft:        () => { order.push('lesson');      return { id: 'lesson-x' }; },
        upsertLesson:            () => { order.push('lesson_up');   return { ok: true }; },
        buildReflectionDraft:    () => { order.push('reflection');  return { id: 'reflection-x' }; },
        upsertReflection:        () => { order.push('reflect_up');  return { ok: true }; },
        buildTroubleshootingDraft: () => { order.push('trouble');   return { id: 'trouble-x' }; },
        writeTroubleshooting:    () => { order.push('trouble_wr');  return { ok: true }; },
        architectureDetect:      () => { order.push('arch');        return { ok: true }; },
        writeWorklog:            () => { order.push('worklog');     return { ok: true }; },
        distillProceduralMemory: () => { order.push('distill');     return { candidates: [] }; }
      }
    });

    // The lesson family must come before reflection, which must come before
    // trouble, before arch, before worklog, before procedural distillation.
    const first = (label) => order.indexOf(label);
    assert.ok(first('lesson') < first('reflection'));
    assert.ok(first('reflection') < first('trouble'));
    assert.ok(first('trouble') < first('arch'));
    assert.ok(first('arch') < first('worklog'));
    assert.ok(first('worklog') < first('distill'));
  });

  it('skips reflection when reflectionsEnabled=false', () => {
    const order = [];
    runSessionEndHooks({
      projectDir: '/tmp/fake',
      manifest: { memoryLayers: { reflectionsEnabled: false } },
      task: makeTask({ failures: [{ summary: 'x', eventType: 'verification_failed' }], verifications: [{ success: false }] }),
      hooks: {
        buildReflectionDraft: () => { order.push('reflection'); return {}; },
        writeWorklog:         () => { order.push('worklog'); return {}; }
      }
    });
    assert.ok(!order.includes('reflection'), 'reflection must be skipped');
  });

  it('skips procedural when proceduralEnabled=false', () => {
    const order = [];
    runSessionEndHooks({
      projectDir: '/tmp/fake',
      manifest: { memoryLayers: { proceduralEnabled: false } },
      task: makeTask(),
      taskHistory: [],
      hooks: {
        distillProceduralMemory: () => { order.push('distill'); return { candidates: [] }; },
        writeWorklog:            () => { order.push('worklog'); return {}; }
      }
    });
    assert.ok(!order.includes('distill'), 'distill must be skipped');
  });

  it('captures errors per-hook without aborting downstream hooks', () => {
    const order = [];
    const result = runSessionEndHooks({
      projectDir: '/tmp/fake',
      manifest: {},
      task: makeTask(),
      hooks: {
        buildLessonDraft: () => { throw new Error('lesson boom'); },
        writeWorklog:     () => { order.push('worklog'); return { ok: true }; }
      }
    });
    assert.ok(result.errors.lesson_draft);
    assert.ok(order.includes('worklog'), 'worklog must still run after lesson error');
  });

  it('skips troubleshooting when no failures present', () => {
    const order = [];
    runSessionEndHooks({
      projectDir: '/tmp/fake',
      manifest: {},
      task: makeTask({ failures: [] }),
      hooks: {
        buildTroubleshootingDraft: () => { order.push('trouble'); return {}; },
        writeWorklog:              () => { order.push('worklog'); return {}; }
      }
    });
    assert.ok(!order.includes('trouble'));
  });
});
