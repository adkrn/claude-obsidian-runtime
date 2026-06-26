import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeSessionArchitecture, listSessionArtifacts } from '../learning-curate.mjs';
import { ensureRuntimeLayout, getRuntimePaths, loadJsonl } from '../runtime-lib.mjs';

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-write-'));
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
    taskId: '20260625-1500-arc',
    title: '씬 전환 단일 진입점 구조 도입',
    prompt: '로드 경로별 후처리 분기를 OnSceneReady 단일 진입점으로 수렴',
    matchedScopes: ['unity'],
    files: ['Assets/Scripts/SceneFlowController.cs'],
    createdAt: '2026-06-25T14:00:00.000Z',
    updatedAt: '2026-06-25T15:00:00.000Z',
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

const goodArch = {
  summary: '씬 전환 후처리를 로드 경로별로 분기하던 구조를 OnSceneReady 단일 진입점으로 수렴',
  body: [
    '## 컴포넌트',
    '- SceneFlowController: 모든 씬 로드 완료를 OnSceneReady 로 정규화',
    '- InputGate: OnSceneReady 구독, 입력 활성화 책임 단일화',
    '',
    '## 데이터 흐름',
    '- LoadScene → (정상 | 스킵) → OnSceneReady → EnableInput'
  ].join('\n'),
  title: '씬 전환 단일 진입점',
  relatedFiles: ['Assets/Scripts/SceneFlowController.cs'],
  scope: 'unity'
};

describe('writeSessionArchitecture (D-26)', () => {
  it('returns task_not_found when no task record', () => {
    const dir = sandbox();
    const r = writeSessionArchitecture(dir, { taskId: 'missing', architecture: goodArch }, captureVault().config);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'task_not_found');
  });

  it('rejects architecture without summary', () => {
    const dir = sandbox();
    writeTask(dir, makeTask());
    const r = writeSessionArchitecture(dir, { taskId: '20260625-1500-arc', architecture: { body: '...' } }, captureVault().config);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid_architecture');
  });

  it('create: publishes active architecture with session body (full rewrite)', () => {
    const dir = sandbox();
    writeTask(dir, makeTask());
    const v = captureVault();
    const r = writeSessionArchitecture(dir, {
      taskId: '20260625-1500-arc', mode: 'create', architecture: goodArch
    }, v.config);

    assert.equal(r.ok, true);
    assert.equal(r.action, 'create');
    assert.equal(r.artifact.kind, 'architecture');

    // vault 문서: 세션 본문 + active. 04_Architecture/Generated 경로.
    assert.equal(v.written.length, 1);
    const doc = v.written[0].content;
    assert.ok(doc.includes('OnSceneReady'));
    assert.ok(doc.includes('## 데이터 흐름'));
    assert.ok(doc.includes('status: active'));
    assert.ok(doc.includes('generated_by: session-claude'));
    assert.ok(v.written[0].relativePath.startsWith('04_Architecture/Generated/'));

    // jsonl row
    const rows = loadJsonl(path.join(getRuntimePaths(dir).knowledgeRoot, 'architecture.jsonl'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'architecture');
    assert.ok(rows[0].summary.includes('단일 진입점'));
  });

  it('update: replaces same id, jsonl upserts not duplicates', () => {
    const dir = sandbox();
    writeTask(dir, makeTask());
    const v = captureVault();
    const created = writeSessionArchitecture(dir, {
      taskId: '20260625-1500-arc', mode: 'create', architecture: goodArch
    }, v.config);
    const existingId = created.artifact.id;

    const updated = writeSessionArchitecture(dir, {
      taskId: '20260625-1500-arc', mode: 'update',
      architecture: { ...goodArch, id: existingId, summary: '보완: OnSceneReady 에 async 로드 대기 단계 추가' }
    }, v.config);

    assert.equal(updated.ok, true);
    assert.equal(updated.action, 'update');
    assert.equal(updated.artifact.id, existingId, '같은 id 유지');

    const rows = loadJsonl(path.join(getRuntimePaths(dir).knowledgeRoot, 'architecture.jsonl'));
    assert.equal(rows.length, 1);
    assert.ok(rows[0].summary.includes('보완'));
  });

  it('scope override is honored', () => {
    const dir = sandbox();
    writeTask(dir, makeTask());
    const v = captureVault();
    const r = writeSessionArchitecture(dir, {
      taskId: '20260625-1500-arc', mode: 'create',
      architecture: { ...goodArch, scope: 'backend' }
    }, v.config);
    assert.equal(r.ok, true);
    const rows = loadJsonl(path.join(getRuntimePaths(dir).knowledgeRoot, 'architecture.jsonl'));
    assert.equal(rows[0].scope, 'backend');
  });

  it('persists session-provided trigger_keywords and applicable_when into the jsonl row (G1)', () => {
    const dir = sandbox();
    writeTask(dir, makeTask());
    const v = captureVault();
    const r = writeSessionArchitecture(dir, {
      taskId: '20260625-1500-arc', mode: 'create',
      architecture: {
        ...goodArch,
        trigger_keywords: ['씬', '씬전환', 'OnSceneReady', 'SceneFlowController', '진입점'],
        applicable_when: { language: ['csharp'], kind: ['architecture'], task_type: ['design'], scope_id: 'unity' }
      }
    }, v.config);

    assert.equal(r.ok, true);
    const rows = loadJsonl(path.join(getRuntimePaths(dir).knowledgeRoot, 'architecture.jsonl'));
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].trigger_keywords, ['씬', '씬전환', 'OnSceneReady', 'SceneFlowController', '진입점']);
    assert.equal(rows[0].applicable_when.language[0], 'csharp');
    assert.equal(rows[0].applicable_when.scope_id, 'unity');
  });

  it('defaults trigger_keywords to [] and applicable_when to {} when omitted (back-compat)', () => {
    const dir = sandbox();
    writeTask(dir, makeTask());
    const v = captureVault();
    const r = writeSessionArchitecture(dir, {
      taskId: '20260625-1500-arc', mode: 'create', architecture: goodArch
    }, v.config);
    assert.equal(r.ok, true);
    const rows = loadJsonl(path.join(getRuntimePaths(dir).knowledgeRoot, 'architecture.jsonl'));
    assert.deepEqual(rows[0].trigger_keywords, []);
    assert.deepEqual(rows[0].applicable_when, {});
  });
});

describe('listSessionArtifacts (architecture)', () => {
  it('returns empty for no architecture', () => {
    const dir = sandbox();
    assert.deepEqual(listSessionArtifacts(dir, 'architecture'), []);
  });

  it('lists created architecture with id/title/summary/scope', () => {
    const dir = sandbox();
    writeTask(dir, makeTask());
    writeSessionArchitecture(dir, {
      taskId: '20260625-1500-arc', mode: 'create', architecture: goodArch
    }, captureVault().config);

    const items = listSessionArtifacts(dir, 'architecture');
    assert.equal(items.length, 1);
    assert.ok(items[0].id);
    assert.ok(items[0].title.startsWith('Architecture -'));
    assert.ok(items[0].summary.length > 0);
    assert.equal(items[0].scope, 'unity');
  });
});
