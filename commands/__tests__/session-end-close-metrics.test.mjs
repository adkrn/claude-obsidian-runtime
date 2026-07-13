/**
 * Regression: task-close metrics + duplicate-close guard (CardGame field audit).
 *
 * Prior behavior, all observed in production event logs:
 *   1. lessonsCreated/vaultWrites 등 close 지표가 24회 전부 0 — 세션 Claude 가
 *      learn-write 계열 CLI 로 저장한 산출물(D-23/D-25)이 session-end 집계에
 *      반영되지 않았다. 이제 knowledge jsonl 의 sourceTaskId 행을 직접 센다.
 *   2. detail.eventCount 가 태스크 이벤트 수가 아니라 당일 이벤트 파일의 전체
 *      라인 수였다.
 *   3. 이미 completed 인 task 를 다시 닫으면 task_closed 이벤트·worklog 가 이중
 *      생성됐다(실측 2건). 이제 skipped:'already_closed' 로 무해하게 끝난다.
 *   4. sessionId 없는 no-task 종료가 session_ended 이벤트를 남겨 hook 다중
 *      발화 시 폭주했다(실측 11건/40ms). 이제 기록하지 않는다.
 *   5. task-close.mjs 유추 호출이 Cannot find module 로 실패했다 — 별칭 제공.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureRuntimeLayout, getRuntimePaths, writeJsonFile } from '../../core/runtime-lib.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SESSION_END_CLI = path.resolve(__dirname, '..', 'session-end.mjs');
const TASK_CLOSE_CLI = path.resolve(__dirname, '..', 'task-close.mjs');

const TASK_ID = 'task-metrics-1';
const SESSION_ID = 'session-metrics-1';

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-end-metrics-'));
  ensureRuntimeLayout(dir);
  return dir;
}

function seedTask(projectDir) {
  const runtimePaths = getRuntimePaths(projectDir);
  writeJsonFile(path.join(runtimePaths.tasksRoot, `${TASK_ID}.json`), {
    taskId: TASK_ID,
    title: 'close metrics task',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sessionIds: [SESSION_ID],
    matchedScopes: ['repo'],
    files: [],
    verifications: []
  });
}

function seedKnowledgeAndEvents(projectDir) {
  const runtimePaths = getRuntimePaths(projectDir);
  // 이 task 의 산출물 2건(lesson=vault, decision=queue) + 무관 task 의 lesson 1건
  fs.writeFileSync(path.join(runtimePaths.knowledgeRoot, 'lessons.jsonl'), [
    JSON.stringify({ id: 'l1', kind: 'lesson', sourceTaskId: TASK_ID, storage: 'vault', title: 'L1' }),
    JSON.stringify({ id: 'l2', kind: 'lesson', sourceTaskId: 'unrelated-task', storage: 'vault', title: 'L2' })
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(runtimePaths.knowledgeRoot, 'decisions.jsonl'),
    JSON.stringify({ id: 'd1', kind: 'decision', sourceTaskId: TASK_ID, storage: 'queue', title: 'D1' }) + '\n');
  // 이벤트: 이 task 의 task_started 1건 + 무관 이벤트 2건
  const stamp = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(runtimePaths.eventsRoot, `${stamp}.jsonl`), [
    JSON.stringify({ ts: 'x', taskId: TASK_ID, eventType: 'task_started' }),
    JSON.stringify({ ts: 'x', taskId: 'unrelated-task', eventType: 'task_started' }),
    JSON.stringify({ ts: 'x', taskId: '', eventType: 'session_ended' })
  ].join('\n') + '\n');
}

function runCli(cli, projectDir, extraArgs) {
  return spawnSync(
    process.execPath,
    [cli, '--project-dir', projectDir, ...extraArgs],
    {
      encoding: 'utf8',
      // 볼트 누수 방지: OBSIDIAN_VAULT_ROOT 미설정 시 실제 vault 로 폴백한다.
      env: { ...process.env, OBSIDIAN_VAULT_ROOT: path.join(projectDir, '_vault') }
    }
  );
}

function readEventLines(projectDir) {
  const eventsRoot = getRuntimePaths(projectDir).eventsRoot;
  return fs.readdirSync(eventsRoot)
    .filter((n) => n.endsWith('.jsonl'))
    .flatMap((n) => fs.readFileSync(path.join(eventsRoot, n), 'utf8').split('\n'))
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('session-end close metrics (regression)', () => {
  let projectDir;

  beforeEach(() => { projectDir = makeProject(); });
  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(path.join(process.cwd(), '08_Lessons'), { recursive: true, force: true });
    fs.rmSync(path.join(process.cwd(), '10_Worklogs'), { recursive: true, force: true });
  });

  it('counts session-written artifacts (sourceTaskId rows) and task-scoped events', () => {
    seedTask(projectDir);
    seedKnowledgeAndEvents(projectDir);

    const result = runCli(SESSION_END_CLI, projectDir, [
      '--task-id', TASK_ID, '--session-id', SESSION_ID, '--close', '--no-verify'
    ]);
    assert.equal(result.status, 0, `session-end exited ${result.status}: ${result.stderr}`);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.lessonsCreated, 1, 'this task\'s lesson row must be counted');
    assert.equal(payload.artifacts.decision, 1);
    assert.equal(payload.vaultWrites, 1, 'only storage=vault rows count as vault writes');

    const closed = readEventLines(projectDir)
      .filter((e) => e.eventType === 'task_closed' && e.taskId === TASK_ID);
    assert.equal(closed.length, 1);
    assert.equal(closed[0].detail.lessonsCreated, 1);
    assert.equal(closed[0].detail.decisionsCreated, 1);
    // task_started(1) + 이 task_closed(1) = 2 — 무관 이벤트 2건은 세지 않는다.
    assert.equal(closed[0].detail.eventCount, 2);
  });

  it('skips a duplicate close without a second task_closed event', () => {
    seedTask(projectDir);
    seedKnowledgeAndEvents(projectDir);

    const first = runCli(SESSION_END_CLI, projectDir, [
      '--task-id', TASK_ID, '--close', '--no-verify'
    ]);
    assert.equal(first.status, 0, first.stderr);

    const second = runCli(SESSION_END_CLI, projectDir, [
      '--task-id', TASK_ID, '--close', '--no-verify'
    ]);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).skipped, 'already_closed');

    const closed = readEventLines(projectDir)
      .filter((e) => e.eventType === 'task_closed' && e.taskId === TASK_ID);
    assert.equal(closed.length, 1, 'duplicate close must not append another task_closed');
  });

  it('does not log no-task session_ended events when sessionId is empty', () => {
    const result = runCli(SESSION_END_CLI, projectDir, []);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).message, 'no active task');

    const noise = readEventLines(projectDir)
      .filter((e) => e.eventType === 'session_ended' || e.eventType === 'session_end_skipped');
    assert.equal(noise.length, 0, 'empty-session no-task end must not write events');
  });

  it('task-close.mjs is a working alias for session-end --close', () => {
    seedTask(projectDir);

    const result = runCli(TASK_CLOSE_CLI, projectDir, [
      '--task-id', TASK_ID, '--no-verify'
    ]);
    assert.equal(result.status, 0, `task-close exited ${result.status}: ${result.stderr}`);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.taskId, TASK_ID);

    const taskPath = path.join(getRuntimePaths(projectDir).tasksRoot, `${TASK_ID}.json`);
    const record = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
    assert.equal(record.status, 'completed', 'alias must actually close the task');
  });
});
