/**
 * Regression: orphan pointer GC must catch fallback-session pointers and
 * 'completed' tasks. Prior behavior had two bugs (CardGame field audit):
 *   1. POINTER_REGEX matched hex/UUID session ids only, so
 *      current-task-fallback-<base36>-<rand>.json files (created whenever
 *      CLAUDE_SESSION_ID is missing) accumulated forever — 15 observed.
 *   2. isTaskClosed only recognized 'closed'/'done', but session-end writes
 *      'completed' — so even matching pointers were treated as still-open.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { gcOrphanPointers } from '../pointer-gc.mjs';

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pointer-gc-'));
  fs.mkdirSync(path.join(dir, '.claude', 'runtime', 'tasks'), { recursive: true });
  return dir;
}

function seedPointer(projectDir, sessionId, taskId, taskStatus) {
  const runtimeDir = path.join(projectDir, '.claude', 'runtime');
  fs.writeFileSync(
    path.join(runtimeDir, `current-task-${sessionId}.json`),
    JSON.stringify({ taskId })
  );
  fs.writeFileSync(
    path.join(runtimeDir, 'tasks', `${taskId}.json`),
    JSON.stringify({ taskId, status: taskStatus })
  );
}

// 미래 now 를 주입해 mtime 을 조작하지 않고도 "7일 이상 묵은" 조건을 만든다.
const FUTURE_NOW = () => new Date(Date.now() + 30 * 86400000);

describe('pointer-gc orphan cleanup (regression)', () => {
  let projectDir;

  beforeEach(() => { projectDir = makeProject(); });
  afterEach(() => { fs.rmSync(projectDir, { recursive: true, force: true }); });

  it('archives fallback-session pointers whose task is completed', () => {
    seedPointer(projectDir, 'fallback-mreorke1-mt26o4', 't1', 'completed');

    const result = gcOrphanPointers(projectDir, { now: FUTURE_NOW() });

    assert.deepEqual(result.archived, ['current-task-fallback-mreorke1-mt26o4.json']);
    assert.ok(
      fs.existsSync(path.join(
        projectDir, '.claude', 'runtime', 'archive', 'orphan-pointers'
      )),
      'archived pointer must be moved under archive/orphan-pointers'
    );
  });

  it("treats 'completed' (session-end close status) as closed for UUID pointers", () => {
    seedPointer(projectDir, '47d71d0e-34f9-47c3-bb15-15aaee592a59', 't2', 'completed');

    const result = gcOrphanPointers(projectDir, { now: FUTURE_NOW() });

    assert.deepEqual(result.archived, ['current-task-47d71d0e-34f9-47c3-bb15-15aaee592a59.json']);
  });

  it('keeps pointers whose task is still active', () => {
    seedPointer(projectDir, 'fallback-aaaa1111-bbb222', 't3', 'active');

    const result = gcOrphanPointers(projectDir, { now: FUTURE_NOW() });

    assert.deepEqual(result.archived, []);
    assert.deepEqual(result.kept, ['current-task-fallback-aaaa1111-bbb222.json']);
  });

  it('never touches the active session pointer', () => {
    seedPointer(projectDir, 'fallback-current-session', 't4', 'completed');

    const result = gcOrphanPointers(projectDir, {
      now: FUTURE_NOW(),
      activeSessionId: 'fallback-current-session'
    });

    assert.deepEqual(result.archived, []);
    assert.deepEqual(result.kept, ['current-task-fallback-current-session.json']);
  });
});
