import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { syncManagedRoots } from '../obsidian-sync.mjs';

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-sync-quarantine-'));
  const projectDir = path.join(root, 'project');
  const vaultRoot = path.join(root, 'vault');
  const contextRoot = path.join(projectDir, 'document', 'obsidian_context');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(vaultRoot, { recursive: true });
  fs.mkdirSync(contextRoot, { recursive: true });
  return { root, projectDir, vaultRoot, contextRoot };
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function makeConfig(workspace, overrides = {}) {
  return {
    contextRoot: workspace.contextRoot,
    vaultRoot: workspace.vaultRoot,
    vaultAvailable: true,
    managedRoots: ['07_Decisions', '04_Architecture'],
    mirrorExcludeRoots: ['_quarantine'],
    ...overrides
  };
}

function rmrf(target) {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
}

describe('obsidian-sync quarantine (FIX_obsidian_sync_prune_data_loss)', () => {
  let workspace;

  beforeEach(() => {
    workspace = makeWorkspace();
  });

  afterEach(() => {
    if (workspace) rmrf(workspace.root);
    workspace = null;
    delete process.env.OBSIDIAN_QUARANTINE_TTL_DAYS;
    delete process.env.OBSIDIAN_PRUNE_WARN_BYTES;
  });

  it('case 1: mirror-only .md is moved to quarantine (not deleted)', () => {
    const config = makeConfig(workspace);
    const mirrorOnly = path.join(workspace.contextRoot, '07_Decisions', 'IMPL-006A.md');
    writeFile(mirrorOnly, '# IMPL-006A\nimportant content');
    fs.mkdirSync(path.join(workspace.vaultRoot, '07_Decisions'), { recursive: true });
    fs.mkdirSync(path.join(workspace.vaultRoot, '04_Architecture'), { recursive: true });

    const result = syncManagedRoots(workspace.projectDir, config);

    assert.equal(result.ok, true, `sync should succeed: ${result.message}`);
    assert.equal(fs.existsSync(mirrorOnly), false, 'original mirror file must be gone');

    const qRoot = path.join(workspace.contextRoot, '_quarantine');
    assert.equal(fs.existsSync(qRoot), true, '_quarantine directory must be created');

    const dateDirs = fs.readdirSync(qRoot);
    assert.equal(dateDirs.length, 1, 'one date dir expected');
    const found = [];
    function walk(p) {
      for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
        const full = path.join(p, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name === 'IMPL-006A.md') found.push(full);
      }
    }
    walk(qRoot);
    assert.equal(found.length, 1, 'quarantined IMPL-006A.md must exist exactly once');
    assert.equal(fs.readFileSync(found[0], 'utf8'), '# IMPL-006A\nimportant content');
  });

  it('case 2: quarantined file is not re-mirrored on next sync', () => {
    const config = makeConfig(workspace);
    const mirrorOnly = path.join(workspace.contextRoot, '07_Decisions', 'orphan.md');
    writeFile(mirrorOnly, 'orphan');
    fs.mkdirSync(path.join(workspace.vaultRoot, '07_Decisions'), { recursive: true });
    fs.mkdirSync(path.join(workspace.vaultRoot, '04_Architecture'), { recursive: true });

    const first = syncManagedRoots(workspace.projectDir, config);
    assert.equal(first.ok, true);
    const qRoot = path.join(workspace.contextRoot, '_quarantine');
    assert.equal(fs.existsSync(qRoot), true);

    const second = syncManagedRoots(workspace.projectDir, config);
    assert.equal(second.ok, true);

    function existsRecursive(dir, fileName) {
      if (!fs.existsSync(dir)) return false;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (existsRecursive(full, fileName)) return true;
        } else if (entry.name === fileName) {
          return true;
        }
      }
      return false;
    }

    assert.equal(
      existsRecursive(path.join(workspace.contextRoot, '07_Decisions'), 'orphan.md'),
      false,
      'mirror must not contain orphan.md after second sync'
    );
    assert.equal(
      existsRecursive(qRoot, 'orphan.md'),
      true,
      'quarantine must still contain orphan.md after second sync'
    );
  });

  it('case 3: quarantined file older than TTL is purged on next sync', () => {
    process.env.OBSIDIAN_QUARANTINE_TTL_DAYS = '7';
    const config = makeConfig(workspace);
    const mirrorOnly = path.join(workspace.contextRoot, '07_Decisions', 'old.md');
    writeFile(mirrorOnly, 'old');
    fs.mkdirSync(path.join(workspace.vaultRoot, '07_Decisions'), { recursive: true });
    fs.mkdirSync(path.join(workspace.vaultRoot, '04_Architecture'), { recursive: true });

    syncManagedRoots(workspace.projectDir, config);
    const qRoot = path.join(workspace.contextRoot, '_quarantine');

    function findFile(dir, name) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const r = findFile(full, name);
          if (r) return r;
        } else if (entry.name === name) {
          return full;
        }
      }
      return null;
    }
    const quarantinedPath = findFile(qRoot, 'old.md');
    assert.ok(quarantinedPath, 'old.md must be quarantined');

    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    fs.utimesSync(quarantinedPath, eightDaysAgo / 1000, eightDaysAgo / 1000);

    const dateDir = path.dirname(quarantinedPath);
    let cur = dateDir;
    while (path.dirname(cur) !== qRoot && cur !== qRoot) cur = path.dirname(cur);
    if (cur !== qRoot) {
      try { fs.utimesSync(cur, eightDaysAgo / 1000, eightDaysAgo / 1000); } catch {}
    }

    syncManagedRoots(workspace.projectDir, config);

    assert.equal(fs.existsSync(quarantinedPath), false, 'expired quarantine file must be purged');
  });

  it('case 4: prune of >2KB file emits warning in result.quarantine.warnings', () => {
    process.env.OBSIDIAN_PRUNE_WARN_BYTES = '2048';
    const config = makeConfig(workspace);
    const big = path.join(workspace.contextRoot, '07_Decisions', 'big.md');
    writeFile(big, 'x'.repeat(3000));
    fs.mkdirSync(path.join(workspace.vaultRoot, '07_Decisions'), { recursive: true });
    fs.mkdirSync(path.join(workspace.vaultRoot, '04_Architecture'), { recursive: true });

    const result = syncManagedRoots(workspace.projectDir, config);

    assert.equal(result.ok, true);
    assert.ok(result.quarantine, 'result.quarantine must be present');
    assert.ok(Array.isArray(result.quarantine.warnings), 'warnings must be array');
    const match = result.quarantine.warnings.find((w) => w.relativePath.endsWith('big.md'));
    assert.ok(match, 'warning for big.md must be in result.quarantine.warnings');
    assert.ok(match.bytes >= 3000, 'warning bytes must reflect file size');
  });

  it('case 5: prune of <=2KB file is quarantined but produces no warning', () => {
    process.env.OBSIDIAN_PRUNE_WARN_BYTES = '2048';
    const config = makeConfig(workspace);
    const small = path.join(workspace.contextRoot, '07_Decisions', 'small.md');
    writeFile(small, 'tiny');
    fs.mkdirSync(path.join(workspace.vaultRoot, '07_Decisions'), { recursive: true });
    fs.mkdirSync(path.join(workspace.vaultRoot, '04_Architecture'), { recursive: true });

    const result = syncManagedRoots(workspace.projectDir, config);

    assert.equal(result.ok, true);
    assert.ok(result.quarantine, 'result.quarantine must be present');
    const match = (result.quarantine.warnings || []).find((w) => w.relativePath.endsWith('small.md'));
    assert.equal(match, undefined, 'small.md must NOT trigger a warning');
    assert.ok(result.quarantine.movedCount >= 1, 'small.md must still be quarantined');
  });

  it('case 6: 04_Architecture cascade prune still passes content to pruneCallback', () => {
    const config = makeConfig(workspace);
    const arch = path.join(workspace.contextRoot, '04_Architecture', 'profile.md');
    writeFile(arch, '# arch profile\nbody');
    fs.mkdirSync(path.join(workspace.vaultRoot, '07_Decisions'), { recursive: true });
    fs.mkdirSync(path.join(workspace.vaultRoot, '04_Architecture'), { recursive: true });

    const captured = [];
    const result = syncManagedRoots(workspace.projectDir, config, {
      pruneCallback: (_projectDir, _config, removedProfiles) => {
        for (const p of removedProfiles) captured.push(p);
        return { removedArchitectures: [], deletedDocs: [], updatedDocs: [], runtimePruned: {} };
      }
    });

    assert.equal(result.ok, true);
    const match = captured.find((p) => p.relativePath.endsWith('profile.md'));
    assert.ok(match, 'pruneCallback must receive 04_Architecture/profile.md');
    assert.equal(match.content, '# arch profile\nbody', 'content must be captured before quarantine move');
  });

  it('case 7: _quarantine directory itself is not pruned across syncs', () => {
    const config = makeConfig(workspace);
    const mirrorOnly = path.join(workspace.contextRoot, '07_Decisions', 'a.md');
    writeFile(mirrorOnly, 'a');
    fs.mkdirSync(path.join(workspace.vaultRoot, '07_Decisions'), { recursive: true });
    fs.mkdirSync(path.join(workspace.vaultRoot, '04_Architecture'), { recursive: true });

    syncManagedRoots(workspace.projectDir, config);
    const qRoot = path.join(workspace.contextRoot, '_quarantine');
    assert.equal(fs.existsSync(qRoot), true);

    const before = fs.readdirSync(qRoot);
    syncManagedRoots(workspace.projectDir, config);
    syncManagedRoots(workspace.projectDir, config);

    assert.equal(fs.existsSync(qRoot), true, '_quarantine must survive multiple syncs');
    const after = fs.readdirSync(qRoot);
    assert.deepEqual(after.sort(), before.sort(), '_quarantine contents must be stable across syncs');
  });
});
