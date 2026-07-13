/**
 * list-artifacts --kind all — task-close 흐름의 kind별 4연쇄 호출을 1회로 줄이는
 * 통합 조회. 각 item 에 kind 필드가 붙어야 한다.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureRuntimeLayout, getRuntimePaths } from '../../core/runtime-lib.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI = path.resolve(__dirname, '..', 'list-artifacts.mjs');

function run(projectDir, kind) {
  return spawnSync(
    process.execPath,
    [CLI, '--kind', kind, '--project-dir', projectDir],
    { encoding: 'utf8' }
  );
}

describe('list-artifacts --kind all', () => {
  let projectDir;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'list-artifacts-all-'));
    ensureRuntimeLayout(projectDir);
    const knowledgeRoot = getRuntimePaths(projectDir).knowledgeRoot;
    fs.writeFileSync(path.join(knowledgeRoot, 'lessons.jsonl'),
      JSON.stringify({ id: 'l1', title: 'L1', summary: 's', scope: 'repo' }) + '\n');
    fs.writeFileSync(path.join(knowledgeRoot, 'decisions.jsonl'),
      JSON.stringify({ id: 'd1', title: 'D1', summary: 's', scope: 'repo' }) + '\n');
  });
  afterEach(() => { fs.rmSync(projectDir, { recursive: true, force: true }); });

  it('returns items from every kind, each tagged with its kind', () => {
    const result = run(projectDir, 'all');
    assert.equal(result.status, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.kind, 'all');
    assert.equal(payload.count, 2);

    const kinds = payload.items.map((i) => i.kind).sort();
    assert.deepEqual(kinds, ['decision', 'lesson']);
    assert.ok(payload.items.every((i) => i.id && i.kind), 'every item carries id + kind');
  });

  it('still rejects unknown kinds, listing all as a valid choice', () => {
    const result = run(projectDir, 'nope');
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.reason, 'invalid_kind');
    assert.match(payload.detail, /all\|/);
  });
});
