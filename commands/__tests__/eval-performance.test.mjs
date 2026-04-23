import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { computePerformance } from '../eval-performance.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI_PATH = path.resolve(__dirname, '..', 'eval-performance.mjs');

const DAY_MS = 86400 * 1000;

function makeProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eval-perf-'));
}

function writeTaskAndUsage(dir, taskId, createdAt, closedAt, tokens) {
  const tasks = path.join(dir, '.claude', 'runtime', 'tasks');
  const usage = path.join(dir, '.claude', 'runtime', 'task-usage');
  fs.mkdirSync(tasks, { recursive: true });
  fs.mkdirSync(usage, { recursive: true });
  fs.writeFileSync(
    path.join(tasks, `${taskId}.json`),
    JSON.stringify({ taskId, createdAt, closedAt })
  );
  fs.writeFileSync(
    path.join(usage, `${taskId}.json`),
    JSON.stringify({ taskId, usage: { totalTokens: tokens } })
  );
}

test('computePerformance — 3 decreasing days → monotoneDecreasing3d true', () => {
  const dir = makeProject();
  const now = Date.now();
  const d2 = new Date(now - 2 * DAY_MS);
  const d1 = new Date(now - 1 * DAY_MS);
  const d0 = new Date(now);
  writeTaskAndUsage(dir, 't-d2', d2.toISOString(), new Date(d2.getTime() + 1000).toISOString(), 10000);
  writeTaskAndUsage(dir, 't-d1', d1.toISOString(), new Date(d1.getTime() + 900).toISOString(), 7000);
  writeTaskAndUsage(dir, 't-d0', d0.toISOString(), new Date(d0.getTime() + 800).toISOString(), 5000);
  const r = computePerformance(dir, { windowDays: 30, baselineDays: 3, now });
  assert.equal(r.monotoneDecreasing3d, true);
  assert.equal(r.perDaySeries.length, 3);
});

test('computePerformance — rising middle day → false', () => {
  const dir = makeProject();
  const now = Date.now();
  const d2 = new Date(now - 2 * DAY_MS);
  const d1 = new Date(now - 1 * DAY_MS);
  const d0 = new Date(now);
  writeTaskAndUsage(dir, 't-d2', d2.toISOString(), new Date(d2.getTime() + 1000).toISOString(), 5000);
  writeTaskAndUsage(dir, 't-d1', d1.toISOString(), new Date(d1.getTime() + 900).toISOString(), 8000);
  writeTaskAndUsage(dir, 't-d0', d0.toISOString(), new Date(d0.getTime() + 800).toISOString(), 6000);
  const r = computePerformance(dir, { windowDays: 30, baselineDays: 3, now });
  assert.equal(r.monotoneDecreasing3d, false);
});

test('computePerformance — empty project → null monotone, empty series', () => {
  const dir = makeProject();
  const r = computePerformance(dir, { windowDays: 30, baselineDays: 3 });
  assert.equal(r.monotoneDecreasing3d, null);
  assert.deepEqual(r.perDaySeries, []);
});

test('computePerformance — no task-usage files → empty series', () => {
  const dir = makeProject();
  // tasks present but no usage folder
  const tasks = path.join(dir, '.claude', 'runtime', 'tasks');
  fs.mkdirSync(tasks, { recursive: true });
  fs.writeFileSync(
    path.join(tasks, 't1.json'),
    JSON.stringify({ taskId: 't1', createdAt: new Date().toISOString() })
  );
  const r = computePerformance(dir, { windowDays: 30 });
  assert.deepEqual(r.perDaySeries, []);
});

test('CLI — emits JSON on stdout', () => {
  const dir = makeProject();
  const r = spawnSync(process.execPath, [CLI_PATH, '--project-dir', dir], {
    encoding: 'utf8'
  });
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
  assert.ok('perDaySeries' in parsed);
  assert.ok('tokenWma7d' in parsed);
});
