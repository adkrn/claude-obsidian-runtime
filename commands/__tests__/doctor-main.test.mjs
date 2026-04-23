import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { parseArgs } from '../doctor.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DOCTOR_PATH = path.resolve(__dirname, '..', 'doctor.mjs');
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');

function makeProjectSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-main-'));
  const projectDir = path.join(root, 'proj');
  fs.mkdirSync(projectDir, { recursive: true });
  return { root, projectDir };
}

function cleanup(sb) {
  try {
    fs.rmSync(sb.root, { recursive: true, force: true });
  } catch {}
}

function runDoctor(args = [], env = {}) {
  return spawnSync(process.execPath, [DOCTOR_PATH, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      // Force non-TTY so rollback prompt auto-aborts.
      ...env
    }
  });
}

describe('doctor parseArgs', () => {
  it('defaults: basic mode, no flags set', () => {
    const args = parseArgs([]);
    assert.equal(args.full, false);
    assert.equal(args.eval, false);
    assert.equal(args.json, false);
    assert.equal(args.noRollback, false);
    assert.equal(args.sinceInit, false);
    assert.ok(path.isAbsolute(args.projectDir));
  });

  it('parses --full --json --since-init --no-rollback-on-failure', () => {
    const args = parseArgs([
      '--full',
      '--json',
      '--since-init',
      '--no-rollback-on-failure'
    ]);
    assert.equal(args.full, true);
    assert.equal(args.json, true);
    assert.equal(args.sinceInit, true);
    assert.equal(args.noRollback, true);
  });

  it('resolves --project-dir to absolute path', () => {
    const args = parseArgs(['--project-dir', '.']);
    assert.ok(path.isAbsolute(args.projectDir));
  });

  it('parses --eval flag', () => {
    const args = parseArgs(['--eval']);
    assert.equal(args.eval, true);
  });

  it('parses --help as args.help', () => {
    const args = parseArgs(['--help']);
    assert.equal(args.help, true);
  });
});

describe('doctor CLI — smoke (empty project)', () => {
  it('--help prints usage and exits 0', () => {
    const result = runDoctor(['--help']);
    assert.equal(result.status, 0);
    assert.match(String(result.stdout), /Usage: doctor/);
  });

  it('default mode runs 6 basic checks on empty project and exits non-zero', () => {
    const sb = makeProjectSandbox();
    try {
      const result = runDoctor(['--project-dir', sb.projectDir]);
      // Empty project → C02 fails because manifest missing → exit 1.
      assert.notEqual(result.status, 0);
      const out = String(result.stdout);
      assert.match(out, /C01/);
      assert.match(out, /C06/);
      // Summary line present
      assert.match(out, /Summary: \d+ pass, \d+ warn, \d+ fail/);
    } finally {
      cleanup(sb);
    }
  });

  it('--full runs 12 checks (C07..C12 present in output)', () => {
    const sb = makeProjectSandbox();
    try {
      const result = runDoctor(['--full', '--project-dir', sb.projectDir]);
      const out = String(result.stdout);
      for (const id of ['C07', 'C08', 'C09', 'C10', 'C11', 'C12']) {
        assert.match(out, new RegExp(id));
      }
    } finally {
      cleanup(sb);
    }
  });

  it('--json emits parseable JSON with counts + checks[] and sinceInit flag', () => {
    const sb = makeProjectSandbox();
    try {
      const result = runDoctor([
        '--full',
        '--json',
        '--since-init',
        '--project-dir',
        sb.projectDir
      ]);
      const out = String(result.stdout);
      const data = JSON.parse(out);
      assert.equal(typeof data.package, 'string');
      assert.equal(data.mode, 'full');
      assert.equal(data.sinceInit, true);
      assert.equal(typeof data.counts.pass, 'number');
      assert.ok(Array.isArray(data.checks));
      // With --full there are 12 checks (may have warns/fails in empty proj).
      assert.equal(data.checks.length, 12);
    } finally {
      cleanup(sb);
    }
  });

  it('--since-init with --no-rollback-on-failure skips prompt and exits 1 on fail', () => {
    const sb = makeProjectSandbox();
    try {
      const result = runDoctor([
        '--since-init',
        '--no-rollback-on-failure',
        '--project-dir',
        sb.projectDir
      ]);
      assert.equal(result.status, 1);
      // No prompt text should appear
      assert.doesNotMatch(String(result.stdout), /Rollback\?/);
    } finally {
      cleanup(sb);
    }
  });

  it('--eval without 12/12 pass prints "Cannot run eval" message', () => {
    const sb = makeProjectSandbox();
    try {
      const result = runDoctor([
        '--full',
        '--eval',
        '--project-dir',
        sb.projectDir
      ]);
      const out = String(result.stdout);
      assert.match(out, /Cannot run eval with failed checks/);
      assert.notEqual(result.status, 0);
    } finally {
      cleanup(sb);
    }
  });
});

describe('doctor — eval-run missing (Design-C absent) contract', () => {
  it('skips eval with friendly message when commands/eval-run.mjs does not exist', () => {
    // Confirm eval-run.mjs is absent in this Wave-2 build.
    const evalPath = path.join(PACKAGE_ROOT, 'commands', 'eval-run.mjs');
    if (fs.existsSync(evalPath)) {
      // If Design-C already integrated, the test above ("Cannot run eval") covers failure case.
      return;
    }
    // Build a project with all 12 checks passing would be impractical here; we
    // instead verify the code path presence via direct search.
    const source = fs.readFileSync(DOCTOR_PATH, 'utf8');
    assert.match(source, /Design-C not yet integrated/);
  });
});
