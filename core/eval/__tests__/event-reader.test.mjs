import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  readEventsWindow,
  groupEventsByTask,
  extractFileReadsForTask,
  extractFirstEditedFile
} from '../event-reader.mjs';

function mkProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-event-'));
  fs.mkdirSync(path.join(dir, '.claude', 'runtime', 'events'), { recursive: true });
  return dir;
}

function writeEvents(projectDir, scope, events) {
  const filePath = path.join(projectDir, '.claude', 'runtime', 'events', `${scope}.jsonl`);
  const content = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(filePath, content, 'utf8');
}

test('readEventsWindow: filters out events older than window', () => {
  const projectDir = mkProject();
  const now = Date.now();
  const oldTs = new Date(now - 40 * 86400 * 1000).toISOString();
  const recentTs = new Date(now - 5 * 86400 * 1000).toISOString();
  writeEvents(projectDir, 'workflow', [
    { id: 'evt-1', ts: oldTs, eventType: 'file_read', taskId: 'T-old', filePath: 'old.md' },
    { id: 'evt-2', ts: recentTs, eventType: 'file_read', taskId: 'T-new', filePath: 'new.md' }
  ]);
  const events = readEventsWindow(projectDir, 30, now);
  assert.equal(events.length, 1);
  assert.equal(events[0].id, 'evt-2');
});

test('readEventsWindow: aggregates multiple scope files and sorts ascending', () => {
  const projectDir = mkProject();
  const now = Date.now();
  const t1 = new Date(now - 2 * 86400 * 1000).toISOString();
  const t2 = new Date(now - 1 * 86400 * 1000).toISOString();
  writeEvents(projectDir, 'backend', [
    { id: 'evt-b', ts: t2, eventType: 'file_read', taskId: 'T-1', filePath: 'b.md' }
  ]);
  writeEvents(projectDir, 'frontend', [
    { id: 'evt-f', ts: t1, eventType: 'file_read', taskId: 'T-1', filePath: 'f.md' }
  ]);
  const events = readEventsWindow(projectDir, 30, now);
  assert.equal(events.length, 2);
  assert.equal(events[0].id, 'evt-f', 'older event first');
  assert.equal(events[1].id, 'evt-b');
});

test('readEventsWindow: missing events directory returns empty list', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-event-missing-'));
  assert.deepEqual(readEventsWindow(dir, 30), []);
});

test('readEventsWindow: skips malformed JSONL lines', () => {
  const projectDir = mkProject();
  const now = Date.now();
  const ts = new Date(now - 1 * 86400 * 1000).toISOString();
  const filePath = path.join(projectDir, '.claude', 'runtime', 'events', 'workflow.jsonl');
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({ id: 'evt-good', ts, eventType: 'file_read', taskId: 'T-1', filePath: 'a.md' })}\n` +
      `not-json{{\n` +
      `${JSON.stringify({ id: 'evt-good-2', ts, eventType: 'file_read', taskId: 'T-1', filePath: 'b.md' })}\n`,
    'utf8'
  );
  const events = readEventsWindow(projectDir, 30, now);
  assert.equal(events.length, 2);
});

test('groupEventsByTask: buckets by taskId and skips entries without taskId', () => {
  const events = [
    { id: '1', taskId: 'T-A', ts: '2026-04-22T00:00:00Z' },
    { id: '2', taskId: 'T-B', ts: '2026-04-22T00:01:00Z' },
    { id: '3', taskId: 'T-A', ts: '2026-04-22T00:02:00Z' },
    { id: '4', ts: '2026-04-22T00:03:00Z' }
  ];
  const map = groupEventsByTask(events);
  assert.equal(map.size, 2);
  assert.equal(map.get('T-A').length, 2);
  assert.equal(map.get('T-B').length, 1);
});

test('extractFileReadsForTask: collects unique vault paths', () => {
  const events = [
    { eventType: 'file_read', filePath: 'a.md' },
    { eventType: 'file_read', filePath: 'b.md' },
    { eventType: 'file_read', filePath: 'a.md' },
    { eventType: 'file_modified', filePath: 'c.md' }
  ];
  const reads = extractFileReadsForTask(events);
  assert.equal(reads.size, 2);
  assert.ok(reads.has('a.md'));
  assert.ok(reads.has('b.md'));
});

test('extractFirstEditedFile: returns first Edit/Write file_modified path', () => {
  const events = [
    { eventType: 'file_read', filePath: 'a.md', toolName: 'Read' },
    { eventType: 'file_modified', filePath: 'b.ts', toolName: 'Edit' },
    { eventType: 'file_modified', filePath: 'c.ts', toolName: 'Write' }
  ];
  assert.equal(extractFirstEditedFile(events), 'b.ts');
});

test('extractFirstEditedFile: ignores non-Edit/Write tools', () => {
  const events = [
    { eventType: 'file_modified', filePath: 'a.ts', toolName: 'Bash' },
    { eventType: 'file_modified', filePath: 'b.ts', toolName: 'Edit' }
  ];
  assert.equal(extractFirstEditedFile(events), 'b.ts');
});

test('extractFirstEditedFile: empty list returns null', () => {
  assert.equal(extractFirstEditedFile([]), null);
});
