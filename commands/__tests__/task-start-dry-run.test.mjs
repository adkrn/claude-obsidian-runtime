import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'commands', 'task-start.mjs');

const REQUIRED_FIELDS = [
  'taskId',
  'readFirst',
  'codeHits',
  'knowledgeHits',
  'guardrails',
  'matchedScopes',
  'matchedGroups',
  'currentTaskPath',
  'lastContextPath'
];

function runCli(args, env = {}) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  };
}

function lastJsonLine(stdout) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length === 0) throw new Error('no stdout lines');
  return JSON.parse(lines[lines.length - 1]);
}

function listAllFiles(root) {
  if (!fs.existsSync(root)) return [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) return listAllFiles(full);
    return [full];
  });
}

describe('task-start --dry-run (PATCH_Phase1 §3-A/B/C)', () => {
  let tmpProjectDir;

  before(() => {
    tmpProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-start-dry-run-'));
  });

  after(() => {
    fs.rmSync(tmpProjectDir, { recursive: true, force: true });
  });

  it('outputs 9 mandatory fields as last stdout line', () => {
    const result = runCli(
      ['--dry-run', '--task', 'probe task', '--project-dir', tmpProjectDir]
    );
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);

    const json = lastJsonLine(result.stdout);
    for (const field of REQUIRED_FIELDS) {
      assert.ok(field in json, `missing field: ${field}`);
    }
  });

  it('outputs a single JSON line (no extra stdout noise)', () => {
    const result = runCli(
      ['--dry-run', '--task', 'single line check', '--project-dir', tmpProjectDir]
    );
    const lines = result.stdout.split(/\r?\n/).filter((line) => line.trim());
    assert.equal(lines.length, 1, `expected 1 stdout line, got ${lines.length}`);
  });

  it('does NOT create any files inside .claude/runtime/', () => {
    const runtimeRoot = path.join(tmpProjectDir, '.claude', 'runtime');
    // Ensure the directory is absent before the call.
    if (fs.existsSync(runtimeRoot)) {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }

    const result = runCli(
      ['--dry-run', '--task', 'side-effect audit', '--project-dir', tmpProjectDir]
    );
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);

    // No runtime dir => no current-task.json, tasks/*, events/*, last-context.json.
    assert.equal(
      fs.existsSync(runtimeRoot),
      false,
      'dry-run must not create .claude/runtime/'
    );
  });

  it('currentTaskPath and lastContextPath point at expected absolute paths', () => {
    const result = runCli(
      ['--dry-run', '--task', 'path shape', '--project-dir', tmpProjectDir]
    );
    const json = lastJsonLine(result.stdout);

    assert.ok(
      json.currentTaskPath.endsWith('.claude/runtime/current-task.json'),
      `currentTaskPath: ${json.currentTaskPath}`
    );
    assert.ok(
      json.lastContextPath.endsWith('.claude/runtime/retrieval/last-context.json'),
      `lastContextPath: ${json.lastContextPath}`
    );
  });

  it('sync field indicates skipped in dry-run', () => {
    const result = runCli(
      ['--dry-run', '--task', 'sync skip', '--project-dir', tmpProjectDir]
    );
    const json = lastJsonLine(result.stdout);
    assert.equal(json.sync?.skipped, true);
  });

  it('exits non-zero when --task is missing', () => {
    const result = runCli(['--dry-run', '--project-dir', tmpProjectDir]);
    assert.notEqual(result.status, 0);
  });

  it('non-dry-run writes current-task.json (baseline behavior unchanged)', () => {
    const freshProject = fs.mkdtempSync(path.join(os.tmpdir(), 'task-start-live-'));
    try {
      const result = runCli(
        ['--task', 'live write', '--project-dir', freshProject]
      );
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);

      const runtimeRoot = path.join(freshProject, '.claude', 'runtime');
      assert.equal(fs.existsSync(runtimeRoot), true, 'runtime dir must be created');
      assert.equal(
        fs.existsSync(path.join(runtimeRoot, 'current-task.json')),
        true,
        'current-task.json must be written'
      );

      const tasksRoot = path.join(runtimeRoot, 'tasks');
      const taskFiles = listAllFiles(tasksRoot);
      assert.ok(taskFiles.length >= 1, 'tasks/*.json must be written');
    } finally {
      fs.rmSync(freshProject, { recursive: true, force: true });
    }
  });
});
