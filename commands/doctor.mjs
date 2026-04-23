#!/usr/bin/env node

/**
 * Project runtime health diagnostic.
 *
 * Usage:
 *   claude-obsidian-runtime doctor [--project-dir <path>] [--full]
 *
 * Basic checks (always):
 *   1. CLAUDE_RUNTIME_HOME set and valid
 *   2. .claude/runtime-manifest.json exists and parses
 *   3. .claude/settings.json exists and parses
 *   4. .claude/hooks/ directory exists with expected shell wrappers
 *   5. document/obsidian_context/_meta/obsidian_paths.json exists
 *   6. Package version matches runtime-version.json
 *
 * Full checks (--full):
 *   7. runtime state dirs present and writable
 *   8. code-index/*.jsonl files exist and parse
 *   9. Hook shell wrappers have valid bash syntax (bash -n)
 *  10. Knowledge index (lessons/troubleshooting/decisions) parses and has rows
 *  11. Vault managedRoots are writable
 *  12. Active task pointer references an existing task record
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = { full: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project-dir' && argv[i + 1]) {
      args.projectDir = argv[i + 1]; i++;
    } else if (argv[i] === '--full') {
      args.full = true;
    } else if (argv[i] === '--json') {
      args.json = true;
    }
  }
  args.projectDir = path.resolve(args.projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  return args;
}

function loadJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function pkgVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version; }
  catch { return 'unknown'; }
}

const EXPECTED_HOOKS = [
  'runtime-session-start.sh',
  'runtime-prompt-context.sh',
  'runtime-subagent-start.sh',
  'runtime-stop.sh',
  'runtime-session-end.sh',
  'runtime-post-edit.sh'
];

class Check {
  constructor(name) {
    this.name = name;
    this.status = 'pending';
    this.message = '';
    this.detail = null;
  }
  pass(message, detail) { this.status = 'pass'; this.message = message || 'OK'; this.detail = detail; return this; }
  warn(message, detail) { this.status = 'warn'; this.message = message; this.detail = detail; return this; }
  fail(message, detail) { this.status = 'fail'; this.message = message; this.detail = detail; return this; }
}

function checkRuntimeHome() {
  const c = new Check('CLAUDE_RUNTIME_HOME');
  const home = process.env.CLAUDE_RUNTIME_HOME;
  if (!home) {
    return c.warn('Not set. Hooks will fall back to legacy paths.', { remedy: 'export CLAUDE_RUNTIME_HOME=<absolute path to claude-obsidian-runtime>' });
  }
  if (!fs.existsSync(home)) {
    return c.fail(`Directory does not exist: ${home}`, { remedy: 'Check the path or clone claude-obsidian-runtime there.' });
  }
  const pkg = path.join(home, 'package.json');
  if (!fs.existsSync(pkg)) {
    return c.fail(`No package.json found in ${home}`, { remedy: 'Verify CLAUDE_RUNTIME_HOME points to the package root.' });
  }
  return c.pass(`Set to ${home}`);
}

function checkManifest(projectDir) {
  const c = new Check('runtime-manifest.json');
  const p = path.join(projectDir, '.claude', 'runtime-manifest.json');
  if (!fs.existsSync(p)) {
    return c.warn(`Missing at ${p}`, { remedy: 'Run: claude-obsidian-runtime init --project-id <id>' });
  }
  const data = loadJsonSafe(p);
  if (!data) return c.fail(`Invalid JSON at ${p}`);
  if (!data.runtimeVersion) return c.warn('Missing runtimeVersion field', { data });
  return c.pass(`v${data.runtimeVersion}, coreHooks: ${JSON.stringify(data.coreHooks)}`);
}

function checkSettings(projectDir) {
  const c = new Check('.claude/settings.json');
  const p = path.join(projectDir, '.claude', 'settings.json');
  if (!fs.existsSync(p)) return c.fail(`Missing at ${p}`);
  const data = loadJsonSafe(p);
  if (!data) return c.fail(`Invalid JSON at ${p}`);
  const hookCount = Object.keys(data.hooks || {}).length;
  return c.pass(`${hookCount} hook event(s) registered`);
}

function checkHookFiles(projectDir) {
  const c = new Check('.claude/hooks/ shell wrappers');
  const dir = path.join(projectDir, '.claude', 'hooks');
  if (!fs.existsSync(dir)) return c.fail(`Directory missing: ${dir}`);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sh'));
  const missing = EXPECTED_HOOKS.filter((h) => !files.includes(h));
  if (missing.length > 0) {
    return c.warn(`Missing expected hooks: ${missing.join(', ')}`, { found: files, expected: EXPECTED_HOOKS });
  }
  return c.pass(`${files.length} shell wrapper(s) present`, { files });
}

function checkObsidianPaths(projectDir) {
  const c = new Check('obsidian_paths.json');
  const p = path.join(projectDir, 'document', 'obsidian_context', '_meta', 'obsidian_paths.json');
  if (!fs.existsSync(p)) {
    return c.warn(`Missing at ${p}`, { remedy: 'Run: claude-obsidian-runtime init' });
  }
  const data = loadJsonSafe(p);
  if (!data) return c.fail(`Invalid JSON at ${p}`);
  if (!data.vaultRoot) return c.warn('No vaultRoot defined');
  if (!fs.existsSync(data.vaultRoot)) return c.warn(`vaultRoot does not exist: ${data.vaultRoot}`);
  return c.pass(`vault: ${data.vaultRoot}, managedRoots: ${(data.managedRoots || []).length}`);
}

function checkVersion(projectDir) {
  const c = new Check('runtime-version.json');
  const p = path.join(projectDir, '.claude', 'runtime', 'runtime-version.json');
  const pkgV = pkgVersion();
  if (!fs.existsSync(p)) {
    return c.warn(`Missing at ${p} (expected after first install-hooks)`, { packageVersion: pkgV });
  }
  const data = loadJsonSafe(p);
  if (!data) return c.fail(`Invalid JSON at ${p}`);
  if (data.installedVersion !== pkgV) {
    return c.warn(`Version mismatch: installed ${data.installedVersion}, package ${pkgV}`, { remedy: 'Run: claude-obsidian-runtime upgrade' });
  }
  return c.pass(`installedVersion ${data.installedVersion} matches package`);
}

function checkRuntimeDirs(projectDir) {
  const c = new Check('runtime state dirs');
  const root = path.join(projectDir, '.claude', 'runtime');
  const required = ['tasks', 'events', 'retrieval', 'code-index', 'knowledge'];
  const missing = required.filter((d) => !fs.existsSync(path.join(root, d)));
  if (missing.length > 0) {
    return c.warn(`Missing dirs: ${missing.join(', ')}`, { remedy: 'Will be created on first task-start' });
  }
  return c.pass(`All 5 runtime dirs exist`);
}

function checkCodeIndex(projectDir) {
  const c = new Check('code-index/*.jsonl');
  const dir = path.join(projectDir, '.claude', 'runtime', 'code-index');
  if (!fs.existsSync(dir)) return c.warn('No code-index dir yet');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  if (files.length === 0) return c.warn('No index files yet. Run: claude-obsidian-runtime sync');
  const total = files.reduce((sum, f) => {
    try { return sum + fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).length; }
    catch { return sum; }
  }, 0);
  return c.pass(`${files.length} index file(s), ${total} total rows`);
}

function checkHookSyntax(projectDir) {
  const c = new Check('hook wrapper syntax (bash -n)');
  const dir = path.join(projectDir, '.claude', 'hooks');
  if (!fs.existsSync(dir)) return c.warn('Hooks dir missing, skipped');

  const wrappers = fs.readdirSync(dir).filter((f) => f.endsWith('.sh'));
  if (wrappers.length === 0) return c.warn('No shell wrappers to check');

  const failures = [];
  for (const wrapper of wrappers) {
    const full = path.join(dir, wrapper);
    const result = spawnSync('bash', ['-n', full], { encoding: 'utf8' });
    if (result.error) {
      return c.warn('bash unavailable, skipped syntax check', { remedy: 'Install bash (e.g., Git Bash on Windows)' });
    }
    if (result.status !== 0) {
      failures.push({ file: wrapper, stderr: (result.stderr || '').slice(0, 200) });
    }
  }
  if (failures.length > 0) {
    return c.fail(`${failures.length} wrapper(s) have syntax errors`, { failures });
  }
  return c.pass(`${wrappers.length} wrapper(s) parse cleanly`);
}

function checkKnowledgeIndex(projectDir) {
  const c = new Check('knowledge/*.jsonl');
  const dir = path.join(projectDir, '.claude', 'runtime', 'knowledge');
  if (!fs.existsSync(dir)) return c.warn('No knowledge dir yet');

  const expected = ['lessons.jsonl', 'troubleshooting.jsonl', 'decisions.jsonl'];
  const report = {};
  let malformed = 0;
  for (const name of expected) {
    const full = path.join(dir, name);
    if (!fs.existsSync(full)) { report[name] = 'missing'; continue; }
    try {
      const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/).filter(Boolean);
      let seeds = 0, parsed = 0;
      for (const line of lines) {
        try {
          const row = JSON.parse(line);
          parsed += 1;
          if (String(row.id || '').startsWith('seed:')) seeds += 1;
        } catch { malformed += 1; }
      }
      report[name] = `${parsed} rows (${seeds} seed)`;
    } catch (err) {
      report[name] = `read error: ${err.message}`;
    }
  }

  if (malformed > 0) {
    return c.fail(`${malformed} malformed JSONL row(s)`, { report, remedy: 'Run: claude-obsidian-runtime sync to rebuild' });
  }
  const allMissing = Object.values(report).every((v) => v === 'missing');
  if (allMissing) {
    return c.warn('No knowledge index files yet', { remedy: 'Run: claude-obsidian-runtime sync' });
  }
  return c.pass(Object.entries(report).map(([k, v]) => `${k}=${v}`).join(', '));
}

function checkVaultWritable(projectDir) {
  const c = new Check('vault managedRoots writable');
  const p = path.join(projectDir, 'document', 'obsidian_context', '_meta', 'obsidian_paths.json');
  const data = loadJsonSafe(p);
  if (!data) return c.warn('obsidian_paths.json missing/invalid, skipped');
  if (!data.vaultRoot || !fs.existsSync(data.vaultRoot)) {
    return c.warn(`vaultRoot not accessible: ${data.vaultRoot}`);
  }
  const managed = Array.isArray(data.managedRoots) ? data.managedRoots : [];
  if (managed.length === 0) return c.warn('No managedRoots configured');

  const missing = [];
  const unwritable = [];
  for (const root of managed) {
    const target = path.isAbsolute(root) ? root : path.join(data.vaultRoot, root);
    if (!fs.existsSync(target)) { missing.push(root); continue; }
    try {
      const probe = path.join(target, `.doctor-write-${Date.now()}.tmp`);
      fs.writeFileSync(probe, 'probe');
      fs.unlinkSync(probe);
    } catch (err) {
      unwritable.push({ root, reason: err.code || err.message });
    }
  }
  if (unwritable.length > 0) {
    return c.fail(`${unwritable.length} managed root(s) not writable`, { unwritable, missing });
  }
  if (missing.length > 0) {
    return c.warn(`${missing.length} managed root(s) not created yet`, { missing, remedy: 'Will be created on first write via writeVaultArtifact' });
  }
  return c.pass(`${managed.length} managed root(s) writable`);
}

function checkActiveTaskPointer(projectDir) {
  const c = new Check('active task pointer integrity');
  const pointerPath = path.join(projectDir, '.claude', 'runtime', 'tasks', 'current.json');
  if (!fs.existsSync(pointerPath)) return c.pass('No active task (clean state)');

  const pointer = loadJsonSafe(pointerPath);
  if (!pointer) return c.fail(`Invalid JSON at ${pointerPath}`);

  const taskId = pointer.taskId;
  if (!taskId) return c.warn('Pointer has no taskId field');

  const taskPath = pointer.taskPath
    ? (path.isAbsolute(pointer.taskPath) ? pointer.taskPath : path.join(projectDir, pointer.taskPath))
    : path.join(projectDir, '.claude', 'runtime', 'tasks', `${taskId}.json`);

  if (!fs.existsSync(taskPath)) {
    return c.fail(`Pointer references missing task: ${taskId}`, { remedy: 'Delete tasks/current.json or run task-close' });
  }

  const task = loadJsonSafe(taskPath);
  if (!task) return c.fail(`Task record is invalid JSON: ${taskPath}`);
  return c.pass(`Active task ${taskId} :: ${task.title || task.prompt || '(no title)'}`);
}

function printReport(checks) {
  const icons = { pass: '[OK]', warn: '[WARN]', fail: '[FAIL]', pending: '[...]' };
  let hasFail = false;
  for (const c of checks) {
    if (c.status === 'fail') hasFail = true;
    console.log(`${icons[c.status].padEnd(7)} ${c.name.padEnd(35)} ${c.message}`);
    if (c.detail?.remedy) console.log(`        -> ${c.detail.remedy}`);
  }
  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const c of checks) counts[c.status]++;
  console.log('');
  console.log(`Summary: ${counts.pass} pass, ${counts.warn} warn, ${counts.fail} fail`);
  return hasFail ? 1 : 0;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const checks = [
    checkRuntimeHome(),
    checkManifest(args.projectDir),
    checkSettings(args.projectDir),
    checkHookFiles(args.projectDir),
    checkObsidianPaths(args.projectDir),
    checkVersion(args.projectDir)
  ];

  if (args.full) {
    checks.push(checkRuntimeDirs(args.projectDir));
    checks.push(checkCodeIndex(args.projectDir));
    checks.push(checkHookSyntax(args.projectDir));
    checks.push(checkKnowledgeIndex(args.projectDir));
    checks.push(checkVaultWritable(args.projectDir));
    checks.push(checkActiveTaskPointer(args.projectDir));
  }

  if (args.json) {
    const counts = { pass: 0, warn: 0, fail: 0 };
    for (const c of checks) counts[c.status]++;
    process.stdout.write(JSON.stringify({
      package: pkgVersion(),
      projectDir: args.projectDir,
      mode: args.full ? 'full' : 'basic',
      counts,
      checks: checks.map((c) => ({ name: c.name, status: c.status, message: c.message, detail: c.detail }))
    }, null, 2) + '\n');
    process.exit(counts.fail > 0 ? 1 : 0);
  }

  console.log(`claude-obsidian-runtime doctor`);
  console.log(`Package:     v${pkgVersion()}`);
  console.log(`Project:     ${args.projectDir}`);
  console.log(`Mode:        ${args.full ? 'full' : 'basic'}`);
  console.log('');
  const exitCode = printReport(checks);
  process.exit(exitCode);
}

main();
