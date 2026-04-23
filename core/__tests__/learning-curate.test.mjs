import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLessonDraft,
  buildTroubleshootingDraft,
  buildReflectionDraft,
  evolveRelatedMemories,
  distillProceduralMemory
} from '../learning-curate.mjs';

function makeTask(overrides = {}) {
  return {
    taskId: '20260423-1200-test',
    title: 'Fix login session crash',
    prompt: 'Fix login session crash when token refresh fails',
    matchedScopes: ['backend'],
    files: ['backend/src/routes/auth.ts', 'backend/src/services/session.ts'],
    verifications: [],
    failures: [],
    detectedSurfaces: [],
    createdAt: '2026-04-23T10:00:00.000Z',
    updatedAt: '2026-04-23T12:00:00.000Z',
    closedAt: '2026-04-23T12:00:00.000Z',
    ...overrides
  };
}

describe('learning-curate.buildLessonDraft (Design-A §3-A)', () => {
  it('emits v3 frontmatter fields with low confidence for 0 verifications', () => {
    const draft = buildLessonDraft(makeTask(), []);
    assert.equal(draft.type, 'lesson');
    assert.equal(draft.confidence, 'low');
    assert.equal(draft.importance, 3);
    assert.equal(draft.access_count, 0);
    assert.deepEqual(draft.evolved_at, []);
    assert.equal(draft.linked_reflection, null);
    assert.equal(draft.status, 'draft');
  });

  it('scales confidence/importance with verification count', () => {
    const many = buildLessonDraft(
      makeTask({ verifications: [{ success: true }, { success: true }, { success: true }] }),
      []
    );
    assert.equal(many.confidence, 'high');
    assert.equal(many.importance, 9);

    const some = buildLessonDraft(
      makeTask({ verifications: [{ success: true }] }),
      []
    );
    assert.equal(some.confidence, 'medium');
    assert.equal(some.importance, 6);
  });

  it('extracts >=3 trigger keywords from task + event paths', () => {
    const draft = buildLessonDraft(
      makeTask(),
      [{ detail: { filePath: 'backend/src/routes/checkout.ts' } }]
    );
    assert.ok(draft.trigger_keywords.length >= 3, `got ${draft.trigger_keywords.length}`);
  });
});

describe('learning-curate.buildTroubleshootingDraft', () => {
  it('returns null when no failures recorded', () => {
    const draft = buildTroubleshootingDraft(makeTask(), []);
    assert.equal(draft, null);
  });

  it('returns draft with 4 auto + 4 manual sections when failures present', () => {
    const draft = buildTroubleshootingDraft(makeTask({
      failures: [{ summary: 'verification_failed: npm test', eventType: 'verification_failed' }]
    }));
    assert.equal(draft.kind, 'troubleshooting');
    assert.deepEqual(draft.autoSections, ['증상', '재현 조건', '영향 범위', '관련 링크']);
    assert.deepEqual(draft.manualSections, ['실제 원인', '수정 방법', '재발 방지 규칙', '검증']);
  });

  it('includes CURATOR_TODO markers in manual sections', () => {
    const draft = buildTroubleshootingDraft(makeTask({
      failures: [{ summary: 'fail' }]
    }));
    const matches = draft.body.match(/CURATOR_TODO/g) || [];
    assert.equal(matches.length, 4, 'expected 4 CURATOR_TODO markers (one per manual section)');
  });
});

describe('learning-curate.buildReflectionDraft (Design-A §3-D)', () => {
  it('returns null when no failures', () => {
    const draft = buildReflectionDraft(makeTask());
    assert.equal(draft, null);
  });

  it('returns null when failures exist but no verification_failed-like signal', () => {
    const draft = buildReflectionDraft(makeTask({
      failures: [{ summary: 'tool_failed: Bash echo', eventType: 'tool_failed' }],
      verifications: [{ success: true, command: 'npm test' }]
    }));
    assert.equal(draft, null, 'reflection requires verification-shaped failure');
  });

  it('returns draft with linked_lesson when verification fails', () => {
    const task = makeTask({
      failures: [{ summary: 'tests red', eventType: 'verification_failed' }],
      verifications: [{ success: false, command: 'npm test' }]
    });
    const draft = buildReflectionDraft(task);
    assert.ok(draft, 'should return a reflection');
    assert.equal(draft.kind, 'reflection');
    assert.equal(draft.linked_lesson, `lesson-${task.taskId}`);
    assert.equal(draft.confidence_of_fix, 'low');
  });
});

describe('learning-curate.evolveRelatedMemories', () => {
  it('returns error when deps missing', () => {
    const r = evolveRelatedMemories({ id: 'lesson-x' }, {});
    assert.equal(r.evolved.length, 0);
    assert.ok(r.error);
  });

  it('invokes findNeighbors + applyEvolution + upsertLesson for each match', () => {
    const neighborLesson = { id: 'lesson-old', tokens: ['auth', 'token'] };
    const calls = { listLessons: 0, findNeighbors: 0, applyEvolution: 0, upsertLesson: 0 };
    const r = evolveRelatedMemories({ id: 'lesson-new', tokens: ['auth'] }, {
      projectDir: '/tmp/fake',
      deps: {
        listLessons: () => { calls.listLessons += 1; return [neighborLesson]; },
        findNeighbors: () => { calls.findNeighbors += 1; return [{ lesson: neighborLesson, score: 0.9 }]; },
        applyEvolution: (n) => { calls.applyEvolution += 1; return { ...n, note: 'evolved' }; },
        upsertLesson: () => { calls.upsertLesson += 1; return { ok: true, lessonId: neighborLesson.id }; }
      }
    });
    assert.equal(r.evolved.length, 1);
    assert.equal(calls.findNeighbors, 1);
    assert.equal(calls.applyEvolution, 1);
    assert.equal(calls.upsertLesson, 1);
  });
});

describe('learning-curate.distillProceduralMemory', () => {
  const now = new Date('2026-04-23T12:00:00.000Z');

  function makeHistoryTask({ taskId, surfaces, daysAgo, scope = 'backend' }) {
    const closedAt = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
    return {
      taskId,
      matchedScopes: [scope],
      closedAt,
      updatedAt: closedAt,
      detectedSurfaces: surfaces.map((t) => ({ surfaceType: t }))
    };
  }

  it('returns 0 candidates when repeat threshold not met (only 2 occurrences)', () => {
    const history = [
      makeHistoryTask({ taskId: 't1', surfaces: ['route'], daysAgo: 1 }),
      makeHistoryTask({ taskId: 't2', surfaces: ['route'], daysAgo: 2 })
    ];
    const r = distillProceduralMemory(history, { repeatThreshold: 3, now });
    assert.equal(r.candidates.length, 0);
  });

  it('returns candidate when same pattern repeats >=3 times within window', () => {
    const history = [
      makeHistoryTask({ taskId: 't1', surfaces: ['route', 'service'], daysAgo: 1 }),
      makeHistoryTask({ taskId: 't2', surfaces: ['route', 'service'], daysAgo: 5 }),
      makeHistoryTask({ taskId: 't3', surfaces: ['route', 'service'], daysAgo: 10 })
    ];
    const r = distillProceduralMemory(history, { repeatThreshold: 3, now });
    assert.equal(r.candidates.length, 1);
    const c = r.candidates[0];
    assert.equal(c.kind, 'procedure');
    assert.equal(c.pattern_signature, 'route+service');
    assert.equal(c.distilled_from_tasks.length, 3);
    assert.equal(c.scope, 'backend');
  });

  it('excludes tasks older than windowDays', () => {
    const history = [
      makeHistoryTask({ taskId: 't1', surfaces: ['route'], daysAgo: 1 }),
      makeHistoryTask({ taskId: 't2', surfaces: ['route'], daysAgo: 45 }),
      makeHistoryTask({ taskId: 't3', surfaces: ['route'], daysAgo: 50 })
    ];
    const r = distillProceduralMemory(history, { repeatThreshold: 3, windowDays: 30, now });
    assert.equal(r.candidates.length, 0, 'only 1 task within window => no candidate');
  });
});
