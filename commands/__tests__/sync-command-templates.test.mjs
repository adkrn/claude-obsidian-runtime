import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncCommandTemplates } from '../install-hooks.mjs';

// Root cause of the recurring "trigger_keywords empty" reports: improving the
// engine's templates/commands/*.md never reached project copies because no CLI
// synced them (upgrade only ran install-hooks, which handled .sh only). This
// verifies syncCommandTemplates actually copies the .md instruction files,
// backs up changed ones, and honors an opt-out.

let pkgRoot, projectDir;

function write(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-cmd-'));
  pkgRoot = path.join(base, 'pkg');
  projectDir = path.join(base, 'proj');
  // engine templates
  write(path.join(pkgRoot, 'templates', 'commands', 'task-close.md'), 'NEW task-close v2\ntrigger_keywords 꼭 채워라\n');
  write(path.join(pkgRoot, 'templates', 'commands', 'task-start.md'), 'NEW task-start v2\n');
});

afterEach(() => {
  try { fs.rmSync(path.dirname(pkgRoot), { recursive: true, force: true }); } catch {}
});

describe('syncCommandTemplates', () => {
  it('copies all template command .md files into .claude/commands (fresh project)', () => {
    const res = syncCommandTemplates(projectDir, pkgRoot);
    const dst = path.join(projectDir, '.claude', 'commands');
    assert.equal(fs.existsSync(path.join(dst, 'task-close.md')), true);
    assert.equal(fs.existsSync(path.join(dst, 'task-start.md')), true);
    assert.ok(fs.readFileSync(path.join(dst, 'task-close.md'), 'utf8').includes('꼭 채워라'));
    assert.deepEqual(res.copied.sort(), ['task-close.md', 'task-start.md']);
    assert.deepEqual(res.backedUp, []);
  });

  it('overwrites a stale copy and backs it up (.bak) before changing', () => {
    const dst = path.join(projectDir, '.claude', 'commands', 'task-close.md');
    write(dst, 'OLD task-close v1 (no trigger_keywords guidance)\n');

    const res = syncCommandTemplates(projectDir, pkgRoot);
    assert.ok(fs.readFileSync(dst, 'utf8').includes('꼭 채워라'), 'copy is updated to engine version');
    assert.ok(fs.existsSync(`${dst}.bak`), 'old copy backed up');
    assert.ok(fs.readFileSync(`${dst}.bak`, 'utf8').includes('OLD task-close v1'), 'backup holds the old content');
    assert.ok(res.backedUp.includes('task-close.md'));
    assert.ok(res.copied.includes('task-close.md'));
  });

  it('does not rewrite or re-backup an already up-to-date copy (idempotent)', () => {
    syncCommandTemplates(projectDir, pkgRoot);
    const dst = path.join(projectDir, '.claude', 'commands', 'task-close.md');
    assert.equal(fs.existsSync(`${dst}.bak`), false, 'no backup on first fresh copy');

    const res2 = syncCommandTemplates(projectDir, pkgRoot);
    assert.deepEqual(res2.copied, [], 'nothing copied the second time (content identical)');
    assert.deepEqual(res2.backedUp, []);
  });

  it('honors preserve list — a preserved file is not touched', () => {
    const dst = path.join(projectDir, '.claude', 'commands', 'task-close.md');
    write(dst, 'USER CUSTOM — keep me\n');
    const res = syncCommandTemplates(projectDir, pkgRoot, { preserve: ['task-close.md'] });
    assert.equal(fs.readFileSync(dst, 'utf8'), 'USER CUSTOM — keep me\n', 'preserved file untouched');
    assert.ok(res.preserved.includes('task-close.md'));
    assert.ok(!res.copied.includes('task-close.md'));
    // other files still sync
    assert.ok(res.copied.includes('task-start.md'));
  });

  it('returns empty result when the package has no command templates', () => {
    fs.rmSync(path.join(pkgRoot, 'templates', 'commands'), { recursive: true, force: true });
    const res = syncCommandTemplates(projectDir, pkgRoot);
    assert.deepEqual(res.copied, []);
    assert.deepEqual(res.backedUp, []);
  });
});
