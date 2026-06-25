import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeSessionTroubleshooting, listSessionArtifacts } from '../learning-curate.mjs';
import { ensureRuntimeLayout, getRuntimePaths, loadJsonl } from '../runtime-lib.mjs';

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trouble-write-'));
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
    taskId: '20260625-1500-trb',
    title: 'VR 씬 전환 시 입력 잠금 해제 안 됨',
    prompt: 'StandDoor 스킵 후 다음 씬에서 컨트롤러 입력이 죽음',
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

const goodTrouble = {
  symptom: 'StandDoor 직접 스킵 시 다음 씬에서 InputActionMap 이 비활성 상태로 남아 컨트롤러 입력이 죽음',
  cause: '스킵 경로가 SceneFlowController.OnSceneLoaded 를 우회해 EnableInput() 이 호출되지 않음',
  fix: '스킵 분기에서도 OnSceneLoaded 동등 처리(EnableInput 명시 호출)를 타도록 통합',
  prevention: '씬 진입 후처리는 로드 경로별로 분기하지 말고 단일 진입점(OnSceneReady)으로 수렴시킬 것',
  verification: 'StandDoor 스킵 + 정상 진입 두 경로 모두에서 컨트롤러 입력 살아있음 확인',
  relatedFiles: ['Assets/Scripts/SceneFlowController.cs'],
  scope: 'unity'
};

describe('writeSessionTroubleshooting (D-26)', () => {
  it('returns task_not_found when no task record', () => {
    const dir = sandbox();
    const r = writeSessionTroubleshooting(dir, { taskId: 'missing', troubleshooting: goodTrouble }, captureVault().config);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'task_not_found');
  });

  it('rejects troubleshooting without symptom', () => {
    const dir = sandbox();
    writeTask(dir, makeTask());
    const r = writeSessionTroubleshooting(dir, { taskId: '20260625-1500-trb', troubleshooting: { fix: '...' } }, captureVault().config);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid_troubleshooting');
  });

  it('create: publishes active troubleshooting with session 6 sections (no CURATOR_TODO)', () => {
    const dir = sandbox();
    writeTask(dir, makeTask());
    const v = captureVault();
    const r = writeSessionTroubleshooting(dir, {
      taskId: '20260625-1500-trb', mode: 'create', troubleshooting: goodTrouble
    }, v.config);

    assert.equal(r.ok, true);
    assert.equal(r.action, 'create');
    assert.equal(r.artifact.kind, 'troubleshooting');

    // vault 문서: 세션이 채운 원인/수정/검증 + active, CURATOR_TODO 마커 없음
    assert.equal(v.written.length, 1);
    const doc = v.written[0].content;
    assert.ok(doc.includes('InputActionMap'));
    assert.ok(doc.includes('EnableInput'));
    assert.ok(doc.includes('status: active'));
    assert.ok(doc.includes('generated_by: session-claude'));
    assert.ok(!doc.includes('CURATOR_TODO'));

    // jsonl row
    const rows = loadJsonl(path.join(getRuntimePaths(dir).knowledgeRoot, 'troubleshooting.jsonl'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'troubleshooting');
    assert.ok(rows[0].summary.includes('StandDoor'));
  });

  it('update: replaces same id, jsonl upserts not duplicates', () => {
    const dir = sandbox();
    writeTask(dir, makeTask());
    const v = captureVault();
    const created = writeSessionTroubleshooting(dir, {
      taskId: '20260625-1500-trb', mode: 'create', troubleshooting: goodTrouble
    }, v.config);
    const existingId = created.artifact.id;

    const updated = writeSessionTroubleshooting(dir, {
      taskId: '20260625-1500-trb', mode: 'update',
      troubleshooting: { ...goodTrouble, id: existingId, symptom: '보완: 스킵 + 빠른 재진입 동시 발생 시에도 입력 잠금' }
    }, v.config);

    assert.equal(updated.ok, true);
    assert.equal(updated.action, 'update');
    assert.equal(updated.artifact.id, existingId, '같은 id 유지');

    const rows = loadJsonl(path.join(getRuntimePaths(dir).knowledgeRoot, 'troubleshooting.jsonl'));
    assert.equal(rows.length, 1);
    assert.ok(rows[0].summary.includes('보완'));
  });

  it('scope override is honored', () => {
    const dir = sandbox();
    writeTask(dir, makeTask());
    const v = captureVault();
    const r = writeSessionTroubleshooting(dir, {
      taskId: '20260625-1500-trb', mode: 'create',
      troubleshooting: { ...goodTrouble, scope: 'backend' }
    }, v.config);
    assert.equal(r.ok, true);
    const rows = loadJsonl(path.join(getRuntimePaths(dir).knowledgeRoot, 'troubleshooting.jsonl'));
    assert.equal(rows[0].scope, 'backend');
  });
});

describe('listSessionArtifacts (troubleshooting)', () => {
  it('returns empty for no troubleshooting', () => {
    const dir = sandbox();
    assert.deepEqual(listSessionArtifacts(dir, 'troubleshooting'), []);
  });

  it('lists created troubleshooting with id/title/summary/scope', () => {
    const dir = sandbox();
    writeTask(dir, makeTask());
    writeSessionTroubleshooting(dir, {
      taskId: '20260625-1500-trb', mode: 'create', troubleshooting: goodTrouble
    }, captureVault().config);

    const items = listSessionArtifacts(dir, 'troubleshooting');
    assert.equal(items.length, 1);
    assert.ok(items[0].id);
    assert.ok(items[0].title.startsWith('Troubleshooting -'));
    assert.ok(items[0].summary.length > 0);
    assert.equal(items[0].scope, 'unity');
  });
});
