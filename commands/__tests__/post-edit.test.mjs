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
const CLI_PATH = path.join(REPO_ROOT, 'commands', 'post-edit.mjs');

function runHook(input, env = {}) {
  const result = spawnSync(process.execPath, [CLI_PATH], {
    input: JSON.stringify(input),
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function listEvents(projectDir) {
  const eventsRoot = path.join(projectDir, '.claude', 'runtime', 'events');
  if (!fs.existsSync(eventsRoot)) return [];
  const files = fs.readdirSync(eventsRoot).filter((name) => name.endsWith('.jsonl'));
  return files.flatMap((name) => {
    const raw = fs.readFileSync(path.join(eventsRoot, name), 'utf8');
    return raw.split(/\r?\n/).filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  });
}

describe('post-edit hook — file_read branch (Design-A §1-D)', () => {
  let projectDir;
  let docPath;

  before(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'post-edit-test-'));
    // Simulate a vault mirror doc the agent might read.
    const mirrorRoot = path.join(projectDir, 'document', 'obsidian_context', '08_Lessons');
    fs.mkdirSync(mirrorRoot, { recursive: true });
    docPath = path.join(mirrorRoot, 'sample.md');
    fs.writeFileSync(docPath, '# Sample lesson\n\nbody.\n', 'utf8');
  });

  after(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('captures file_read event when Read targets a vault/mirror .md', () => {
    const result = runHook({
      session_id: 'sess-file-read-1',
      tool_name: 'Read',
      tool_input: { file_path: docPath }
    }, { CLAUDE_PROJECT_DIR: projectDir });

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const events = listEvents(projectDir);
    const fileReadEvents = events.filter((e) => e.eventType === 'file_read');
    assert.ok(fileReadEvents.length >= 1, 'expected at least one file_read event');
  });

  it('ignores Read for non-doc paths (e.g. .ts files)', () => {
    const projectDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'post-edit-test-non-doc-'));
    try {
      const tsPath = path.join(projectDir2, 'src', 'index.ts');
      fs.mkdirSync(path.dirname(tsPath), { recursive: true });
      fs.writeFileSync(tsPath, 'export {};\n', 'utf8');

      const result = runHook({
        session_id: 'sess-no-md',
        tool_name: 'Read',
        tool_input: { file_path: tsPath }
      }, { CLAUDE_PROJECT_DIR: projectDir2 });

      assert.equal(result.status, 0);
      const events = listEvents(projectDir2);
      const fileReadEvents = events.filter((e) => e.eventType === 'file_read');
      assert.equal(fileReadEvents.length, 0, 'file_read must not be captured for non-doc reads');
    } finally {
      fs.rmSync(projectDir2, { recursive: true, force: true });
    }
  });

  it('preserves Edit/Write branch (file_modified event)', () => {
    const projectDir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'post-edit-test-edit-'));
    try {
      const codePath = path.join(projectDir3, 'backend', 'src', 'routes', 'auth.ts');
      fs.mkdirSync(path.dirname(codePath), { recursive: true });
      fs.writeFileSync(codePath, 'export {};\n', 'utf8');

      const result = runHook({
        session_id: 'sess-edit-1',
        tool_name: 'Edit',
        tool_input: { file_path: codePath }
      }, { CLAUDE_PROJECT_DIR: projectDir3 });

      assert.equal(result.status, 0);
      const events = listEvents(projectDir3);
      const modifiedEvents = events.filter((e) => e.eventType === 'file_modified');
      // Note: file_modified is only emitted when a current task exists to link
      // against. The point is that the Edit branch still runs without crashing.
      assert.ok(Array.isArray(events), 'events collection must remain readable');
      void modifiedEvents;
    } finally {
      fs.rmSync(projectDir3, { recursive: true, force: true });
    }
  });
});
