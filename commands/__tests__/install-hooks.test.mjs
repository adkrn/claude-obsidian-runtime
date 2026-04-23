import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'commands', 'install-hooks.mjs');
const TEMPLATE_HOOKS = path.join(REPO_ROOT, 'templates', 'hooks');

function run(argv, env = {}) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...argv], {
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  };
}

function parseJsonStdout(stdout) {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  const last = lines.at(-1) || '';
  return JSON.parse(last);
}

function makeProjectDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'install-hooks-test-'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function listTemplateCore() {
  return fs.readdirSync(TEMPLATE_HOOKS).filter((f) => f.endsWith('.sh')).sort();
}

describe('install-hooks CLI — template copy mode', () => {
  let projectDir;

  beforeEach(() => {
    if (projectDir) cleanup(projectDir);
    projectDir = makeProjectDir();
  });

  after(() => { if (projectDir) cleanup(projectDir); });

  it('exits 2 when --project-dir is missing', () => {
    const { status, stderr } = run([]);
    assert.equal(status, 2);
    assert.match(stderr, /--project-dir is required/);
  });

  it('prints help with --help (exit 0)', () => {
    const { status, stdout } = run(['--help']);
    assert.equal(status, 0);
    assert.match(stdout, /Usage: install-hooks/);
    assert.match(stdout, /--dry-run/);
    assert.match(stdout, /--from-manifest/);
  });

  it('empty hooks dir → installs all core hooks from templates', () => {
    const { status, stdout } = run(['--project-dir', projectDir]);
    assert.equal(status, 0);
    const json = parseJsonStdout(stdout);
    const coreHooks = listTemplateCore();
    assert.deepEqual(json.installed.sort(), coreHooks);
    assert.deepEqual(json.preserved, []);
    assert.deepEqual(json.skipped, []);

    // Files actually exist on disk
    for (const f of coreHooks) {
      assert.ok(fs.existsSync(path.join(projectDir, '.claude', 'hooks', f)), `missing ${f}`);
    }
  });

  it('preserves project-specific hook already in hooksDir when listed in --preserve', () => {
    const hooksDir = path.join(projectDir, '.claude', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    // User-local hook name that overlaps with one core hook — should be preserved
    const coreHooks = listTemplateCore();
    const preserveTarget = coreHooks[0];
    fs.writeFileSync(path.join(hooksDir, preserveTarget), '#!/bin/bash\necho user-local\n');

    const { status, stdout } = run([
      '--project-dir', projectDir,
      '--preserve', preserveTarget
    ]);
    assert.equal(status, 0);
    const json = parseJsonStdout(stdout);
    assert.ok(json.preserved.includes(preserveTarget), `preserved should include ${preserveTarget}`);
    assert.ok(!json.installed.includes(preserveTarget));

    // The preserved file is NOT overwritten
    const content = fs.readFileSync(path.join(hooksDir, preserveTarget), 'utf8');
    assert.match(content, /user-local/);
  });

  it('--force overwrites existing core hooks', () => {
    const hooksDir = path.join(projectDir, '.claude', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const coreHooks = listTemplateCore();
    const first = coreHooks[0];
    fs.writeFileSync(path.join(hooksDir, first), '#!/bin/bash\necho STALE\n');

    const { status, stdout } = run([
      '--project-dir', projectDir,
      '--force'
    ]);
    assert.equal(status, 0);
    const json = parseJsonStdout(stdout);
    assert.ok(json.installed.includes(first), `force should overwrite ${first}`);

    const content = fs.readFileSync(path.join(hooksDir, first), 'utf8');
    assert.doesNotMatch(content, /STALE/);
  });

  it('--dry-run prints plan but writes no files', () => {
    const { status, stdout } = run([
      '--project-dir', projectDir,
      '--dry-run'
    ]);
    assert.equal(status, 0);
    const json = parseJsonStdout(stdout);
    const coreHooks = listTemplateCore();
    assert.deepEqual(json.installed.sort(), coreHooks);

    // No real files written
    const hooksDir = path.join(projectDir, '.claude', 'hooks');
    if (fs.existsSync(hooksDir)) {
      const actual = fs.readdirSync(hooksDir);
      assert.equal(actual.length, 0, `dry-run should not write files, found: ${actual.join(',')}`);
    }
  });

  it('--from-manifest reads preserveHooks from runtime-manifest.json', () => {
    const hooksDir = path.join(projectDir, '.claude', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    // Pre-existing project-specific hook (not a core hook name)
    fs.writeFileSync(path.join(hooksDir, 'error-detector.sh'), '#!/bin/bash\necho detector\n');

    const manifestPath = path.join(projectDir, '.claude', 'runtime-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      projectTag: 'testproj',
      defaultScope: 'backend',
      surfacePatterns: [],
      scopeFolderMap: {},
      preserveHooks: ['error-detector.sh'],
      sessionEndPipeline: []
    }));

    const { status, stdout } = run([
      '--project-dir', projectDir,
      '--from-manifest'
    ]);
    assert.equal(status, 0);
    const json = parseJsonStdout(stdout);
    assert.ok(json.preserved.includes('error-detector.sh'), 'preserved should include manifest entry');

    // error-detector.sh was NOT overwritten
    const content = fs.readFileSync(path.join(hooksDir, 'error-detector.sh'), 'utf8');
    assert.match(content, /detector/);

    // Core hooks were still installed
    const coreHooks = listTemplateCore();
    for (const f of coreHooks) {
      assert.ok(json.installed.includes(f), `core ${f} should be installed`);
    }
  });

  it('1-line verification: installed.length >= 5 on fresh project', () => {
    const { status, stdout } = run(['--project-dir', projectDir]);
    assert.equal(status, 0);
    const json = parseJsonStdout(stdout);
    assert.ok(json.installed.length >= 5, `installed count=${json.installed.length}`);
  });
});
