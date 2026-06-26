import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  isPollutedKeyword,
  cleanRowKeywords,
  processFile
} from '../clean-trigger-keywords.mjs';

describe('isPollutedKeyword', () => {
  it('flags boilerplate-derived tokens', () => {
    for (const k of ['read', 'read_first', 'before', 'notes', 'writing', 'plan']) {
      assert.equal(isPollutedKeyword(k), true, k);
    }
  });
  it('flags Korean command verbs / fillers (incl. trailing dot)', () => {
    for (const k of ['구현해줘', '구현해줘.', '시작해', '명세대로', '지금', '어떤']) {
      assert.equal(isPollutedKeyword(k), true, k);
    }
  });
  it('flags pure numbers and sub-2-char and non-strings', () => {
    assert.equal(isPollutedKeyword('100'), true);
    assert.equal(isPollutedKeyword('a'), true);
    assert.equal(isPollutedKeyword(''), true);
    assert.equal(isPollutedKeyword(null), true);
    assert.equal(isPollutedKeyword(42), true);
  });
  it('KEEPS real domain / code terms and multi-word phrases', () => {
    for (const k of [
      'ParticipantManager', 'Vector3S', '하드웨어', '산줄꼬임', 'riser',
      'spawnPoint', 'MessageRouter', '수신 핸들러', '멀티 동기화', 'VR 조종'
    ]) {
      assert.equal(isPollutedKeyword(k), false, k);
    }
  });
});

describe('cleanRowKeywords', () => {
  it('removes polluted, keeps good, does NOT mutate input', () => {
    const row = { id: 'x', trigger_keywords: ['read', 'ParticipantManager', '구현해줘', '멀티 동기화'] };
    const r = cleanRowKeywords(row);
    assert.deepEqual(r.row.trigger_keywords, ['ParticipantManager', '멀티 동기화']);
    assert.equal(r.removed, 2);
    assert.equal(row.trigger_keywords.length, 4, 'input untouched');
  });
  it('row with no trigger_keywords is a no-op', () => {
    const row = { id: 'y' };
    const r = cleanRowKeywords(row);
    assert.equal(r.removed, 0);
    assert.equal(r.row, row);
  });
  it('keeps a row whose trigger_keywords becomes empty (not dropped)', () => {
    const row = { id: 'z', trigger_keywords: ['read', '지금'] };
    const r = cleanRowKeywords(row);
    assert.deepEqual(r.row.trigger_keywords, []);
    assert.equal(r.removed, 2);
  });
});

describe('processFile — sandbox', () => {
  let root;
  before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-tk-')); });
  after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  it('cleans, backs up, writes valid jsonl', () => {
    const file = path.join(root, 'lessons.jsonl');
    const rows = [
      { id: 'a', trigger_keywords: ['read', 'Vector3S', '명세대로'] },
      { id: 'b', trigger_keywords: ['ParticipantManager', '멀티 동기화'] } // clean
    ];
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const s = processFile(file, { dryRun: false });
    assert.equal(s.totalRemoved, 2);
    assert.equal(s.rowsTouched, 1);
    assert.ok(fs.existsSync(`${file}.tk.bak`));

    const after = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const byId = Object.fromEntries(after.map((r) => [r.id, r]));
    assert.deepEqual(byId.a.trigger_keywords, ['Vector3S']);
    assert.deepEqual(byId.b.trigger_keywords, ['ParticipantManager', '멀티 동기화']);
  });

  it('dry-run writes nothing', () => {
    const file = path.join(root, 'dry.jsonl');
    fs.writeFileSync(file, JSON.stringify({ id: 'a', trigger_keywords: ['read', 'riser'] }) + '\n');
    const before = fs.readFileSync(file, 'utf8');
    const s = processFile(file, { dryRun: true });
    assert.equal(s.totalRemoved, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.ok(!fs.existsSync(`${file}.tk.bak`));
  });

  it('clean file: no write, no backup', () => {
    const file = path.join(root, 'clean.jsonl');
    fs.writeFileSync(file, JSON.stringify({ id: 'a', trigger_keywords: ['riser', '하드웨어'] }) + '\n');
    const s = processFile(file, { dryRun: false });
    assert.equal(s.changed, false);
    assert.ok(!fs.existsSync(`${file}.tk.bak`));
  });
});
