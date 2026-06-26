import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeSessionArchitecture } from '../learning-curate.mjs';
import { writeVaultArtifact } from '../utils.mjs';
import { ensureRuntimeLayout, getRuntimePaths } from '../runtime-lib.mjs';

// Real-FS test: an update whose doc filename is taskId-based writes a NEW .md and
// must quarantine the PREVIOUS one (move, not delete) so no stale orphan remains.

let ws;

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-quar-'));
  const projectDir = path.join(root, 'proj');
  // vault and context are DISTINCT here (the normal, correct layout).
  const vaultRoot = path.join(root, 'vault');
  const contextRoot = path.join(projectDir, 'document', 'obsidian_context');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(vaultRoot, { recursive: true });
  fs.mkdirSync(contextRoot, { recursive: true });
  ensureRuntimeLayout(projectDir);
  return { root, projectDir, vaultRoot, contextRoot };
}

function writeTask(dir, taskId) {
  const paths = getRuntimePaths(dir);
  fs.mkdirSync(paths.tasksRoot, { recursive: true });
  fs.writeFileSync(path.join(paths.tasksRoot, `${taskId}.json`), JSON.stringify({
    taskId, title: 'arch task', prompt: 'p', matchedScopes: ['musicGame'],
    files: ['src/a.ts'], createdAt: '2026-06-26T00:00:00.000Z', updatedAt: '2026-06-26T00:00:00.000Z'
  }));
}

function realConfig() {
  return {
    loadObsidianConfig: () => ({ vaultRoot: ws.vaultRoot, contextRoot: ws.contextRoot, vaultAvailable: true }),
    writeVaultArtifact: (params) => writeVaultArtifact({
      projectDir: ws.projectDir,
      vaultRoot: ws.vaultRoot,
      relativePath: params.relativePath,
      content: params.content,
      queueRoot: 'document/obsidian_writeback_queue'
    }),
    projectTag: 'musicGame',
    scopeFolderMap: {}
  };
}

const arch = {
  summary: 's', body: '## C\n- x', title: 'Sys', relatedFiles: ['src/a.ts'], scope: 'musicGame'
};

beforeEach(() => { ws = makeWorkspace(); });
afterEach(() => { try { fs.rmSync(ws.root, { recursive: true, force: true }); } catch {} ws = null; });

describe('update quarantines the superseded vault doc', () => {
  it('moves the old .md to _quarantine when an update writes a new filename', () => {
    // create under task A
    writeTask(ws.projectDir, '20260626-1346-aaa');
    const created = writeSessionArchitecture(ws.projectDir, {
      taskId: '20260626-1346-aaa', mode: 'create', architecture: arch
    }, realConfig());
    assert.equal(created.ok, true);
    const oldRel = created.artifact.relativePath;
    const oldAbs = path.join(ws.vaultRoot, oldRel);
    assert.equal(fs.existsSync(oldAbs), true, 'old doc exists after create');

    // update under task B (same id passed → row id stays, but filename is taskId-based)
    writeTask(ws.projectDir, '20260626-1423-bbb');
    const updated = writeSessionArchitecture(ws.projectDir, {
      taskId: '20260626-1423-bbb', mode: 'update',
      architecture: { ...arch, id: created.artifact.id, summary: 's2 (HPSS removed)' }
    }, realConfig());
    assert.equal(updated.ok, true);
    const newRel = updated.artifact.relativePath;
    const newAbs = path.join(ws.vaultRoot, newRel);

    // new doc written, OLD doc no longer at its place...
    assert.equal(fs.existsSync(newAbs), true, 'new doc exists after update');
    assert.notEqual(newRel, oldRel, 'update produced a different filename (taskId-based)');
    assert.equal(fs.existsSync(oldAbs), false, 'old orphan must NOT remain in place');

    // ...but it is preserved under _quarantine (moved, not deleted).
    const qDir = path.join(ws.contextRoot, '_quarantine');
    assert.equal(fs.existsSync(qDir), true, 'quarantine dir created');
    const found = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p); else found.push(p);
      }
    })(qDir);
    assert.equal(found.length, 1, 'exactly the old doc is quarantined');
    assert.ok(found[0].endsWith(path.basename(oldRel)), 'quarantined file is the old doc');
  });

  it('does NOT quarantine when the update keeps the same filename (overwrite in place)', () => {
    // create + update under the SAME task → same filename → no orphan, no quarantine
    writeTask(ws.projectDir, '20260626-1346-aaa');
    const created = writeSessionArchitecture(ws.projectDir, {
      taskId: '20260626-1346-aaa', mode: 'create', architecture: arch
    }, realConfig());
    const updated = writeSessionArchitecture(ws.projectDir, {
      taskId: '20260626-1346-aaa', mode: 'update',
      architecture: { ...arch, id: created.artifact.id, summary: 's2' }
    }, realConfig());

    assert.equal(updated.artifact.relativePath, created.artifact.relativePath, 'same filename');
    const qDir = path.join(ws.contextRoot, '_quarantine');
    assert.equal(fs.existsSync(qDir), false, 'nothing quarantined on in-place overwrite');
  });
});
