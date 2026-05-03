import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  parseArgs,
  runInit,
  DEFAULT_MANAGED_ROOTS_9,
  substitute,
  ensureSettingsLocalEnv
} from '../init-project.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INIT_PATH = path.resolve(__dirname, '..', 'init-project.mjs');

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'init-project-'));
  const projectDir = path.join(root, 'proj');
  const vaultRoot = path.join(root, 'vault');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(vaultRoot, { recursive: true });
  return { root, projectDir, vaultRoot };
}

function cleanup(sb) {
  try { fs.rmSync(sb.root, { recursive: true, force: true }); } catch {}
}

function runCli(args, { env = {} } = {}) {
  return spawnSync(process.execPath, [INIT_PATH, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

describe('init-project — parseArgs', () => {
  it('parses all supported flags', () => {
    const args = parseArgs([
      '--project-id', 'alpha',
      '--project-dir', '/tmp/a',
      '--vault-root', '/tmp/v',
      '--preserve',
      '--no-doctor',
      '--force',
      '--skip-hooks'
    ]);
    assert.equal(args.projectId, 'alpha');
    assert.equal(args.projectDir, '/tmp/a');
    assert.equal(args.vaultRoot, '/tmp/v');
    assert.equal(args.preserve, true);
    assert.equal(args.noDoctor, true);
    assert.equal(args.force, true);
    assert.equal(args.skipHooks, true);
  });

  it('defaults all flags to false when omitted', () => {
    const args = parseArgs(['--project-id', 'alpha']);
    assert.equal(args.preserve, false);
    assert.equal(args.noDoctor, false);
    assert.equal(args.force, false);
  });
});

describe('init-project — substitute', () => {
  it('replaces placeholders repeatedly', () => {
    const out = substitute('{{PROJECT_ID}} / {{VAULT_ROOT}} / {{PROJECT_ID}}', {
      PROJECT_ID: 'x',
      VAULT_ROOT: '/v'
    });
    assert.equal(out, 'x / /v / x');
  });
});

describe('init-project — runInit (Case 1: fresh init → 9 managedRoots + lead)', () => {
  let sb;
  before(() => { sb = makeSandbox(); });
  after(() => cleanup(sb));

  it('creates all 9 managed roots + <projectId>-lead.md', () => {
    const report = runInit({
      projectId: 'testproj',
      projectDir: sb.projectDir,
      vaultRoot: sb.vaultRoot
    });
    for (const root of DEFAULT_MANAGED_ROOTS_9) {
      const abs = path.join(sb.vaultRoot, ...root.split('/'));
      assert.ok(fs.existsSync(abs), `missing managed root: ${root}`);
      assert.ok(fs.statSync(abs).isDirectory(), `${root} is not a directory`);
    }
    assert.ok(fs.existsSync(path.join(sb.vaultRoot, '08_Reflections')));
    assert.ok(fs.existsSync(path.join(sb.vaultRoot, '09_Templates', 'Procedures')));

    const leadPath = path.join(sb.projectDir, '.claude', 'agents', 'testproj-lead.md');
    assert.ok(fs.existsSync(leadPath), 'lead agent file not created');
    assert.equal(report.leadPath, leadPath);
    assert.ok(report.created.includes(leadPath));

    const manifestPath = path.join(sb.projectDir, '.claude', 'runtime-manifest.json');
    assert.ok(fs.existsSync(manifestPath));

    const goldenPath = path.join(sb.projectDir, '.claude', 'runtime', 'eval', 'golden-tasks.json');
    assert.ok(fs.existsSync(goldenPath), 'golden-tasks.json not copied');
  });
});

describe('init-project — runInit (Case 2: re-run with existing files preserved)', () => {
  let sb;
  before(() => { sb = makeSandbox(); });
  after(() => cleanup(sb));

  it('does not overwrite existing lead or agent files on second run', () => {
    runInit({
      projectId: 'preserveproj',
      projectDir: sb.projectDir,
      vaultRoot: sb.vaultRoot
    });

    const leadPath = path.join(sb.projectDir, '.claude', 'agents', 'preserveproj-lead.md');
    const customAgentPath = path.join(sb.projectDir, '.claude', 'agents', 'custom-specialist.md');
    fs.writeFileSync(customAgentPath, '# custom specialist — must survive', 'utf8');
    fs.writeFileSync(leadPath, '# MODIFIED LEAD — must survive when preserve=true', 'utf8');

    const report2 = runInit({
      projectId: 'preserveproj',
      projectDir: sb.projectDir,
      vaultRoot: sb.vaultRoot,
      preserve: true
    });

    assert.ok(fs.existsSync(customAgentPath));
    assert.equal(fs.readFileSync(customAgentPath, 'utf8'), '# custom specialist — must survive');
    assert.ok(
      fs.readFileSync(leadPath, 'utf8').startsWith('# MODIFIED LEAD'),
      'lead was overwritten despite preserve=true'
    );
    assert.ok(report2.skipped.includes(leadPath), 'lead should be in skipped list');
  });
});

describe('init-project — runInit (Case 3: {{PROJECT_ID}} substitution accuracy)', () => {
  let sb;
  before(() => { sb = makeSandbox(); });
  after(() => cleanup(sb));

  it('substitutes placeholders in lead.md, manifest, paths.json', () => {
    runInit({
      projectId: 'alphaX',
      projectDir: sb.projectDir,
      vaultRoot: sb.vaultRoot
    });

    const leadContent = fs.readFileSync(
      path.join(sb.projectDir, '.claude', 'agents', 'alphaX-lead.md'),
      'utf8'
    );
    assert.match(leadContent, /name: alphaX-lead/);
    assert.match(leadContent, /# alphaX-lead/);
    assert.ok(!leadContent.includes('{{PROJECT_ID}}'), 'lead.md has unresolved placeholder');

    const manifestContent = JSON.parse(fs.readFileSync(
      path.join(sb.projectDir, '.claude', 'runtime-manifest.json'),
      'utf8'
    ));
    assert.equal(manifestContent.projectTag, 'alphaX');

    const pathsContent = JSON.parse(fs.readFileSync(
      path.join(sb.projectDir, 'document', 'obsidian_context', '_meta', 'obsidian_paths.json'),
      'utf8'
    ));
    assert.equal(pathsContent.projectId, 'alphaX');
    assert.equal(pathsContent.vaultRoot, sb.vaultRoot.replace(/\\/g, '/'));

    const indexPath = path.join(sb.vaultRoot, '00_Home', 'alphaX_Index.md');
    assert.ok(fs.existsSync(indexPath), 'vault index not renamed with projectId');
  });
});

describe('init-project — CLI (Case 4: --no-doctor skips doctor auto-invoke)', () => {
  let sb;
  before(() => { sb = makeSandbox(); });
  after(() => cleanup(sb));

  it('completes without invoking doctor when --no-doctor', () => {
    const result = runCli([
      '--project-id', 'nodoctor',
      '--project-dir', sb.projectDir,
      '--vault-root', sb.vaultRoot,
      '--no-doctor',
      '--skip-hooks'
    ]);
    assert.equal(result.status, 0, `init exit ${result.status}: ${result.stderr}`);
    assert.match(result.stdout, /\[doctor\] Skipped \(--no-doctor\)/);
    assert.doesNotMatch(result.stdout, /Running doctor --full/);
    const leadPath = path.join(sb.projectDir, '.claude', 'agents', 'nodoctor-lead.md');
    assert.ok(fs.existsSync(leadPath));
  });
});

describe('init-project — CLI (Case 5: missing args → exit 2)', () => {
  it('exits 2 with error when --project-id missing', () => {
    const result = runCli(['--vault-root', '/tmp/x']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--project-id and --vault-root are required/);
  });

  it('exits 2 with error when --vault-root missing', () => {
    const result = runCli(['--project-id', 'x']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--project-id and --vault-root are required/);
  });
});

describe('init-project — CLI (Case 6: --force overwrites lead despite preserve)', () => {
  let sb;
  before(() => { sb = makeSandbox(); });
  after(() => cleanup(sb));

  it('overwrites lead when --force passed (preserve=false)', () => {
    const leadPath = path.join(sb.projectDir, '.claude', 'agents', 'forceproj-lead.md');
    fs.mkdirSync(path.dirname(leadPath), { recursive: true });
    fs.writeFileSync(leadPath, '# OLD LEAD', 'utf8');

    const report = runInit({
      projectId: 'forceproj',
      projectDir: sb.projectDir,
      vaultRoot: sb.vaultRoot,
      force: true
    });

    assert.ok(report.created.includes(leadPath), 'lead should be in created (overwritten)');
    const newContent = fs.readFileSync(leadPath, 'utf8');
    assert.match(newContent, /name: forceproj-lead/);
    assert.ok(!newContent.startsWith('# OLD LEAD'));
  });
});

describe('ensureSettingsLocalEnv (v3.3.4 — auto-inject CLAUDE_RUNTIME_HOME)', () => {
  function makeProj() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-env-'));
    const projectDir = path.join(root, 'proj');
    fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
    return { root, projectDir };
  }
  function cleanProj(p) {
    try { fs.rmSync(p.root, { recursive: true, force: true }); } catch {}
  }
  const RUNTIME = 'c:/JSProj/claude-obsidian-runtime';

  it('CASE 1: file missing → create minimal with env', () => {
    const sb = makeProj();
    try {
      const status = ensureSettingsLocalEnv(sb.projectDir, RUNTIME);
      assert.equal(status, 'created');
      const settingsPath = path.join(sb.projectDir, '.claude', 'settings.local.json');
      assert.ok(fs.existsSync(settingsPath));
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      assert.equal(parsed.env.CLAUDE_RUNTIME_HOME, RUNTIME);
    } finally { cleanProj(sb); }
  });

  it('CASE 2: file exists with permissions only → add env block (preserve other keys)', () => {
    const sb = makeProj();
    try {
      const settingsPath = path.join(sb.projectDir, '.claude', 'settings.local.json');
      fs.writeFileSync(settingsPath, JSON.stringify({
        permissions: { allow: ['Bash(echo:*)'] }
      }, null, 2));
      const status = ensureSettingsLocalEnv(sb.projectDir, RUNTIME);
      assert.equal(status, 'added');
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      assert.equal(parsed.env.CLAUDE_RUNTIME_HOME, RUNTIME);
      assert.deepEqual(parsed.permissions.allow, ['Bash(echo:*)']);
    } finally { cleanProj(sb); }
  });

  it('CASE 3: env exists but no CLAUDE_RUNTIME_HOME → add the key (preserve other env)', () => {
    const sb = makeProj();
    try {
      const settingsPath = path.join(sb.projectDir, '.claude', 'settings.local.json');
      fs.writeFileSync(settingsPath, JSON.stringify({
        env: { OTHER_VAR: 'preserve-me' }
      }, null, 2));
      const status = ensureSettingsLocalEnv(sb.projectDir, RUNTIME);
      assert.equal(status, 'added');
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      assert.equal(parsed.env.CLAUDE_RUNTIME_HOME, RUNTIME);
      assert.equal(parsed.env.OTHER_VAR, 'preserve-me');
    } finally { cleanProj(sb); }
  });

  it('CASE 4: CLAUDE_RUNTIME_HOME already set → preserve user value (no overwrite)', () => {
    const sb = makeProj();
    try {
      const settingsPath = path.join(sb.projectDir, '.claude', 'settings.local.json');
      const userValue = 'D:/custom/runtime/path';
      fs.writeFileSync(settingsPath, JSON.stringify({
        env: { CLAUDE_RUNTIME_HOME: userValue }
      }, null, 2));
      const status = ensureSettingsLocalEnv(sb.projectDir, RUNTIME);
      assert.equal(status, 'present');
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      assert.equal(parsed.env.CLAUDE_RUNTIME_HOME, userValue, 'user value must not be overwritten');
    } finally { cleanProj(sb); }
  });

  it('CASE 5: malformed JSON → return parse-error (do not destroy file)', () => {
    const sb = makeProj();
    try {
      const settingsPath = path.join(sb.projectDir, '.claude', 'settings.local.json');
      const malformed = '{ "permissions": { broken json';
      fs.writeFileSync(settingsPath, malformed);
      const status = ensureSettingsLocalEnv(sb.projectDir, RUNTIME);
      assert.equal(status, 'parse-error');
      const after = fs.readFileSync(settingsPath, 'utf8');
      assert.equal(after, malformed, 'malformed file must be preserved as-is');
    } finally { cleanProj(sb); }
  });

  it('CASE 6: backslash path normalized to forward slashes', () => {
    const sb = makeProj();
    try {
      const status = ensureSettingsLocalEnv(sb.projectDir, 'C:\\JSProj\\claude-obsidian-runtime');
      assert.equal(status, 'created');
      const settingsPath = path.join(sb.projectDir, '.claude', 'settings.local.json');
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      assert.equal(parsed.env.CLAUDE_RUNTIME_HOME, 'C:/JSProj/claude-obsidian-runtime');
    } finally { cleanProj(sb); }
  });
});
