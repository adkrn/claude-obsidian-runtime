import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { computeReuseRate, compare } from '../eval-lesson-reuse.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI_PATH = path.resolve(__dirname, '..', 'eval-lesson-reuse.mjs');

const DAY_MS = 86400 * 1000;

function makeProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eval-reuse-'));
}

function writeLessons(dir, rows) {
  const p = path.join(dir, '.claude', 'runtime', 'knowledge');
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(
    path.join(p, 'lessons.jsonl'),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
  );
}

function writeTask(dir, taskId, hits, updatedAt) {
  const p = path.join(dir, '.claude', 'runtime', 'tasks');
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(
    path.join(p, `${taskId}.json`),
    JSON.stringify({
      taskId,
      knowledgeHits: hits.map((id) => ({ id, kind: 'lesson', title: '', summary: '' })),
      updatedAt
    })
  );
}

test('computeReuseRate — normal rematch', () => {
  const dir = makeProject();
  const now = Date.now();
  const before = new Date(now - 60 * DAY_MS).toISOString();
  const within = new Date(now - 1 * DAY_MS).toISOString();
  writeLessons(dir, [
    { id: 'L1', created_at: before, confidence: 'high' },
    { id: 'L2', created_at: before, confidence: 'medium' },
    { id: 'L3', created_at: before, confidence: 'low' }
  ]);
  writeTask(dir, 't1', ['L1'], within);
  writeTask(dir, 't2', ['L2'], within);
  const r = computeReuseRate(dir, 30, now);
  assert.equal(r.lessonsCreatedPre, 3);
  assert.equal(r.lessonsRematched, 2);
  assert.ok(Math.abs(r.reuseRate - 2 / 3) < 1e-9);
  assert.deepEqual(r.confidenceDist, { high: 1, medium: 1, low: 1 });
});

test('computeReuseRate — 0 lessons pre → reuseRate 0 + warning', () => {
  const dir = makeProject();
  const now = Date.now();
  writeLessons(dir, []);
  const r = computeReuseRate(dir, 30, now);
  assert.equal(r.reuseRate, 0);
  assert.equal(r.lessonsCreatedPre, 0);
  assert.ok(typeof r.warning === 'string');
});

test('compare — chiSquared computed between two projects', () => {
  const a = makeProject();
  const b = makeProject();
  const now = Date.now();
  const before = new Date(now - 60 * DAY_MS).toISOString();
  writeLessons(a, [
    { id: 'A1', created_at: before, confidence: 'high' },
    { id: 'A2', created_at: before, confidence: 'medium' }
  ]);
  writeLessons(b, [
    { id: 'B1', created_at: before, confidence: 'high' },
    { id: 'B2', created_at: before, confidence: 'low' }
  ]);
  const r = compare(a, b, 30, now);
  assert.ok('chiSquared' in r);
  assert.ok(typeof r.chiSquared.stat === 'number');
  assert.ok(typeof r.chiSquared.p === 'number');
});

test('computeReuseRate — malformed lessons.jsonl line skipped', () => {
  const dir = makeProject();
  const now = Date.now();
  const p = path.join(dir, '.claude', 'runtime', 'knowledge');
  fs.mkdirSync(p, { recursive: true });
  const before = new Date(now - 60 * DAY_MS).toISOString();
  fs.writeFileSync(
    path.join(p, 'lessons.jsonl'),
    `{ broken json\n${JSON.stringify({ id: 'L1', created_at: before, confidence: 'medium' })}\n`
  );
  const r = computeReuseRate(dir, 30, now);
  assert.equal(r.lessonsCreatedPre, 1);
});

test('CLI — runs and emits JSON', () => {
  const dir = makeProject();
  const r = spawnSync(process.execPath, [CLI_PATH, '--project-dir', dir], {
    encoding: 'utf8'
  });
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
  assert.ok('reuseRate' in parsed);
  assert.ok('confidenceDist' in parsed);
});
