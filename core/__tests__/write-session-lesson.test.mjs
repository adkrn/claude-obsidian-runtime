import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeSessionLesson } from '../learning-curate.mjs';
import { ensureRuntimeLayout, getRuntimePaths, loadJsonl } from '../runtime-lib.mjs';

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-write-'));
  ensureRuntimeLayout(dir);
  return dir;
}

function writeTask(dir, task) {
  const paths = getRuntimePaths(dir);
  fs.mkdirSync(paths.tasksRoot, { recursive: true });
  fs.writeFileSync(path.join(paths.tasksRoot, `${task.taskId}.json`), JSON.stringify(task));
}

function makeTask(overrides = {}) {
  return {
    taskId: '20260625-1200-test',
    title: '멀티씬 스킵 흐름 안정화',
    prompt: 'StandDoor 직접 스킵 시 씬 전환 안 됨',
    matchedScopes: ['unity'],
    files: ['Assets/Scripts/SceneFlowController.cs'],
    verifications: [],
    createdAt: '2026-06-25T10:00:00.000Z',
    updatedAt: '2026-06-25T12:00:00.000Z',
    ...overrides
  };
}

function captureVault() {
  const written = [];
  return {
    written,
    config: {
      loadObsidianConfig: () => ({ vaultRoot: '', vaultAvailable: false }),
      writeVaultArtifact: (params) => {
        written.push(params);
        return { storage: 'local', path: params.relativePath };
      },
      projectTag: 'testproj',
      scopeFolderMap: {}
    }
  };
}

const goodLesson = {
  summary: 'additive 멀티씬에서 SceneManager.GetActiveScene() 으로 Lobby 판정 시 NullReference — active scene 이 항상 AppBootstrap 이라 신뢰 불가',
  rules: ['멀티씬 로딩 환경에서 active scene 이름 비교로 씬 판정하지 말 것 — 명시적 로드 상태를 추적하라'],
  applicable_when: { language: ['csharp'], kind: ['unity'], task_type: ['debug'], scope_id: 'unity' },
  trigger_keywords: ['멀티씬', 'scene', 'skip', 'nullreference'],
  relatedFiles: ['Assets/Scripts/SceneFlowController.cs'],
  importance: 8,
  confidence: 'high'
};

describe('writeSessionLesson (D-23)', () => {
  it('returns task_not_found when no task record', () => {
    const dir = sandbox();
    const r = writeSessionLesson(dir, { taskId: 'missing', lesson: goodLesson }, captureVault().config);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'task_not_found');
  });

  it('rejects lesson without summary', () => {
    const dir = sandbox();
    writeTask(dir, makeTask());
    const r = writeSessionLesson(dir, { taskId: '20260625-1200-test', lesson: { rules: [] } }, captureVault().config);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid_lesson');
  });

  it('create: publishes active session-authored lesson to vault + jsonl', () => {
    const dir = sandbox();
    writeTask(dir, makeTask());
    const v = captureVault();
    const r = writeSessionLesson(dir, { taskId: '20260625-1200-test', mode: 'create', lesson: goodLesson }, v.config);

    assert.equal(r.ok, true);
    assert.equal(r.action, 'create');
    assert.equal(r.artifact.kind, 'lesson');
    // vault 문서에 세션이 쓴 summary 가 들어가야 함 (보일러플레이트 아님)
    assert.equal(v.written.length, 1);
    const doc = v.written[0].content;
    assert.ok(doc.includes('SceneManager.GetActiveScene'));
    assert.ok(!doc.includes('Captured reusable workflow'));
    // 세션작성 lesson 은 바로 active + session-claude (D-26)
    assert.ok(doc.includes('status: active'));
    assert.ok(doc.includes('generated_by: session-claude'));
    // 세션 rules 에 legacy 휴리스틱 보일러플레이트(buildLessonRules)가 섞이지 않아야 함
    // (D-23 "보일러플레이트 0" — override 경로는 세션이 쓴 rules 만)
    assert.ok(!doc.includes('read read_first notes'));
    assert.ok(!doc.includes('Carry at least one successful verification command'));

    // jsonl 인덱스에도 기록
    const rows = loadJsonl(path.join(getRuntimePaths(dir).knowledgeRoot, 'lessons.jsonl'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'lesson');
    assert.ok(rows[0].summary.includes('NullReference'));
    assert.deepEqual(rows[0].applicable_when.language, ['csharp']);
  });

  it('carries session importance/rules into the stored row', () => {
    const dir = sandbox();
    writeTask(dir, makeTask());
    const v = captureVault();
    writeSessionLesson(dir, { taskId: '20260625-1200-test', lesson: goodLesson }, v.config);
    const rows = loadJsonl(path.join(getRuntimePaths(dir).knowledgeRoot, 'lessons.jsonl'));
    assert.ok(rows[0].rules.some((rule) => rule.includes('active scene')));
  });

  it('persists session importance/confidence into the jsonl row (scoreItem reads item.importance)', () => {
    const dir = sandbox();
    writeTask(dir, makeTask());
    const v = captureVault();
    writeSessionLesson(dir, { taskId: '20260625-1200-test', mode: 'create', lesson: goodLesson }, v.config);
    const rows = loadJsonl(path.join(getRuntimePaths(dir).knowledgeRoot, 'lessons.jsonl'));
    // goodLesson has importance:8, confidence:'high' — they must reach the row,
    // otherwise importanceScore(undefined)=0 silently kills the importance axis.
    assert.equal(rows[0].importance, 8, 'session importance must reach the row');
    assert.equal(rows[0].confidence, 'high', 'session confidence must reach the row');
  });

  it('defaults importance/confidence sensibly when the session omits them', () => {
    const dir = sandbox();
    writeTask(dir, makeTask());
    const v = captureVault();
    const { importance, confidence, ...noRank } = goodLesson;
    writeSessionLesson(dir, { taskId: '20260625-1200-test', mode: 'create', lesson: noRank }, v.config);
    const rows = loadJsonl(path.join(getRuntimePaths(dir).knowledgeRoot, 'lessons.jsonl'));
    // Missing importance must not become undefined (→ importanceScore 0). A mid default keeps the axis alive.
    assert.equal(typeof rows[0].importance, 'number');
    assert.ok(rows[0].importance >= 1 && rows[0].importance <= 10);
  });

  it('does not mix legacy heuristic rules into session-authored lesson (D-23 보일러플레이트 0)', () => {
    const dir = sandbox();
    // guardrails + 성공 verification 을 심어 legacy rule(buildLessonRules)이 생성될 조건을 만든다.
    writeTask(dir, makeTask({
      guardrails: ['read read_first notes before writing a plan'],
      verifications: [{ command: 'dotnet build', success: true, summary: 'ok' }]
    }));
    const v = captureVault();
    writeSessionLesson(dir, { taskId: '20260625-1200-test', mode: 'create', lesson: goodLesson }, v.config);

    const doc = v.written[0].content;
    // 세션이 쓴 rule 은 들어가고, legacy 휴리스틱/guardrail 은 안 섞여야 함
    assert.ok(doc.includes('active scene'), '세션 rule 보존');
    assert.ok(!doc.includes('read read_first notes'), 'guardrail 휴리스틱 미혼입');
    assert.ok(!doc.includes('Carry at least one successful verification'), 'verification 휴리스틱 미혼입');

    const rows = loadJsonl(path.join(getRuntimePaths(dir).knowledgeRoot, 'lessons.jsonl'));
    assert.ok(!rows[0].rules.some((r) => r.includes('read read_first notes')));
  });

  it('update: replaces same id (전체 재작성), jsonl upserts not duplicates', () => {
    const dir = sandbox();
    writeTask(dir, makeTask());
    const v = captureVault();
    const created = writeSessionLesson(dir, {
      taskId: '20260625-1200-test', mode: 'create', lesson: goodLesson
    }, v.config);
    const existingId = created.artifact.id;

    const updated = writeSessionLesson(dir, {
      taskId: '20260625-1200-test', mode: 'update',
      lesson: { ...goodLesson, id: existingId, summary: '보완: 멀티씬 판정은 로드 상태 추적 + 명시적  active scene 가드' }
    }, v.config);

    assert.equal(updated.ok, true);
    assert.equal(updated.action, 'update');
    assert.equal(updated.artifact.id, existingId, '같은 id 유지');

    // jsonl 은 같은 id 라 1행만 (중복 아님)
    const rows = loadJsonl(path.join(getRuntimePaths(dir).knowledgeRoot, 'lessons.jsonl'));
    assert.equal(rows.length, 1);
    assert.ok(rows[0].summary.includes('보완'));
  });
});
