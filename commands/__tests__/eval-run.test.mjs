import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI_PATH = path.resolve(__dirname, '..', 'eval-run.mjs');
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const GOLDEN_TASKS_PATH = path.resolve(
  PACKAGE_ROOT,
  'templates',
  'eval',
  'golden-tasks.json'
);

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-run-'));
  // Seed project-local golden tasks so loader succeeds w/o env.
  const evalDir = path.join(dir, '.claude', 'runtime', 'eval');
  fs.mkdirSync(evalDir, { recursive: true });
  fs.copyFileSync(GOLDEN_TASKS_PATH, path.join(evalDir, 'golden-tasks.json'));
  return dir;
}

function runCli(args, envExtra = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...envExtra },
    maxBuffer: 16 * 1024 * 1024
  });
}

test('eval-run --task GOLDEN-01 with all axes skipped → emits REPORT= line', () => {
  const dir = makeProject();
  const r = runCli([
    '--golden',
    '--task', 'GOLDEN-01',
    '--project-dir', dir,
    '--noRetrieval',
    '--noLessonReuse',
    '--noPerformance'
  ]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const lastLine = r.stdout.trim().split(/\r?\n/).pop();
  assert.ok(/^REPORT=/.test(lastLine), `expected REPORT= line, got: ${lastLine}`);
  const reportPath = lastLine.replace(/^REPORT=/, '').trim();
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(report.goldenRuns.length, 1);
  assert.equal(report.quality.skipped, true);
  assert.equal(report.lessonReuse.skipped, true);
  assert.equal(report.performance.skipped, true);
});

test('eval-run --all 36 tasks → goldenRuns.length === 36', () => {
  const dir = makeProject();
  const r = runCli([
    '--golden', '--all',
    '--project-dir', dir,
    '--noRetrieval', '--noLessonReuse', '--noPerformance'
  ]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const lastLine = r.stdout.trim().split(/\r?\n/).pop();
  const reportPath = lastLine.replace(/^REPORT=/, '').trim();
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(report.goldenRuns.length, 36);
});

test('eval-run — unknown task id → exit 1 with stderr', () => {
  const dir = makeProject();
  const r = runCli([
    '--task', 'GOLDEN-DOES-NOT-EXIST',
    '--project-dir', dir,
    '--noRetrieval', '--noLessonReuse', '--noPerformance'
  ]);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.length > 0);
});

test('eval-run --goldenTasks custom path accepted', () => {
  const dir = makeProject();
  const customDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-run-cust-'));
  const customPath = path.join(customDir, 'custom.json');
  const custom = {
    schemaVersion: '1.0.0',
    description: 'test',
    tasks: [{
      id: 'CUSTOM-1',
      category: 'test',
      prompt: 'hi',
      expectedScope: 'repo',
      expectedReadFirstPaths: [],
      expectedCodeHitsKeywords: [],
      reusability: 'low',
      manualRelevanceScores: {}
    }]
  };
  fs.writeFileSync(customPath, JSON.stringify(custom));
  const r = runCli([
    '--goldenTasks', customPath,
    '--project-dir', dir,
    '--noRetrieval', '--noLessonReuse', '--noPerformance'
  ]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const lastLine = r.stdout.trim().split(/\r?\n/).pop();
  const report = JSON.parse(fs.readFileSync(lastLine.replace(/^REPORT=/, '').trim(), 'utf8'));
  assert.equal(report.goldenRuns.length, 1);
  assert.equal(report.goldenRuns[0].taskId, 'CUSTOM-1');
});

test('eval-run --help prints help', () => {
  const r = runCli(['--help']);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('Usage'));
});

test('eval-run — exit 0 preserved even on soft-fail; goldenRuns always recorded', () => {
  const dir = makeProject();
  const customDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-run-bad-'));
  const customPath = path.join(customDir, 'bad.json');
  fs.writeFileSync(customPath, JSON.stringify({
    schemaVersion: '1.0.0',
    description: 't',
    tasks: [
      {
        id: 'A-ONE',
        category: 'test',
        prompt: 'hi a',
        expectedScope: 'repo',
        expectedReadFirstPaths: [],
        expectedCodeHitsKeywords: [],
        reusability: 'low',
        manualRelevanceScores: {}
      },
      {
        id: 'A-TWO',
        category: 'test',
        prompt: 'hi b',
        expectedScope: 'repo',
        expectedReadFirstPaths: [],
        expectedCodeHitsKeywords: [],
        reusability: 'low',
        manualRelevanceScores: {}
      }
    ]
  }));
  const r = runCli([
    '--goldenTasks', customPath,
    '--project-dir', dir,
    '--noRetrieval', '--noLessonReuse', '--noPerformance'
  ]);
  assert.equal(r.status, 0);
  const lastLine = r.stdout.trim().split(/\r?\n/).pop();
  const report = JSON.parse(fs.readFileSync(lastLine.replace(/^REPORT=/, '').trim(), 'utf8'));
  assert.equal(report.goldenRuns.length, 2);
  // Even if some task soft-fails (failure !== null), eval-run must not block siblings.
  const ids = report.goldenRuns.map((r) => r.taskId).sort();
  assert.deepEqual(ids, ['A-ONE', 'A-TWO']);
});
