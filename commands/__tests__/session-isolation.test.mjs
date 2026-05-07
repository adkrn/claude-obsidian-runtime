import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SESSION_END_CLI = path.resolve(__dirname, '..', 'session-end.mjs');

import {
  ensureRuntimeLayout,
  getRuntimePaths,
  loadCurrentTaskPointer,
  loadSessionTaskPointer,
  toTaskPointer,
  writeJsonFile,
  writeSessionTaskPointer
} from '../../core/runtime-lib.mjs';
import { buildRuntimeSessionStartContext } from '../session-start.mjs';
import { checkpointRuntimeTask } from '../stop.mjs';

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-isolation-'));
  ensureRuntimeLayout(dir);
  return dir;
}

function seedTaskOwnedBy(projectDir, sessionId, taskId = 'task-A') {
  const runtimePaths = getRuntimePaths(projectDir);
  const taskPath = path.join(runtimePaths.tasksRoot, `${taskId}.json`);
  const taskRecord = {
    taskId,
    title: `Owned by ${sessionId}`,
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sessionIds: [sessionId],
    matchedScopes: ['repo']
  };
  writeJsonFile(taskPath, taskRecord);
  writeJsonFile(
    runtimePaths.currentTaskPath,
    toTaskPointer(taskRecord, taskPath, runtimePaths.lastContextPath)
  );
  writeSessionTaskPointer(
    projectDir,
    sessionId,
    toTaskPointer(taskRecord, taskPath, runtimePaths.lastContextPath)
  );
  return { taskPath, taskRecord };
}

describe('SessionStart isolation', () => {
  let projectDir;

  beforeEach(() => { projectDir = makeProject(); });
  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    // session-end CLI runs with the package root as cwd, so curate-driven
    // writes for tasks scoped to "repo" can land in `<cwd>/08_Lessons/Repo/`.
    // Sweep that directory after every test so subsequent suites (and S4
    // sessions) start clean. The package itself has no real 08_Lessons
    // tree at cwd — the runtime's lesson root is `templates/vault/08_Lessons`.
    fs.rmSync(path.join(process.cwd(), '08_Lessons'), { recursive: true, force: true });
  });

  it('does not attach an unrelated session to the global active task', () => {
    const sessionA = 'session-A';
    const sessionB = 'session-B';
    const { taskPath } = seedTaskOwnedBy(projectDir, sessionA);

    buildRuntimeSessionStartContext(projectDir, { session_id: sessionB });

    const taskAfter = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
    assert.deepEqual(
      taskAfter.sessionIds,
      [sessionA],
      'sessionIds must not be polluted by an unrelated session'
    );
    assert.equal(
      loadSessionTaskPointer(projectDir, sessionB),
      null,
      'session B must not get a pointer to session A\'s task'
    );
  });

  it('refreshes timeline only for the owning session', () => {
    const sessionA = 'session-A';
    const { taskPath } = seedTaskOwnedBy(projectDir, sessionA);

    buildRuntimeSessionStartContext(projectDir, { session_id: sessionA });

    const taskAfter = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
    assert.deepEqual(taskAfter.sessionIds, [sessionA]);
    assert.ok(
      Array.isArray(taskAfter.sessionTimeline) && taskAfter.sessionTimeline.length === 1,
      'owning session must update its own timeline entry'
    );
  });
});

describe('Stop hook isolation', () => {
  let projectDir;

  beforeEach(() => { projectDir = makeProject(); });
  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    // session-end CLI runs with the package root as cwd, so curate-driven
    // writes for tasks scoped to "repo" can land in `<cwd>/08_Lessons/Repo/`.
    // Sweep that directory after every test so subsequent suites (and S4
    // sessions) start clean. The package itself has no real 08_Lessons
    // tree at cwd — the runtime's lesson root is `templates/vault/08_Lessons`.
    fs.rmSync(path.join(process.cwd(), '08_Lessons'), { recursive: true, force: true });
  });

  it('does not push a foreign sessionId into the task when only the global pointer matches', () => {
    const sessionA = 'session-A';
    const sessionB = 'session-B';
    const { taskPath } = seedTaskOwnedBy(projectDir, sessionA);

    const result = checkpointRuntimeTask(projectDir, { session_id: sessionB });
    assert.equal(result.ok, true);
    assert.equal(result.ownsTask, false);

    const taskAfter = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
    assert.deepEqual(
      taskAfter.sessionIds,
      [sessionA],
      'Stop hook from a non-owning session must not append to sessionIds'
    );
    assert.equal(
      loadSessionTaskPointer(projectDir, sessionB),
      null,
      'Stop hook from a non-owning session must not write a session pointer'
    );
  });

  it('appends sessionId only when the session owns the task', () => {
    const sessionA = 'session-A';
    const { taskPath } = seedTaskOwnedBy(projectDir, sessionA);

    const result = checkpointRuntimeTask(projectDir, { session_id: sessionA });
    assert.equal(result.ok, true);
    assert.equal(result.ownsTask, true);

    const taskAfter = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
    assert.deepEqual(taskAfter.sessionIds, [sessionA]);
    assert.ok(loadSessionTaskPointer(projectDir, sessionA), 'owning session pointer must be refreshed');
  });
});

describe('SessionEnd isolation (regression)', () => {
  let projectDir;

  beforeEach(() => { projectDir = makeProject(); });
  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    // session-end CLI runs with the package root as cwd, so curate-driven
    // writes for tasks scoped to "repo" can land in `<cwd>/08_Lessons/Repo/`.
    // Sweep that directory after every test so subsequent suites (and S4
    // sessions) start clean. The package itself has no real 08_Lessons
    // tree at cwd — the runtime's lesson root is `templates/vault/08_Lessons`.
    fs.rmSync(path.join(process.cwd(), '08_Lessons'), { recursive: true, force: true });
  });

  it('refuses to close another session\'s task', async () => {
    // Repeat the bug scenario:
    //   1) session-A starts a task and is the originator.
    //   2) session-B fires task-close (no per-session pointer, sessionIds does
    //      not contain B). The runtime must report "no active task" instead of
    //      closing session-A's task.
    const sessionA = 'session-A';
    const sessionB = 'session-B';
    const { taskRecord } = seedTaskOwnedBy(projectDir, sessionA);

    // Avoid writing a current-task-<sessionA>.json so we exercise the
    // global-pointer fallback path with the new ownership guard.
    const sessionPointerPath = path.join(
      getRuntimePaths(projectDir).runtimeRoot,
      `current-task-${sessionA}.json`
    );
    if (fs.existsSync(sessionPointerPath)) fs.unlinkSync(sessionPointerPath);

    const { spawnSync } = await import('node:child_process');
    const cliPath = SESSION_END_CLI;
    const result = spawnSync(process.execPath, [
      cliPath,
      '--close',
      '--session-id', sessionB,
      '--project-dir', projectDir
    ], { encoding: 'utf8' });

    assert.equal(result.status, 0, `session-end exited non-zero: ${result.stderr}`);
    const lastLine = result.stdout.trim().split(/\r?\n/).pop();
    const payload = JSON.parse(lastLine);
    assert.equal(payload.message, 'no active task', 'session B must not be allowed to close session A\'s task');

    // Task record must remain active.
    const taskAfter = JSON.parse(fs.readFileSync(
      path.join(getRuntimePaths(projectDir).tasksRoot, `${taskRecord.taskId}.json`),
      'utf8'
    ));
    assert.equal(taskAfter.status, 'active', 'task must remain active after foreign close attempt');
  });

  it('closes the task for the owning session and clears its pointers', async () => {
    const sessionA = 'session-A';
    const { taskRecord } = seedTaskOwnedBy(projectDir, sessionA);

    const { spawnSync } = await import('node:child_process');
    const cliPath = SESSION_END_CLI;
    const result = spawnSync(process.execPath, [
      cliPath,
      '--close',
      '--session-id', sessionA,
      '--project-dir', projectDir
    ], { encoding: 'utf8' });

    assert.equal(result.status, 0, `session-end exited non-zero: ${result.stderr}`);

    const taskAfter = JSON.parse(fs.readFileSync(
      path.join(getRuntimePaths(projectDir).tasksRoot, `${taskRecord.taskId}.json`),
      'utf8'
    ));
    assert.equal(taskAfter.status, 'completed', 'owning session must close its task');

    assert.equal(
      loadCurrentTaskPointer(projectDir),
      null,
      'global pointer must be cleared when it targeted the closed task'
    );
    assert.equal(
      loadSessionTaskPointer(projectDir, sessionA),
      null,
      'session pointer must be cleared on close'
    );
  });
});
