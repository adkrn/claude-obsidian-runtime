import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTriggerKeywords } from '../lesson-extractor.mjs';

// Root-cause guard: buildTriggerKeywords must not emit boilerplate-derived
// tokens or Korean command verbs — those polluted 21% of real trigger_keywords
// (read/read_first/before/notes/writing/plan, 구현해줘/시작해/명세대로 ...).

test('buildTriggerKeywords drops the boilerplate guardrail tokens', () => {
  const text = 'read read_first notes before writing a plan 하드웨어 회전 구현';
  const kw = buildTriggerKeywords(text, []);
  for (const bad of ['read', 'read_first', 'before', 'notes', 'writing', 'plan']) {
    assert.ok(!kw.includes(bad), `boilerplate token leaked: ${bad}`);
  }
});

test('buildTriggerKeywords drops Korean command verbs / fillers', () => {
  const text = '구현해줘 시작해 명세대로 작성해줘 지금 바로 ParticipantManager 좌석 배치';
  const kw = buildTriggerKeywords(text, []);
  for (const bad of ['구현해줘', '시작해', '명세대로', '작성해줘', '지금', '바로']) {
    assert.ok(!kw.includes(bad), `command verb leaked: ${bad}`);
  }
});

test('buildTriggerKeywords keeps real domain / code terms', () => {
  const text = 'ParticipantManager 좌석 착석 하드웨어 회전 riser 조종';
  const kw = buildTriggerKeywords(text, ['ParticipantManager.cs', 'RiserInput.cs']);
  // domain words survive
  assert.ok(kw.includes('participantmanager') || kw.includes('participantmanager.cs') ||
    kw.some((k) => k.toLowerCase().includes('participantmanager')), 'domain term dropped');
  assert.ok(kw.includes('하드웨어'), '하드웨어 dropped');
  assert.ok(kw.includes('riser'), 'riser dropped');
});

test('buildTriggerKeywords drops pure numbers and sub-2-char', () => {
  const kw = buildTriggerKeywords('100 a 하드웨어', []);
  assert.ok(!kw.includes('100'));
  assert.ok(!kw.includes('a'));
  assert.ok(kw.includes('하드웨어'));
});
