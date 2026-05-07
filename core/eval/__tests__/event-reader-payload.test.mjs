// DESIGN_MANUS_I §8 — payload_ref interface AC tests (read path + last_observation).
//
// Wave C will add write-side off-load tests (append_inline_below_threshold,
// append_offload_above_threshold, append_force_inline, manifest_threshold_*).
// This file ships the interface-level subset only (CD-M9).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEventsWindow, loadPayload } from '../event-reader.mjs';
import { buildLastObservationLine } from '../../../commands/session-start.mjs';
import { append } from '../../memory/episodic-store.mjs';

function makeProjectDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'event-reader-payload-'));
}

function blobsDir(projectDir) {
  return path.join(projectDir, '.claude', 'runtime', 'events', 'blobs');
}

function writeBlob(projectDir, content) {
  const dir = blobsDir(projectDir);
  fs.mkdirSync(dir, { recursive: true });
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const ref = `blobs/${hash.slice(0, 8)}.txt`;
  fs.writeFileSync(path.join(dir, `${hash.slice(0, 8)}.txt`), content, 'utf8');
  return { hash, ref, size: Buffer.byteLength(content, 'utf8') };
}

// ── #1 payload_ref_schema_complete ───────────────────────────────
describe('I-1 payload_ref_schema_complete', () => {
  it('PayloadRef object satisfies type/ref/size/hash/mime contract', () => {
    const dir = makeProjectDir();
    const { hash, ref, size } = writeBlob(dir, 'hello world');
    const payloadRef = { type: 'blob', ref, size, hash, mime: 'text/plain' };
    assert.equal(payloadRef.type, 'blob');
    assert.match(payloadRef.ref, /^blobs\/[0-9a-f]{8}\.txt$/);
    assert.equal(typeof payloadRef.size, 'number');
    assert.match(payloadRef.hash, /^[0-9a-f]{64}$/);
    assert.equal(typeof payloadRef.mime, 'string');
  });
});

// ── #2 event_reader_returns_payload_ref ──────────────────────────
describe('I-2 event_reader_returns_payload_ref', () => {
  it('readEventsWindow preserves payload_ref on rows', () => {
    const dir = makeProjectDir();
    const { hash, ref, size } = writeBlob(dir, 'x'.repeat(10240));
    append(dir, {
      ts: new Date().toISOString(),
      taskId: 'T-1',
      eventType: 'tool_use',
      toolName: 'Read',
      filePath: 'src/big.mjs',
      payload_ref: { type: 'blob', ref, size, hash }
    });
    const events = readEventsWindow(dir, 30, Date.now());
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].payload_ref, { type: 'blob', ref, size, hash });
  });
});

// ── #3 event_reader_returns_inline_payload ───────────────────────
describe('I-3 event_reader_returns_inline_payload', () => {
  it('legacy rows with inline payload remain readable (backward-compat)', () => {
    const dir = makeProjectDir();
    append(dir, {
      ts: new Date().toISOString(),
      taskId: 'T-2',
      eventType: 'tool_use',
      payload: 'small inline body'
    });
    const events = readEventsWindow(dir, 30, Date.now());
    assert.equal(events.length, 1);
    assert.equal(events[0].payload, 'small inline body');
    assert.equal(events[0].payload_ref, undefined);
  });
});

// ── #4 load_payload_returns_original ─────────────────────────────
describe('I-4 load_payload_returns_original', () => {
  it('loadPayload reads the blob and returns the original byte contents (lossless)', () => {
    const dir = makeProjectDir();
    const original = 'lossless payload contents — 한글 + emoji 🚀';
    const { hash, ref, size } = writeBlob(dir, original);
    const got = loadPayload(dir, { type: 'blob', ref, size, hash });
    assert.equal(got, original);
  });
});

// ── #5 load_payload_hash_mismatch_throws ─────────────────────────
describe('I-5 load_payload_hash_mismatch_throws', () => {
  it('tampered blob → hash mismatch → throw (integrity guard)', () => {
    const dir = makeProjectDir();
    const { hash, ref } = writeBlob(dir, 'original');
    // Tamper with the blob file after the fact.
    fs.writeFileSync(
      path.join(dir, '.claude', 'runtime', 'events', ...ref.split('/')),
      'tampered',
      'utf8'
    );
    assert.throws(
      () => loadPayload(dir, { type: 'blob', ref, hash, size: 8 }),
      /hash mismatch/i
    );
  });
});

// ── #6 session_start_last_observation_omit_when_no_offload ───────
describe('I-6 session_start_last_observation_omit_when_no_offload', () => {
  it('buildLastObservationLine returns null when no payload_ref event present', () => {
    // Plain inline events (no payload_ref) → omit the line entirely.
    const events = [
      { eventType: 'tool_use', filePath: 'a.mjs' },
      { eventType: 'tool_use', filePath: 'b.mjs', payload: 'small' }
    ];
    assert.equal(buildLastObservationLine(events), null);
  });
});
