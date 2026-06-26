import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeSessionDecision, listSessionArtifacts } from '../learning-curate.mjs';
import { ensureRuntimeLayout, getRuntimePaths, loadJsonl } from '../runtime-lib.mjs';

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-write-'));
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
    taskId: '20260625-1500-dec',
    title: 'VR 조종 토글 인스펙터 노출',
    prompt: 'VR 조종 활성/비활성 플래그를 인스펙터로',
    matchedScopes: ['unity'],
    files: ['Assets/Scripts/AresHardwareParagliderController.cs'],
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

const goodDecision = {
  statement: 'VR-only 조종 토글은 컨트롤러의 [SerializeField] bool 로 두고 SampleRiserInput() 출력단에서 게이트한다',
  why: [
    'VRHandRiserInput 은 new 로 생성돼 인스펙터 노출이 안 되므로, 입력 source 가 아니라 컨트롤러가 게이트하는 게 정석',
    'setter 가 아닌 출력단 게이트라야 조종 중 토글해도 캐시 잔존 없이 즉시 직진 전환'
  ],
  relatedFiles: ['Assets/Scripts/AresHardwareParagliderController.cs'],
  scope: 'unity'
};

describe('writeSessionDecision (D-25)', () => {
  it('returns task_not_found when no task record', () => {
    const dir = sandbox();
    const r = writeSessionDecision(dir, { taskId: 'missing', decision: goodDecision }, captureVault().config);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'task_not_found');
  });

  it('rejects decision without statement', () => {
    const dir = sandbox();
    writeTask(dir, makeTask());
    const r = writeSessionDecision(dir, { taskId: '20260625-1500-dec', decision: { why: [] } }, captureVault().config);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid_decision');
  });

  it('create: publishes active decision with session statement (no boilerplate)', () => {
    const dir = sandbox();
    writeTask(dir, makeTask());
    const v = captureVault();
    const r = writeSessionDecision(dir, {
      taskId: '20260625-1500-dec', mode: 'create', decision: goodDecision
    }, v.config);

    assert.equal(r.ok, true);
    assert.equal(r.action, 'create');
    assert.equal(r.artifact.kind, 'decision');

    // vault 문서: 세션 statement + active, 고정문장 없음
    assert.equal(v.written.length, 1);
    const doc = v.written[0].content;
    assert.ok(doc.includes('SampleRiserInput'));
    assert.ok(doc.includes('status: active'));
    assert.ok(doc.includes('generated_by: session-claude'));
    assert.ok(!doc.includes('Keep runtime memory in compact'));
    assert.ok(!doc.includes('Document architecture and workflow changes'));

    // jsonl row
    const rows = loadJsonl(path.join(getRuntimePaths(dir).knowledgeRoot, 'decisions.jsonl'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'decision');
    assert.ok(rows[0].summary.includes('게이트'));
    assert.ok(rows[0].rules.some((w) => w.includes('출력단 게이트')));
  });

  it('update: replaces same id (전체 재작성), jsonl upserts not duplicates', () => {
    const dir = sandbox();
    writeTask(dir, makeTask());
    const v = captureVault();
    const created = writeSessionDecision(dir, {
      taskId: '20260625-1500-dec', mode: 'create', decision: goodDecision
    }, v.config);
    const existingId = created.artifact.id;

    const updated = writeSessionDecision(dir, {
      taskId: '20260625-1500-dec', mode: 'update',
      decision: { ...goodDecision, id: existingId, statement: '보완: 토글은 출력단 게이트 + Inspector override 우선순위 명시' }
    }, v.config);

    assert.equal(updated.ok, true);
    assert.equal(updated.action, 'update');
    assert.equal(updated.artifact.id, existingId, '같은 id 유지');

    // jsonl 은 같은 id 라 1행만 (중복 아님)
    const rows = loadJsonl(path.join(getRuntimePaths(dir).knowledgeRoot, 'decisions.jsonl'));
    assert.equal(rows.length, 1);
    assert.ok(rows[0].summary.includes('보완'));
  });

  it('scope override is honored', () => {
    const dir = sandbox();
    writeTask(dir, makeTask());
    const v = captureVault();
    const r = writeSessionDecision(dir, {
      taskId: '20260625-1500-dec', mode: 'create',
      decision: { ...goodDecision, scope: 'backend' }
    }, v.config);
    assert.equal(r.ok, true);
    const rows = loadJsonl(path.join(getRuntimePaths(dir).knowledgeRoot, 'decisions.jsonl'));
    assert.equal(rows[0].scope, 'backend');
  });

  it('persists session-provided trigger_keywords and applicable_when into the jsonl row (G1)', () => {
    const dir = sandbox();
    writeTask(dir, makeTask());
    const v = captureVault();
    const r = writeSessionDecision(dir, {
      taskId: '20260625-1500-dec', mode: 'create',
      decision: {
        ...goodDecision,
        trigger_keywords: ['VR', '조종', '토글', 'SerializeField', 'SampleRiserInput'],
        applicable_when: { language: ['csharp'], kind: ['decision'], task_type: ['design'], scope_id: 'unity' }
      }
    }, v.config);

    assert.equal(r.ok, true);
    const rows = loadJsonl(path.join(getRuntimePaths(dir).knowledgeRoot, 'decisions.jsonl'));
    assert.equal(rows.length, 1);
    // these were dropped before — the row must now carry the search signals.
    assert.deepEqual(rows[0].trigger_keywords, ['VR', '조종', '토글', 'SerializeField', 'SampleRiserInput']);
    assert.equal(rows[0].applicable_when.language[0], 'csharp');
    assert.equal(rows[0].applicable_when.scope_id, 'unity');
  });

  it('defaults trigger_keywords to [] and applicable_when to {} when omitted (back-compat)', () => {
    const dir = sandbox();
    writeTask(dir, makeTask());
    const v = captureVault();
    const r = writeSessionDecision(dir, {
      taskId: '20260625-1500-dec', mode: 'create', decision: goodDecision
    }, v.config);
    assert.equal(r.ok, true);
    const rows = loadJsonl(path.join(getRuntimePaths(dir).knowledgeRoot, 'decisions.jsonl'));
    assert.deepEqual(rows[0].trigger_keywords, []);
    assert.deepEqual(rows[0].applicable_when, {});
  });
});

describe('listSessionArtifacts (D-25)', () => {
  it('returns empty for no decisions', () => {
    const dir = sandbox();
    assert.deepEqual(listSessionArtifacts(dir, 'decision'), []);
  });

  it('lists created decisions with id/title/summary/scope', () => {
    const dir = sandbox();
    writeTask(dir, makeTask());
    writeSessionDecision(dir, {
      taskId: '20260625-1500-dec', mode: 'create', decision: goodDecision
    }, captureVault().config);

    const items = listSessionArtifacts(dir, 'decision');
    assert.equal(items.length, 1);
    assert.ok(items[0].id);
    assert.ok(items[0].title.startsWith('Decision -'));
    assert.ok(items[0].summary.length > 0);
    assert.equal(items[0].scope, 'unity');
  });

  it('returns empty for unknown kind', () => {
    const dir = sandbox();
    assert.deepEqual(listSessionArtifacts(dir, 'nonsense'), []);
  });
});
