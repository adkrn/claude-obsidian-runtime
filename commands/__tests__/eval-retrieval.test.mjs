import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { compute } from '../eval-retrieval.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI_PATH = path.resolve(__dirname, '..', 'eval-retrieval.mjs');

function makeProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eval-ret-'));
}

function writeTaskRecord(projectDir, taskId, record) {
  const dir = path.join(projectDir, '.claude', 'runtime', 'tasks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${taskId}.json`), JSON.stringify(record));
}

function writeEvent(projectDir, scope, event) {
  const dir = path.join(projectDir, '.claude', 'runtime', 'events');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${scope}.jsonl`), JSON.stringify(event) + '\n');
}

test('compute — insufficient data (sampleCount < 5) → nulls + warning', () => {
  const dir = makeProject();
  const now = Date.now();
  for (let i = 0; i < 3; i++) {
    const taskId = `task-${i}`;
    writeTaskRecord(dir, taskId, {
      taskId,
      readFirst: [{ path: 'a.md' }, { path: 'b.md' }],
      codeHits: [{ path: 'src/a.ts' }],
      knowledgeHits: [{ path: 'k.md' }]
    });
    writeEvent(dir, 'repo', {
      ts: new Date(now - i * 3600_000).toISOString(),
      taskId,
      eventType: 'file_read',
      filePath: 'a.md'
    });
  }
  const r = compute(dir, 30, now);
  assert.equal(r.precisionAt5, null);
  assert.equal(r.recallAt10, null);
  assert.equal(r.mrr, null);
  assert.ok(typeof r.warning === 'string' && r.warning.includes('insufficient'));
});

test('compute — normal 6 tasks → non-null aggregates', () => {
  const dir = makeProject();
  const now = Date.now();
  for (let i = 0; i < 6; i++) {
    const taskId = `task-${i}`;
    writeTaskRecord(dir, taskId, {
      taskId,
      readFirst: [{ path: 'a.md' }, { path: 'b.md' }],
      codeHits: [{ path: 'src/a.ts' }],
      knowledgeHits: [{ path: 'k.md' }]
    });
    writeEvent(dir, 'repo', {
      ts: new Date(now - i * 3600_000).toISOString(),
      taskId,
      eventType: 'file_read',
      filePath: 'a.md'
    });
    writeEvent(dir, 'repo', {
      ts: new Date(now - i * 3600_000 + 100).toISOString(),
      taskId,
      eventType: 'file_modified',
      toolName: 'Edit',
      filePath: 'src/a.ts'
    });
  }
  const r = compute(dir, 30, now);
  assert.equal(r.sampleCount, 6);
  assert.ok(typeof r.precisionAt5 === 'number');
  assert.ok(r.mrr > 0);
});

test('compute — task with zero file_reads → recallAt10 0', () => {
  const dir = makeProject();
  const now = Date.now();
  writeTaskRecord(dir, 'tsolo', {
    taskId: 'tsolo',
    readFirst: [{ path: 'a.md' }],
    codeHits: [],
    knowledgeHits: []
  });
  writeEvent(dir, 'repo', {
    ts: new Date(now).toISOString(),
    taskId: 'tsolo',
    eventType: 'task_started'
  });
  const r = compute(dir, 30, now);
  const row = r.perTaskRows.find((x) => x.taskId === 'tsolo');
  assert.equal(row.recallAt10, 0);
});

test('compute — empty events directory → sampleCount 0', () => {
  const dir = makeProject();
  const r = compute(dir, 30, Date.now());
  assert.equal(r.sampleCount, 0);
  assert.ok(Array.isArray(r.perTaskRows));
});

test('CLI — runs and emits JSON on stdout', () => {
  const dir = makeProject();
  const r = spawnSync(process.execPath, [CLI_PATH, '--project-dir', dir], {
    encoding: 'utf8'
  });
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
  assert.ok('sampleCount' in parsed);
  assert.ok(Array.isArray(parsed.perTaskRows));
});
