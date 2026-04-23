import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import {
  captureFileRead,
  isReadableDocPath
} from '../../learning-capture.mjs';
import { query } from '../episodic-store.mjs';
import { createFixtureProject } from './_fixture.mjs';

test('isReadableDocPath true for vault hint paths', () => {
  assert.equal(
    isReadableDocPath('C:/Project/document/obsidian_context/08_Lessons/foo.md'),
    true
  );
  assert.equal(isReadableDocPath('foo.md'), false);
  assert.equal(isReadableDocPath('C:/Project/src/foo.ts'), false);
});

test('isReadableDocPath true when path under provided vaultRoot', () => {
  const vault = 'C:/Obsidian';
  assert.equal(isReadableDocPath('C:/Obsidian/08_Lessons/foo.md', vault), true);
  assert.equal(isReadableDocPath('C:/Obsidian/08_Lessons/foo.txt', vault), false);
  assert.equal(isReadableDocPath('C:/Other/foo.md', vault), false);
});

test('captureFileRead writes a file_read event for vault doc', (t) => {
  const fx = createFixtureProject();
  t.after(() => fx.cleanup());

  const docPath = path.join(fx.projectDir, 'document', 'obsidian_context', '08_Lessons', 'sample.md');
  const r = captureFileRead(fx.projectDir, {
    filePath: docPath,
    toolName: 'Read',
    sessionId: 'sess-1'
  });
  assert.equal(r.ok, true);
  assert.equal(r.event.eventType, 'file_read');
  assert.equal(r.event.detail.isVaultDoc, true);
  assert.equal(r.event.detail.dedupWindowSec, 60);

  const events = query(fx.projectDir, { eventType: 'file_read' });
  assert.equal(events.length, 1);
});

test('captureFileRead skips non-doc paths', (t) => {
  const fx = createFixtureProject();
  t.after(() => fx.cleanup());

  const r = captureFileRead(fx.projectDir, {
    filePath: path.join(fx.projectDir, 'src', 'foo.ts'),
    sessionId: 'sess-1'
  });
  assert.equal(r.ok, false);
  assert.equal(r.skipped, 'not_doc');
});

test('captureFileRead deduplicates within 60s window per session+path', (t) => {
  const fx = createFixtureProject();
  t.after(() => fx.cleanup());

  const docPath = path.join(fx.projectDir, 'document', 'obsidian_context', 'foo.md');
  const r1 = captureFileRead(fx.projectDir, { filePath: docPath, sessionId: 'sess-2' });
  const r2 = captureFileRead(fx.projectDir, { filePath: docPath, sessionId: 'sess-2' });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, false);
  assert.equal(r2.skipped, 'duplicate');

  // different session bypasses dedup
  const r3 = captureFileRead(fx.projectDir, { filePath: docPath, sessionId: 'sess-3' });
  assert.equal(r3.ok, true);

  const events = query(fx.projectDir, { eventType: 'file_read' });
  assert.equal(events.length, 2);
});
