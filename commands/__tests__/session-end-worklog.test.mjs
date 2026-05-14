/**
 * Regression: task-close (--close) must always produce a Handoff Worklog
 * under <vaultRoot>/10_Worklogs/Auto/<date>_<taskId>.md (or the queue
 * fallback when no vault is configured). Prior behavior delegated worklog
 * generation to an optional project-local script and silently skipped when
 * the script was absent, so worklog files were never created in this
 * runtime. The fix inlines buildHandoffWorklog + writeVaultArtifact in
 * session-end.mjs.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ensureRuntimeLayout,
  getRuntimePaths,
  toTaskPointer,
  writeJsonFile,
  writeSessionTaskPointer
} from '../../core/runtime-lib.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SESSION_END_CLI = path.resolve(__dirname, '..', 'session-end.mjs');

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-end-worklog-'));
  ensureRuntimeLayout(dir);
  return dir;
}

function seedTask(projectDir, sessionId, taskId) {
  const runtimePaths = getRuntimePaths(projectDir);
  const taskPath = path.join(runtimePaths.tasksRoot, `${taskId}.json`);
  const taskRecord = {
    taskId,
    title: 'worklog regression task',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sessionIds: [sessionId],
    matchedScopes: ['repo'],
    files: ['src/example.ts'],
    verifications: []
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

function runSessionEnd(projectDir, sessionId) {
  return spawnSync(
    process.execPath,
    [
      SESSION_END_CLI,
      '--project-dir', projectDir,
      '--session-id', sessionId,
      '--close',
      '--no-verify'
    ],
    { encoding: 'utf8' }
  );
}

describe('session-end worklog (regression)', () => {
  let projectDir;

  beforeEach(() => { projectDir = makeProject(); });
  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    // session-end CLI writes curate artifacts relative to cwd when no vault
    // is configured; sweep so subsequent suites stay clean.
    fs.rmSync(path.join(process.cwd(), '08_Lessons'), { recursive: true, force: true });
    fs.rmSync(path.join(process.cwd(), '10_Worklogs'), { recursive: true, force: true });
  });

  it('always writes 10_Worklogs/Auto/<date>_<taskId>.md on --close (queue fallback when no vault)', () => {
    const sessionId = 'session-worklog-1';
    const taskId = 'task-worklog-1';
    seedTask(projectDir, sessionId, taskId);

    const result = runSessionEnd(projectDir, sessionId);
    assert.equal(result.status, 0, `session-end exited ${result.status}: ${result.stderr}`);

    const payload = JSON.parse(result.stdout);
    assert.ok(payload.worklog, 'session-end stdout must include a worklog payload');
    assert.ok(payload.worklog.path, 'worklog payload must include a file path');
    assert.ok(
      payload.worklog.relativePath.startsWith('10_Worklogs/Auto/'),
      `relativePath must live under 10_Worklogs/Auto/, got: ${payload.worklog.relativePath}`
    );
    assert.match(
      payload.worklog.relativePath,
      new RegExp(`/\\d{4}-\\d{2}-\\d{2}_.*${taskId}.*\\.md$`),
      'worklog filename must match <date>_<slug>.md'
    );

    assert.ok(
      fs.existsSync(payload.worklog.path),
      `worklog file must exist on disk at ${payload.worklog.path}`
    );

    const body = fs.readFileSync(payload.worklog.path, 'utf8');
    assert.match(body, /^---\ntype: worklog\n/, 'worklog must lead with worklog frontmatter');
    assert.match(body, new RegExp(`taskId: ${taskId}`), 'frontmatter must include taskId');
    assert.match(body, /## 이번 세션에서 한 일/, 'must include Handoff section 1');
    assert.match(body, /## 남은 일/, 'must include Handoff section 2');
    assert.match(body, /## 한 줄 메모/, 'must include Handoff section 5');
  });

  it('maps readFirst/knowledgeHits/guardrails/previousTask into worklog sections (zero code changes)', () => {
    const sessionId = 'session-zero-code';
    const taskId = 'task-zero-code';
    const runtimePaths = getRuntimePaths(projectDir);
    const taskPath = path.join(runtimePaths.tasksRoot, `${taskId}.json`);
    const taskRecord = {
      taskId,
      title: 'A'.repeat(120),
      prompt: 'investigate parachute line twist procedure and draft a research plan before implementation',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sessionIds: [sessionId],
      matchedScopes: ['repo'],
      files: [],
      verifications: [],
      readFirst: [
        { path: '00_Home/Current_Focus.md', why: 'priorities' }
      ],
      knowledgeHits: [
        { id: 'lesson-x', title: 'Lesson - prior research on contingency UI reuse', scope: 'repo' }
      ],
      guardrails: ['read read_first notes before writing a plan'],
      previousTask: { taskId: 'prev-task-1', title: 'earlier line twist exploration', status: 'active' }
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

    const result = runSessionEnd(projectDir, sessionId);
    assert.equal(result.status, 0, `session-end exited ${result.status}: ${result.stderr}`);

    const payload = JSON.parse(result.stdout);
    const body = fs.readFileSync(payload.worklog.path, 'utf8');

    assert.ok(!/# Worklog — A{120}/.test(body), 'title must be truncated below raw 120-char title');
    assert.match(body, /# Worklog — A+…/, 'title must end with truncation ellipsis');

    assert.match(body, /참고: Lesson - prior research on contingency UI reuse/, 'section1 must include knowledgeHits title');
    assert.match(body, /읽음: 00_Home\/Current_Focus\.md/, 'section1 must include readFirst path');
    assert.ok(!/변경 사항 없음/.test(body), 'section1 fallback must not appear when knowledgeHits/readFirst present');

    assert.match(body, /- read read_first notes before writing a plan/, 'section3 must include guardrails');
    assert.match(body, /matched scopes: repo/, 'section4 must include matchedScopes');
    assert.match(body, /이어받은 task: prev-task-1 — earlier line twist exploration/, 'section4 must include previousTask');

    assert.match(body, /"investigate parachute line twist procedure/, 'section5 must include prompt-derived oneLiner');
  });
});
