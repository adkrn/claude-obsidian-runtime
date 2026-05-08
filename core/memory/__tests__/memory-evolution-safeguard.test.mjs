/**
 * DESIGN_MANUS_4B §9 — frontmatter safeguard AC tests (7 cases).
 *
 * AC-1 evolution 정상 → 11필드 보존 → no rollback
 * AC-2 1필드 누락 → FAIL → rollback + reflection draft
 * AC-3 타입 불일치 → FAIL → rollback
 * AC-4 빈 값 → WARN, rollback X
 * AC-5 process kill 시뮬레이션 (메모리 변수 한계 명시 — out-of-scope 가정)
 * AC-6 hash mismatch (외부 변조) → rollback_failed 시그널
 * AC-7 parser throw → FAIL → rollback
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import {
  applyEvolutionWithSafeguard,
  captureCheckpoint,
  proposeEvolution,
  rollbackLesson,
  verifyFrontmatter11Fields
} from '../memory-evolution.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), `manus-4b-${crypto.randomBytes(4).toString('hex')}-`));
}

function buildValidLessonMarkdown(overrides = {}) {
  const fm = {
    id: 'lesson-001',
    type: 'lesson',
    scope: 'repo',
    title: 'Sample lesson',
    summary: 'A sample lesson summary.',
    trigger_keywords: ['hook', 'capture'],
    applicable_when: { scope_id: 'repo' },
    confidence: 'medium',
    importance: 6,
    related_task: 'TASK-001',
    related_files: ['core/foo.mjs'],
    ...overrides
  };
  const lines = ['---'];
  for (const [key, value] of Object.entries(fm)) {
    if (value === undefined) continue;
    lines.push(serializeYaml(key, value));
  }
  lines.push('---');
  lines.push('# body');
  return lines.join('\n');
}

function serializeYaml(key, value) {
  if (Array.isArray(value)) {
    if (value.length === 0) return `${key}: []`;
    return `${key}: [${value.map((v) => (typeof v === 'string' ? v : String(v))).join(', ')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const lines = [`${key}:`];
    for (const [k, v] of Object.entries(value)) {
      if (Array.isArray(v)) {
        lines.push(`  ${k}: [${v.join(', ')}]`);
      } else {
        lines.push(`  ${k}: ${v}`);
      }
    }
    return lines.join('\n');
  }
  if (value === null) return `${key}: null`;
  if (typeof value === 'boolean' || typeof value === 'number') return `${key}: ${value}`;
  return `${key}: ${value}`;
}

// ── parser / verify ───────────────────────────────────────────────

test('verifyFrontmatter11Fields: AC-1 valid 11 fields → valid=true, no missing', () => {
  const md = buildValidLessonMarkdown();
  const result = verifyFrontmatter11Fields(md);
  assert.equal(result.valid, true);
  assert.deepEqual(result.missingFields, []);
  assert.deepEqual(result.typeErrors, []);
  assert.deepEqual(result.emptyFields, []);
});

test('verifyFrontmatter11Fields: AC-2 missing applicable_when → FAIL', () => {
  const md = buildValidLessonMarkdown({ applicable_when: undefined });
  const result = verifyFrontmatter11Fields(md);
  assert.equal(result.valid, false);
  assert.ok(result.missingFields.includes('applicable_when'));
});

test('verifyFrontmatter11Fields: AC-3 trigger_keywords as string → typeError', () => {
  const md = buildValidLessonMarkdown({ trigger_keywords: 'not-an-array' });
  const result = verifyFrontmatter11Fields(md);
  assert.equal(result.valid, false);
  assert.ok(result.typeErrors.some((e) => e.includes('trigger_keywords')));
});

test('verifyFrontmatter11Fields: AC-4 empty applicable_when string → WARN (valid stays true)', () => {
  const md = buildValidLessonMarkdown({ applicable_when: '""' }); // serialized as quoted empty
  const result = verifyFrontmatter11Fields(md);
  assert.equal(result.valid, true);
  assert.ok(result.emptyFields.includes('applicable_when'));
});

test('verifyFrontmatter11Fields: AC-7 unterminated frontmatter → parse_error', () => {
  const broken = '---\nid: x\ntype: lesson\n';
  const result = verifyFrontmatter11Fields(broken);
  assert.equal(result.valid, false);
  assert.ok(result.missingFields.includes('<parse_error>'));
});

test('verifyFrontmatter11Fields: importance out of range → typeError', () => {
  const md = buildValidLessonMarkdown({ importance: 99 });
  const result = verifyFrontmatter11Fields(md);
  assert.equal(result.valid, false);
  assert.ok(result.typeErrors.some((e) => e.includes('importance')));
});

// ── checkpoint / rollback ─────────────────────────────────────────

test('captureCheckpoint + rollbackLesson restore byte-level identity', () => {
  const dir = tempDir();
  const lessonPath = path.join(dir, 'lesson.md');
  const original = buildValidLessonMarkdown();
  fs.writeFileSync(lessonPath, original);

  const checkpoint = captureCheckpoint(lessonPath, 'lesson-001');
  assert.equal(checkpoint.originalHash.length, 64); // SHA-256 hex full
  assert.equal(checkpoint.lessonId, 'lesson-001');

  // simulate corruption
  fs.writeFileSync(lessonPath, 'CORRUPT');
  assert.equal(fs.readFileSync(lessonPath, 'utf8'), 'CORRUPT');

  const rollback = rollbackLesson(checkpoint, 'verify_fail');
  assert.equal(rollback.ok, true);
  assert.equal(rollback.hashMatch, true);
  assert.equal(rollback.expectedHash, checkpoint.originalHash);
  assert.equal(fs.readFileSync(lessonPath, 'utf8'), original);

  fs.rmSync(dir, { recursive: true, force: true });
});

// ── full safeguard wrapper ────────────────────────────────────────

test('AC-1: applyEvolutionWithSafeguard succeeds on valid evolution', () => {
  const dir = tempDir();
  const lessonPath = path.join(dir, 'lesson.md');
  const md = buildValidLessonMarkdown();
  fs.writeFileSync(lessonPath, md);

  const neighbor = {
    id: 'lesson-001',
    tokens: ['hook', 'capture'],
    evolved_at: [],
    updated_at: '2026-01-01T00:00:00Z'
  };
  const proposal = proposeEvolution({ id: 'lesson-new' }, neighbor, '2026-05-07T00:00:00Z');

  // persistLesson is a no-op (file already valid). Safeguard re-reads file.
  const result = applyEvolutionWithSafeguard(neighbor, proposal, lessonPath, {
    persistLesson: () => {}
  });

  assert.equal(result.ok, true);
  assert.equal(result.evolved, true);
  assert.equal(result.verifyResult.valid, true);
  assert.equal(result.rollbackResult, null);
  assert.equal(result.reflectionDraftPath, null);
  // in-memory neighbor should have been mutated by applyEvolution
  assert.equal(neighbor.evolved_at.length, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('AC-2: missing field after persist → FAIL, rollback, reflection draft invoked', () => {
  const dir = tempDir();
  const lessonPath = path.join(dir, 'lesson.md');
  const original = buildValidLessonMarkdown();
  fs.writeFileSync(lessonPath, original);

  const neighbor = { id: 'lesson-001', tokens: ['hook'], evolved_at: [] };
  const proposal = proposeEvolution({ id: 'lesson-new' }, neighbor, '2026-05-07T00:00:00Z');

  const events = [];
  let draftCalls = 0;

  const result = applyEvolutionWithSafeguard(neighbor, proposal, lessonPath, {
    persistLesson: () => {
      // simulate buggy serializer dropping `applicable_when`
      const corrupted = buildValidLessonMarkdown({ applicable_when: undefined });
      fs.writeFileSync(lessonPath, corrupted);
    },
    onEvent: (eventType, payload) => events.push({ eventType, payload }),
    buildReflectionDraft: (input) => {
      draftCalls += 1;
      assert.ok(input.failures[0].eventType === 'verification_failed');
      return { id: 'reflection-x', title: input.title, status: 'draft' };
    },
    writeReflectionDraft: () => '08_Reflections/Drafts/2026-05-07_evolution-rollback-lesson-001.md'
  });

  assert.equal(result.ok, false);
  assert.equal(result.evolved, false);
  assert.equal(result.verifyResult.valid, false);
  assert.ok(result.verifyResult.missingFields.includes('applicable_when'));
  assert.ok(result.rollbackResult);
  assert.equal(result.rollbackResult.ok, true);
  assert.equal(result.rollbackResult.hashMatch, true);
  assert.equal(result.reflectionDraftPath, '08_Reflections/Drafts/2026-05-07_evolution-rollback-lesson-001.md');
  assert.equal(draftCalls, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'frontmatter_fail');
  // rollback restored byte-level
  assert.equal(fs.readFileSync(lessonPath, 'utf8'), original);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('AC-3: type mismatch after persist → FAIL, rollback', () => {
  const dir = tempDir();
  const lessonPath = path.join(dir, 'lesson.md');
  const original = buildValidLessonMarkdown();
  fs.writeFileSync(lessonPath, original);

  const neighbor = { id: 'lesson-001', tokens: ['hook'], evolved_at: [] };
  const proposal = proposeEvolution({ id: 'lesson-new' }, neighbor, '2026-05-07T00:00:00Z');

  const result = applyEvolutionWithSafeguard(neighbor, proposal, lessonPath, {
    persistLesson: () => {
      // serializer turns array into string
      const corrupted = buildValidLessonMarkdown({ trigger_keywords: 'foo,bar' });
      fs.writeFileSync(lessonPath, corrupted);
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.verifyResult.valid, false);
  assert.ok(result.verifyResult.typeErrors.some((e) => e.includes('trigger_keywords')));
  assert.equal(result.rollbackResult.ok, true);
  assert.equal(fs.readFileSync(lessonPath, 'utf8'), original);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('AC-4: empty applicable_when after persist → WARN, no rollback', () => {
  const dir = tempDir();
  const lessonPath = path.join(dir, 'lesson.md');
  fs.writeFileSync(lessonPath, buildValidLessonMarkdown());

  const neighbor = { id: 'lesson-001', tokens: ['hook'], evolved_at: [] };
  const proposal = proposeEvolution({ id: 'lesson-new' }, neighbor, '2026-05-07T00:00:00Z');

  const events = [];
  const result = applyEvolutionWithSafeguard(neighbor, proposal, lessonPath, {
    persistLesson: () => {
      // applicable_when becomes empty string — CD-M5 backward-compat
      const md = buildValidLessonMarkdown({ applicable_when: '""' });
      fs.writeFileSync(lessonPath, md);
    },
    onEvent: (eventType, payload) => events.push({ eventType, payload })
  });

  assert.equal(result.ok, true);
  assert.equal(result.verifyResult.valid, true);
  assert.ok(result.verifyResult.emptyFields.includes('applicable_when'));
  assert.equal(result.rollbackResult, null);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'frontmatter_warn');
  assert.deepEqual(events[0].payload.emptyFields, ['applicable_when']);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('AC-5: missing lessonPath skips checkpoint cleanly (process-kill analog)', () => {
  // §4-B (a) memory-variable limitation — we cannot simulate true mid-process
  // kill without forking. Instead we exercise the missing-path bypass which
  // mirrors the post-kill "no checkpoint to verify" state.
  const neighbor = { id: 'lesson-001', tokens: [], evolved_at: [] };
  const proposal = proposeEvolution({ id: 'lesson-new' }, neighbor, '2026-05-07T00:00:00Z');
  const result = applyEvolutionWithSafeguard(neighbor, proposal, '', {
    persistLesson: () => {}
  });
  assert.equal(result.ok, false);
  assert.equal(result.evolved, false);
  assert.deepEqual(result.verifyResult.missingFields, ['<no_lesson_path>']);
});

test('AC-6: external mutation between checkpoint and verify → FAIL, rollback restores original', () => {
  const dir = tempDir();
  const lessonPath = path.join(dir, 'lesson.md');
  const original = buildValidLessonMarkdown();
  fs.writeFileSync(lessonPath, original);

  const neighbor = { id: 'lesson-001', tokens: ['hook'], evolved_at: [] };
  const proposal = proposeEvolution({ id: 'lesson-new' }, neighbor, '2026-05-07T00:00:00Z');

  const result = applyEvolutionWithSafeguard(neighbor, proposal, lessonPath, {
    persistLesson: () => {
      // External tool mid-corrupts the file: write a totally different doc.
      fs.writeFileSync(lessonPath, '---\n---\n# truncated');
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.verifyResult.valid, false);
  // rollback restored the byte-level original
  assert.equal(result.rollbackResult.ok, true);
  assert.equal(result.rollbackResult.hashMatch, true);
  assert.equal(fs.readFileSync(lessonPath, 'utf8'), original);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('AC-7: parser throw (unterminated frontmatter after persist) → FAIL, rollback', () => {
  const dir = tempDir();
  const lessonPath = path.join(dir, 'lesson.md');
  const original = buildValidLessonMarkdown();
  fs.writeFileSync(lessonPath, original);

  const neighbor = { id: 'lesson-001', tokens: ['hook'], evolved_at: [] };
  const proposal = proposeEvolution({ id: 'lesson-new' }, neighbor, '2026-05-07T00:00:00Z');

  const result = applyEvolutionWithSafeguard(neighbor, proposal, lessonPath, {
    persistLesson: () => {
      // malformed: missing closing ---
      fs.writeFileSync(lessonPath, '---\nid: lesson-001\ntype: lesson\n# no closing');
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.verifyResult.valid, false);
  assert.ok(result.verifyResult.missingFields.includes('<parse_error>'));
  assert.equal(result.rollbackResult.ok, true);
  assert.equal(fs.readFileSync(lessonPath, 'utf8'), original);

  fs.rmSync(dir, { recursive: true, force: true });
});
