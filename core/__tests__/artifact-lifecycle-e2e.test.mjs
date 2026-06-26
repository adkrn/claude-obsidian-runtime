import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  writeSessionLesson,
  writeSessionDecision,
  writeSessionTroubleshooting,
  writeSessionArchitecture
} from '../learning-curate.mjs';
import { writeVaultArtifact } from '../utils.mjs';
import { syncManagedRoots } from '../obsidian-sync.mjs';
import { ensureRuntimeLayout, getRuntimePaths, loadJsonl } from '../runtime-lib.mjs';

/**
 * Real-FS end-to-end lifecycle test for session artifacts.
 *
 * Mock-vault unit tests proved each writer produces a row, but the real
 * production failures (self-prune, update-orphan) only surface when artifacts
 * are written to disk AND then run through syncManagedRoots — exactly the
 * task-close pipeline (session-end.mjs calls syncManagedRoots after writes).
 * This exercises create → sync → update → sync on a real filesystem, in both
 * the correct layout (vault != context) and the musicGame misconfig
 * (vault == context), and asserts the artifacts survive intact.
 */

let ws;

function makeWorkspace({ sameVaultAndContext = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-e2e-'));
  const projectDir = path.join(root, 'proj');
  const contextRoot = path.join(projectDir, 'document', 'obsidian_context');
  const vaultRoot = sameVaultAndContext ? contextRoot : path.join(root, 'vault');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(contextRoot, { recursive: true });
  fs.mkdirSync(vaultRoot, { recursive: true });
  ensureRuntimeLayout(projectDir);
  return { root, projectDir, vaultRoot, contextRoot };
}

function writeTask(dir, taskId) {
  const paths = getRuntimePaths(dir);
  fs.mkdirSync(paths.tasksRoot, { recursive: true });
  fs.writeFileSync(path.join(paths.tasksRoot, `${taskId}.json`), JSON.stringify({
    taskId, title: 'e2e task', prompt: 'p', matchedScopes: ['musicGame'],
    files: ['src/a.ts'], createdAt: '2026-06-26T00:00:00.000Z', updatedAt: '2026-06-26T00:00:00.000Z'
  }));
}

function realConfig() {
  const obsidian = { vaultRoot: ws.vaultRoot, contextRoot: ws.contextRoot, vaultAvailable: true };
  return {
    loadObsidianConfig: () => obsidian,
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

// Mirror musicGame's obsidian_paths.json managed/exclude roots.
const syncConfig = () => ({
  vaultRoot: ws.vaultRoot,
  contextRoot: ws.contextRoot,
  vaultAvailable: true,
  managedRoots: ['04_Architecture', '06_Troubleshooting', '07_Decisions', '08_Lessons'],
  mirrorExcludeRoots: [
    '_quarantine',
    '04_Architecture/Generated', '04_Architecture/Drafts',
    '06_Troubleshooting/Drafts', '07_Decisions/Drafts', '08_Lessons/Drafts', '10_Worklogs'
  ]
});

function docExists(rel) { return fs.existsSync(path.join(ws.vaultRoot, rel)); }
function rowDocConsistent(fileBase) {
  const rows = loadJsonl(path.join(getRuntimePaths(ws.projectDir).knowledgeRoot, fileBase));
  return rows.every((r) => !r.sourceDoc || docExists(r.sourceDoc));
}

const lesson = { summary: 's', rules: ['r'], trigger_keywords: ['k'], applicable_when: { scope_id: 'musicGame' }, relatedFiles: ['src/a.ts'] };
const decision = { statement: 'd', why: ['w'], relatedFiles: ['src/a.ts'], scope: 'musicGame' };
const trouble = { symptom: 'sym', cause: 'c', fix: 'f', relatedFiles: ['src/a.ts'], scope: 'musicGame' };
const arch = { summary: 'a', body: '## C\n- x', title: 'Sys', relatedFiles: ['src/a.ts'], scope: 'musicGame' };

afterEach(() => { try { fs.rmSync(ws.root, { recursive: true, force: true }); } catch {} ws = null; });

describe('artifact lifecycle E2E — correct layout (vault != context)', () => {
  beforeEach(() => { ws = makeWorkspace({ sameVaultAndContext: false }); });

  it('all 4 artifacts survive create → sync (never quarantined)', () => {
    writeTask(ws.projectDir, 'task-a');
    writeSessionLesson(ws.projectDir, { taskId: 'task-a', mode: 'create', lesson }, realConfig());
    writeSessionDecision(ws.projectDir, { taskId: 'task-a', mode: 'create', decision }, realConfig());
    writeSessionTroubleshooting(ws.projectDir, { taskId: 'task-a', mode: 'create', troubleshooting: trouble }, realConfig());
    writeSessionArchitecture(ws.projectDir, { taskId: 'task-a', mode: 'create', architecture: arch }, realConfig());

    // task-close pipeline runs sync after writes.
    const sync = syncManagedRoots(ws.projectDir, syncConfig());
    assert.equal(sync.ok, true);

    // every index row's doc must still exist (no quarantine, no dangling).
    for (const f of ['lessons.jsonl', 'decisions.jsonl', 'troubleshooting.jsonl', 'architecture.jsonl']) {
      const kind = f.replace('.jsonl', '');
      assert.equal(rowDocConsistent(f), true, `${kind}: every row's doc must exist after sync`);
    }
    // nothing in quarantine.
    assert.equal(fs.existsSync(path.join(ws.contextRoot, '_quarantine')), false, 'no quarantine in correct layout');
  });

  it('architecture update across tasks: old doc quarantined, index consistent, no dangling', () => {
    writeTask(ws.projectDir, 'task-a');
    const created = writeSessionArchitecture(ws.projectDir, { taskId: 'task-a', mode: 'create', architecture: arch }, realConfig());
    syncManagedRoots(ws.projectDir, syncConfig());

    writeTask(ws.projectDir, 'task-b');
    writeSessionArchitecture(ws.projectDir, {
      taskId: 'task-b', mode: 'update', architecture: { ...arch, id: created.artifact.id, summary: 'updated' }
    }, realConfig());
    syncManagedRoots(ws.projectDir, syncConfig());

    // index points at exactly one doc, and it exists (no dangling).
    assert.equal(rowDocConsistent('architecture.jsonl'), true);
    const rows = loadJsonl(path.join(getRuntimePaths(ws.projectDir).knowledgeRoot, 'architecture.jsonl'));
    assert.equal(rows.length, 1, 'update keeps a single row (no duplicate)');
    assert.ok(rows[0].summary.includes('updated'));
    // exactly one live arch doc in Generated (old orphan gone from its place).
    const genDir = path.join(ws.vaultRoot, '04_Architecture', 'Generated');
    const liveDocs = fs.existsSync(genDir) ? fs.readdirSync(genDir).filter((n) => n.endsWith('.md')) : [];
    assert.equal(liveDocs.length, 1, 'only the current doc remains in place (old one quarantined)');
  });
});

describe('artifact lifecycle E2E — musicGame misconfig (vault == context)', () => {
  beforeEach(() => { ws = makeWorkspace({ sameVaultAndContext: true }); });

  it('sync skips and never quarantines freshly written artifacts', () => {
    writeTask(ws.projectDir, 'task-a');
    const dec = writeSessionDecision(ws.projectDir, { taskId: 'task-a', mode: 'create', decision }, realConfig());
    const ar = writeSessionArchitecture(ws.projectDir, { taskId: 'task-a', mode: 'create', architecture: arch }, realConfig());

    const sync = syncManagedRoots(ws.projectDir, syncConfig());
    assert.equal(sync.skipped, true, 'sync must skip when vault === context');
    assert.equal(sync.reason, 'vault-equals-context');

    // artifacts stay exactly where they were written.
    assert.equal(docExists(dec.artifact.relativePath), true, 'decision doc survives');
    assert.equal(docExists(ar.artifact.relativePath), true, 'architecture doc survives');
    assert.equal(fs.existsSync(path.join(ws.contextRoot, '_quarantine')), false, 'nothing quarantined');
    assert.equal(rowDocConsistent('decisions.jsonl'), true);
    assert.equal(rowDocConsistent('architecture.jsonl'), true);
  });
});
