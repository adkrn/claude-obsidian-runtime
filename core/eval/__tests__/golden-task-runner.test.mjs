import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  runGoldenTask,
  estimateTokenCount,
  captureFsSnapshot,
  compareSnapshots
} from '../golden-task-runner.mjs';

function makeProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'runner-proj-'));
}

function makeFixturesDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'runner-fx-'));
}

function baseTask(overrides = {}) {
  return {
    id: 'GOLDEN-TEST-01',
    category: 'test',
    prompt: 'write a hook',
    expectedScope: 'workflow',
    expectedReadFirstPaths: [],
    expectedCodeHitsKeywords: [],
    reusability: 'low',
    manualRelevanceScores: {},
    ...overrides
  };
}

// Fixture: synthesize a tiny task-start.mjs that emits the 9 PATCH fields on stdout.
function writeGoodFixture(dir) {
  const p = path.join(dir, 'task-start-good.mjs');
  const script = `#!/usr/bin/env node
const out = {
  taskId: 'FX-1',
  readFirst: [{ path: '08_Lessons/x.md', why: 'w' }],
  codeHits: [{ path: 'src/a.ts', why: 'w' }],
  knowledgeHits: [{ id: 'L-1', kind: 'lesson', title: 't', summary: 's', sourceDoc: 'd', scope: 'workflow', score: 1 }],
  guardrails: ['g1'],
  matchedScopes: ['workflow'],
  matchedGroups: [{ id: 'grp-1', label: 'l', score: 1 }],
  currentTaskPath: '/tmp/current-task.json',
  lastContextPath: '/tmp/last-context.json'
};
process.stdout.write(JSON.stringify(out) + '\\n');
`;
  fs.writeFileSync(p, script, 'utf8');
  return p;
}

function writeMissingFieldFixture(dir) {
  const p = path.join(dir, 'task-start-missing.mjs');
  const script = `#!/usr/bin/env node
const out = {
  taskId: 'FX-2',
  readFirst: [],
  codeHits: [],
  knowledgeHits: [],
  guardrails: [],
  matchedScopes: [],
  matchedGroups: [],
  currentTaskPath: '/tmp/c.json'
  // lastContextPath missing on purpose
};
process.stdout.write(JSON.stringify(out) + '\\n');
`;
  fs.writeFileSync(p, script, 'utf8');
  return p;
}

function writeGarbageFixture(dir) {
  const p = path.join(dir, 'task-start-garbage.mjs');
  fs.writeFileSync(p, `process.stdout.write('not-json-at-all\\n');\n`, 'utf8');
  return p;
}

function writeExitNonZeroFixture(dir) {
  const p = path.join(dir, 'task-start-crash.mjs');
  fs.writeFileSync(
    p,
    `process.stderr.write('boom\\n'); process.exit(3);\n`,
    'utf8'
  );
  return p;
}

function writeHangFixture(dir) {
  const p = path.join(dir, 'task-start-hang.mjs');
  fs.writeFileSync(p, `setInterval(() => {}, 1000);\n`, 'utf8');
  return p;
}

function writeSideEffectFixture(dir, projectDir) {
  // This fixture writes to .claude/runtime/current-task.json after printing JSON
  const p = path.join(dir, 'task-start-sideeffect.mjs');
  const targetPath = path.join(projectDir, '.claude', 'runtime', 'current-task.json').replace(/\\/g, '/');
  const script = `#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
const target = ${JSON.stringify(targetPath)};
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify({ leak: true }));
const out = {
  taskId: 'FX-SE',
  readFirst: [],
  codeHits: [],
  knowledgeHits: [],
  guardrails: [],
  matchedScopes: [],
  matchedGroups: [],
  currentTaskPath: target,
  lastContextPath: target + '.ctx'
};
process.stdout.write(JSON.stringify(out) + '\\n');
`;
  fs.writeFileSync(p, script, 'utf8');
  return p;
}

test('estimateTokenCount: 4-char ≈ 1 token, ceil, empty → 0', () => {
  assert.equal(estimateTokenCount(''), 0);
  assert.equal(estimateTokenCount('abcd'), 1);
  assert.equal(estimateTokenCount('abcde'), 2);
  assert.equal(estimateTokenCount('a'.repeat(100)), 25);
  assert.equal(estimateTokenCount(null), 0);
});

test('runGoldenTask: success path populates 9 fields, failure null', async () => {
  const projectDir = makeProject();
  const fixtures = makeFixturesDir();
  const taskStartPath = writeGoodFixture(fixtures);
  const run = await runGoldenTask(projectDir, baseTask(), { taskStartPath });
  assert.equal(run.failure, null);
  assert.equal(run.taskId, 'GOLDEN-TEST-01');
  assert.equal(run.prompt, 'write a hook');
  assert.equal(run.expectedScope, 'workflow');
  assert.deepEqual(run.actualScopes, ['workflow']);
  assert.equal(run.readFirstCount, 1);
  assert.deepEqual(run.readFirstPaths, ['08_Lessons/x.md']);
  assert.equal(run.codeHitsCount, 1);
  assert.deepEqual(run.codeHitsPaths, ['src/a.ts']);
  assert.equal(run.knowledgeHitsCount, 1);
  assert.equal(run.guardrailsCount, 1);
  assert.deepEqual(run.matchedGroupsIds, ['grp-1']);
  assert.equal(run.rawSchemaKeys.length, 9);
  // sorted + exactly the 9 PATCH fields
  assert.deepEqual(
    run.rawSchemaKeys,
    [
      'codeHits',
      'currentTaskPath',
      'guardrails',
      'knowledgeHits',
      'lastContextPath',
      'matchedGroups',
      'matchedScopes',
      'readFirst',
      'taskId'
    ]
  );
  assert.ok(run.tokenCount > 0);
  assert.ok(run.wallTimeMs >= 0);
});

test('runGoldenTask: task-start.mjs missing → failure recorded, no throw', async () => {
  const projectDir = makeProject();
  const run = await runGoldenTask(projectDir, baseTask(), {
    taskStartPath: path.join(makeFixturesDir(), 'does-not-exist.mjs')
  });
  assert.ok(run.failure);
  assert.match(run.failure.message, /task-start\.mjs not found/);
  assert.equal(run.rawSchemaKeys.length, 0);
});

test('runGoldenTask: non-JSON stdout → failure "stdout not parseable JSON"', async () => {
  const projectDir = makeProject();
  const fixtures = makeFixturesDir();
  const run = await runGoldenTask(projectDir, baseTask(), {
    taskStartPath: writeGarbageFixture(fixtures)
  });
  assert.ok(run.failure);
  assert.match(run.failure.message, /stdout not parseable JSON/);
});

test('runGoldenTask: missing required field → failure lists missing', async () => {
  const projectDir = makeProject();
  const fixtures = makeFixturesDir();
  const run = await runGoldenTask(projectDir, baseTask(), {
    taskStartPath: writeMissingFieldFixture(fixtures)
  });
  assert.ok(run.failure);
  assert.match(run.failure.message, /missing required fields/);
  assert.match(run.failure.message, /lastContextPath/);
});

test('runGoldenTask: exit code ≠ 0 → failure includes status + stderr', async () => {
  const projectDir = makeProject();
  const fixtures = makeFixturesDir();
  const run = await runGoldenTask(projectDir, baseTask(), {
    taskStartPath: writeExitNonZeroFixture(fixtures)
  });
  assert.ok(run.failure);
  assert.match(run.failure.message, /exited with code 3/);
  assert.match(run.failure.stderr || '', /boom/);
});

test('runGoldenTask: timeout → failure "timeout after <ms>ms"', async () => {
  const projectDir = makeProject();
  const fixtures = makeFixturesDir();
  const run = await runGoldenTask(projectDir, baseTask(), {
    taskStartPath: writeHangFixture(fixtures),
    timeout: 300
  });
  assert.ok(run.failure);
  assert.match(run.failure.message, /timeout after 300ms/);
});

test('runGoldenTask: dry-run side-effect detected → failure "spawn violated dry-run skip-list"', async () => {
  const projectDir = makeProject();
  const fixtures = makeFixturesDir();
  const run = await runGoldenTask(projectDir, baseTask(), {
    taskStartPath: writeSideEffectFixture(fixtures, projectDir)
  });
  assert.ok(run.failure);
  assert.match(run.failure.message, /spawn violated dry-run skip-list/);
  assert.ok(Array.isArray(run.failure.detail?.modifiedFiles));
  assert.ok(run.failure.detail.modifiedFiles.length > 0);
});

test('captureFsSnapshot + compareSnapshots: no change when nothing touches disk', () => {
  const projectDir = makeProject();
  const before = captureFsSnapshot(projectDir);
  const after = captureFsSnapshot(projectDir);
  assert.deepEqual(compareSnapshots(before, after), []);
});

test('captureFsSnapshot + compareSnapshots: detects newly created sensitive file', () => {
  const projectDir = makeProject();
  const before = captureFsSnapshot(projectDir);
  const ct = path.join(projectDir, '.claude', 'runtime', 'current-task.json');
  fs.mkdirSync(path.dirname(ct), { recursive: true });
  fs.writeFileSync(ct, '{}');
  const after = captureFsSnapshot(projectDir);
  const diff = compareSnapshots(before, after);
  assert.ok(diff.some((c) => c.path === '.claude/runtime/current-task.json' && c.reason === 'created'));
});

test('runGoldenTask: real task-start.mjs dry-run → 9 fields, no FS write (integration)', async () => {
  // Integration: resolve the real commands/task-start.mjs via CLAUDE_RUNTIME_HOME.
  const projectDir = makeProject();
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
  const runtimeHome = path.resolve(here, '..', '..', '..');
  const taskStartPath = path.join(runtimeHome, 'commands', 'task-start.mjs');
  if (!fs.existsSync(taskStartPath)) {
    // Defensive: skip when package layout is atypical
    return;
  }
  const run = await runGoldenTask(projectDir, baseTask({ prompt: 'integration probe' }), {
    taskStartPath
  });
  assert.equal(run.failure, null, run.failure?.message);
  assert.equal(run.rawSchemaKeys.length, 9);
  assert.ok(run.tokenCount > 0);
  // Side-effect guarantee: runtime dir should remain absent after dry-run.
  assert.equal(fs.existsSync(path.join(projectDir, '.claude', 'runtime')), false);
});
