import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  loadGoldenTasks,
  GoldenTasksNotFound,
  GoldenTasksSchemaError
} from '../golden-task-loader.mjs';

function makeProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eval-loader-'));
}

function writeLocalCopy(projectDir, doc) {
  const dir = path.join(projectDir, '.claude', 'runtime', 'eval');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'golden-tasks.json'), JSON.stringify(doc), 'utf8');
}

function minimalTask(id) {
  return {
    id,
    category: 'test',
    prompt: 'p',
    expectedScope: '<matched>',
    expectedReadFirstPaths: [],
    expectedCodeHitsKeywords: [],
    reusability: 'low',
    manualRelevanceScores: {}
  };
}

test('loadGoldenTasks: returns bundled template when no project copy exists', async () => {
  const projectDir = makeProject();
  const prevHome = process.env.CLAUDE_RUNTIME_HOME;
  delete process.env.CLAUDE_RUNTIME_HOME;
  try {
    const result = await loadGoldenTasks({ projectDir });
    assert.equal(result.schemaVersion, '1.0.0');
    assert.equal(result.tasks.length, 36);
    assert.equal(result.tasks[0].id, 'GOLDEN-01');
    assert.match(result.source, /templates[\\/]eval[\\/]golden-tasks\.json$/);
  } finally {
    if (prevHome !== undefined) process.env.CLAUDE_RUNTIME_HOME = prevHome;
  }
});

test('loadGoldenTasks: prefers project-local copy over template', async () => {
  const projectDir = makeProject();
  writeLocalCopy(projectDir, {
    schemaVersion: '1.0.0',
    description: 'local',
    tasks: [minimalTask('LOCAL-01'), minimalTask('LOCAL-02')]
  });
  const result = await loadGoldenTasks({ projectDir });
  assert.equal(result.tasks.length, 2);
  assert.equal(result.tasks[0].id, 'LOCAL-01');
  assert.match(result.source, /golden-tasks\.json$/);
  assert.ok(result.source.includes(projectDir), 'source should be the project-local file');
});

test('loadGoldenTasks: explicit tasksPath takes highest priority', async () => {
  const projectDir = makeProject();
  writeLocalCopy(projectDir, {
    schemaVersion: '1.0.0',
    tasks: [minimalTask('LOCAL-01')]
  });
  const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-override-'));
  const overridePath = path.join(overrideDir, 'override.json');
  fs.writeFileSync(
    overridePath,
    JSON.stringify({
      schemaVersion: '1.0.0',
      tasks: [minimalTask('OVERRIDE-01')]
    }),
    'utf8'
  );
  const result = await loadGoldenTasks({ projectDir, tasksPath: overridePath });
  assert.equal(result.tasks[0].id, 'OVERRIDE-01');
  assert.equal(result.source, path.resolve(overridePath));
});

test('loadGoldenTasks: throws GoldenTasksNotFound when nothing resolves', async () => {
  const prevHome = process.env.CLAUDE_RUNTIME_HOME;
  delete process.env.CLAUDE_RUNTIME_HOME;
  // Point loader at a path with no template by overriding the module via env.
  // We cannot override the bundled fallback; instead simulate by loading from
  // a project that has no copy AND swap the bundled file temporarily.
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-none-'));
  // Move bundled template out of the way
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
  const bundled = path.resolve(here, '..', '..', '..', 'templates', 'eval', 'golden-tasks.json');
  const backup = `${bundled}.bak-test`;
  let restored = false;
  try {
    fs.renameSync(bundled, backup);
    await assert.rejects(
      () => loadGoldenTasks({ projectDir }),
      (err) => err instanceof GoldenTasksNotFound && Array.isArray(err.searched) && err.searched.length > 0
    );
  } finally {
    try {
      fs.renameSync(backup, bundled);
      restored = true;
    } catch {
      restored = false;
    }
    if (!restored && fs.existsSync(backup)) {
      fs.copyFileSync(backup, bundled);
      fs.unlinkSync(backup);
    }
    if (prevHome !== undefined) process.env.CLAUDE_RUNTIME_HOME = prevHome;
  }
});

test('loadGoldenTasks: schema error when required field missing', async () => {
  const projectDir = makeProject();
  const broken = {
    schemaVersion: '1.0.0',
    tasks: [{ id: 'BAD-01', category: 'x', prompt: 'p' }]
  };
  writeLocalCopy(projectDir, broken);
  await assert.rejects(
    () => loadGoldenTasks({ projectDir }),
    (err) => err instanceof GoldenTasksSchemaError && /expectedScope|missing/.test(err.message)
  );
});
