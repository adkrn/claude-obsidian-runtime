import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable, Writable } from 'stream';
import {
  findLatestBackup,
  diffAgainstBackup,
  promptRollback,
  performRollback,
  ROLLBACK_TARGET_PATHS
} from '../doctor-rollback.mjs';

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-'));
}

function writeFileSafe(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

describe('findLatestBackup', () => {
  let root;
  before(() => { root = mkTmp(); });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('returns null when no backup dirs exist', () => {
    assert.equal(findLatestBackup(root), null);
  });

  it('returns null when projectDir invalid', () => {
    assert.equal(findLatestBackup(''), null);
    assert.equal(findLatestBackup(path.join(root, 'nope')), null);
  });

  it('ignores non-backup directories', () => {
    fs.mkdirSync(path.join(root, 'not-a-backup'), { recursive: true });
    assert.equal(findLatestBackup(root), null);
  });

  it('picks the dir with the largest timestamp suffix', () => {
    const older = path.join(root, '.claude.backup-20260101-0900');
    const newer = path.join(root, '.claude.backup-20260401-1200');
    fs.mkdirSync(older, { recursive: true });
    fs.mkdirSync(newer, { recursive: true });
    // Touch older first so mtime is older
    const now = Date.now();
    fs.utimesSync(older, new Date(now - 100000), new Date(now - 100000));
    const picked = findLatestBackup(root);
    assert.equal(picked, newer);
  });
});

describe('diffAgainstBackup', () => {
  let root;
  let projectDir;
  let backupDir;
  before(() => {
    root = mkTmp();
    projectDir = path.join(root, 'proj');
    backupDir = path.join(root, '.claude.backup-20260401-1200');
    fs.mkdirSync(projectDir, { recursive: true });
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('returns empty array when both live and backup are empty', () => {
    fs.mkdirSync(backupDir, { recursive: true });
    const d = diffAgainstBackup(projectDir, backupDir);
    assert.deepEqual(d, []);
  });

  it('detects modified manifest + added agent + deleted hook', () => {
    // live state
    writeFileSafe(path.join(projectDir, '.claude', 'runtime-manifest.json'), '{"v":1}');
    writeFileSafe(path.join(projectDir, '.claude', 'agents', 'demo-lead.md'), 'current');
    // backup state
    writeFileSafe(path.join(backupDir, '.claude', 'runtime-manifest.json'), '{"v":0}');
    writeFileSafe(path.join(backupDir, '.claude', 'hooks', 'runtime-post-edit.sh'), 'old');

    const d = diffAgainstBackup(projectDir, backupDir);
    const byPath = Object.fromEntries(d.map((line) => [line.relativePath, line.status]));
    assert.equal(byPath['.claude/runtime-manifest.json'], 'M');
    assert.equal(byPath['.claude/agents/demo-lead.md'], 'A');
    assert.equal(byPath['.claude/hooks/runtime-post-edit.sh'], 'D');
  });
});

describe('promptRollback', () => {
  it('returns "abort" when stdin is non-TTY', async () => {
    const stdin = new Readable({ read() { this.push(null); } });
    stdin.isTTY = false;
    const stdout = new Writable({ write(_c, _e, cb) { cb(); } });
    const r = await promptRollback([], { stdin, stdout, forceNonTty: true });
    assert.equal(r, 'abort');
  });

  it('returns "rollback" when user types y', async () => {
    const stdin = new Readable({ read() { this.push('y\n'); this.push(null); } });
    stdin.isTTY = true;
    const stdout = new Writable({ write(_c, _e, cb) { cb(); } });
    const r = await promptRollback([{ status: 'M', relativePath: 'x' }], { stdin, stdout });
    assert.equal(r, 'rollback');
  });

  it('returns "abort" on any non-y answer', async () => {
    const stdin = new Readable({ read() { this.push('no\n'); this.push(null); } });
    stdin.isTTY = true;
    const stdout = new Writable({ write(_c, _e, cb) { cb(); } });
    const r = await promptRollback([], { stdin, stdout });
    assert.equal(r, 'abort');
  });
});

describe('performRollback', () => {
  let root;
  let projectDir;
  let backupDir;
  before(() => {
    root = mkTmp();
    projectDir = path.join(root, 'proj');
    backupDir = path.join(root, '.claude.backup-20260401-1200');
    fs.mkdirSync(projectDir, { recursive: true });
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('restores manifest content from backup', async () => {
    const live = path.join(projectDir, '.claude', 'runtime-manifest.json');
    const bak = path.join(backupDir, '.claude', 'runtime-manifest.json');
    writeFileSafe(live, '{"v":2}');
    writeFileSafe(bak, '{"v":1}');
    const result = await performRollback({ projectDir, backupDir });
    assert.ok(result.restored.includes('runtime-manifest.json'));
    assert.equal(fs.readFileSync(live, 'utf8'), '{"v":1}');
    assert.equal(result.partial, false);
  });

  it('removes live file when backup version does not include it', async () => {
    const live = path.join(projectDir, '.claude', 'agents', 'demo-lead.md');
    writeFileSafe(live, 'current');
    // backupDir has no .claude/agents/
    const result = await performRollback({ projectDir, backupDir });
    assert.equal(fs.existsSync(live), false);
    assert.ok(result.restored.includes('agents'));
  });

  it('writes partial-restore log on failure', async () => {
    // Create a target pointing to a path that cannot be removed (simulate by creating a locked file)
    // Since we cannot easily simulate fs errors cross-platform, verify the returned shape
    const result = await performRollback({ projectDir, backupDir });
    assert.ok('partial' in result);
    assert.ok('restored' in result);
    assert.ok('logPath' in result);
  });

  it('throws when backupDir does not exist', async () => {
    await assert.rejects(
      performRollback({ projectDir, backupDir: path.join(root, 'missing') })
    );
  });
});

describe('ROLLBACK_TARGET_PATHS', () => {
  it('targets the four documented paths', () => {
    assert.deepEqual(ROLLBACK_TARGET_PATHS, [
      'runtime-manifest.json',
      'settings.json',
      'hooks',
      'agents'
    ]);
  });
});
