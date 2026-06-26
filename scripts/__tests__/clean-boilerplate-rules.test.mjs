import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  BOILERPLATE,
  isBoilerplate,
  processJsonlRow,
  stripBoilerplateFromMarkdown,
  processJsonlFile,
  processMarkdownFile
} from '../clean-boilerplate-rules.mjs';

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-bp-'));
  return { root };
}
function cleanup(sb) {
  try {
    fs.rmSync(sb.root, { recursive: true, force: true });
  } catch {}
}
function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

describe('isBoilerplate', () => {
  it('matches the exact string', () => {
    assert.equal(isBoilerplate(BOILERPLATE), true);
  });
  it('matches with surrounding whitespace (trimmed)', () => {
    assert.equal(isBoilerplate(`  ${BOILERPLATE}  `), true);
  });
  it('rejects a real session rule', () => {
    assert.equal(isBoilerplate('Carry one verification command into the close note.'), false);
  });
  it('rejects non-string', () => {
    assert.equal(isBoilerplate(null), false);
    assert.equal(isBoilerplate(undefined), false);
    assert.equal(isBoilerplate(42), false);
  });
});

describe('processJsonlRow', () => {
  it('strips boilerplate but preserves real rules (mixed row)', () => {
    const row = {
      id: 'x',
      rules: ['real rule A', BOILERPLATE, 'real rule B'],
      trigger_keywords: ['k']
    };
    const r = processJsonlRow(row);
    assert.equal(r.stripped, true);
    assert.equal(r.dropped, false);
    assert.deepEqual(r.row.rules, ['real rule A', 'real rule B']);
    // other fields untouched
    assert.deepEqual(r.row.trigger_keywords, ['k']);
    assert.equal(r.row.id, 'x');
  });

  it('drops the row when boilerplate was the ONLY rule (shell record)', () => {
    const row = { id: 'shell', rules: [BOILERPLATE] };
    const r = processJsonlRow(row);
    assert.equal(r.dropped, true);
    assert.equal(r.stripped, false);
    assert.equal(r.row, null);
  });

  it('leaves a clean row unchanged', () => {
    const row = { id: 'y', rules: ['real rule only'] };
    const r = processJsonlRow(row);
    assert.equal(r.stripped, false);
    assert.equal(r.dropped, false);
    assert.equal(r.row, row);
  });

  it('handles rows with no rules array', () => {
    const row = { id: 'z' };
    const r = processJsonlRow(row);
    assert.equal(r.stripped, false);
    assert.equal(r.dropped, false);
    assert.equal(r.row, row);
  });

  it('does NOT mutate the input row', () => {
    const row = { id: 'm', rules: ['a', BOILERPLATE] };
    processJsonlRow(row);
    assert.equal(row.rules.length, 2, 'input must be untouched (immutability)');
  });
});

describe('stripBoilerplateFromMarkdown', () => {
  it('removes the boilerplate list line, preserves other rule lines', () => {
    const md = [
      '## Reuse Rules',
      '- real rule A',
      `- ${BOILERPLATE}`,
      '- real rule B',
      ''
    ].join('\n');
    const out = stripBoilerplateFromMarkdown(md);
    assert.equal(out.changed, true);
    assert.equal(out.removedLines, 1);
    assert.ok(!out.text.includes(BOILERPLATE));
    assert.ok(out.text.includes('- real rule A'));
    assert.ok(out.text.includes('- real rule B'));
    assert.ok(out.text.includes('## Reuse Rules'));
  });

  it('removes a list line with leading whitespace / asterisk bullet', () => {
    const md = [`  * ${BOILERPLATE}`, '- keep me'].join('\n');
    const out = stripBoilerplateFromMarkdown(md);
    assert.equal(out.removedLines, 1);
    assert.ok(out.text.includes('- keep me'));
    assert.ok(!out.text.includes(BOILERPLATE));
  });

  it('preserves the section header even when boilerplate was its only item', () => {
    const md = ['## Guardrails', `- ${BOILERPLATE}`, '', '## Next'].join('\n');
    const out = stripBoilerplateFromMarkdown(md);
    assert.ok(out.text.includes('## Guardrails'));
    assert.ok(out.text.includes('## Next'));
    assert.ok(!out.text.includes(BOILERPLATE));
  });

  it('returns changed=false for clean markdown', () => {
    const md = '## Reuse Rules\n- real rule\n';
    const out = stripBoilerplateFromMarkdown(md);
    assert.equal(out.changed, false);
    assert.equal(out.removedLines, 0);
    assert.equal(out.text, md);
  });

  it('does NOT remove a line that merely contains the phrase mid-sentence', () => {
    // Only standalone list-item lines are boilerplate. A prose mention stays.
    const md = `- you should read read_first notes before writing a plan, says the doc`;
    const out = stripBoilerplateFromMarkdown(md);
    assert.equal(out.changed, false);
  });
});

describe('processJsonlFile — sandbox', () => {
  let sb;
  before(() => { sb = makeSandbox(); });
  after(() => cleanup(sb));

  it('strips, drops to quarantine, backs up, and writes', () => {
    const file = path.join(sb.root, 'lessons.jsonl');
    const mixed = { id: 'mixed', rules: ['keep', BOILERPLATE] };
    const shell = { id: 'shell', rules: [BOILERPLATE] };
    const clean = { id: 'clean', rules: ['only real'] };
    writeFile(file, [mixed, shell, clean].map((r) => JSON.stringify(r)).join('\n') + '\n');

    const s = processJsonlFile(file, { dryRun: false });
    assert.equal(s.stripped, 1);
    assert.equal(s.dropped, 1);
    assert.equal(s.rowsAfter, 2);

    // backup exists and equals original
    assert.ok(fs.existsSync(`${file}.bak`));

    // written file: mixed stripped, shell gone, clean intact
    const after = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(after.length, 2);
    const byId = Object.fromEntries(after.map((r) => [r.id, r]));
    assert.deepEqual(byId.mixed.rules, ['keep']);
    assert.deepEqual(byId.clean.rules, ['only real']);
    assert.ok(!byId.shell, 'shell row dropped');

    // quarantine holds the dropped shell row (data NOT lost)
    const q = `${file}.quarantine.jsonl`;
    assert.ok(fs.existsSync(q));
    const quarantined = fs.readFileSync(q, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(quarantined.length, 1);
    assert.equal(quarantined[0].id, 'shell');
  });

  it('dry-run writes nothing', () => {
    const file = path.join(sb.root, 'lessons-dry.jsonl');
    writeFile(file, JSON.stringify({ id: 'a', rules: ['x', BOILERPLATE] }) + '\n');
    const before = fs.readFileSync(file, 'utf8');
    const s = processJsonlFile(file, { dryRun: true });
    assert.equal(s.stripped, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'file unchanged on dry-run');
    assert.ok(!fs.existsSync(`${file}.bak`));
  });

  it('does not write or back up a clean file', () => {
    const file = path.join(sb.root, 'lessons-clean.jsonl');
    writeFile(file, JSON.stringify({ id: 'a', rules: ['real'] }) + '\n');
    const s = processJsonlFile(file, { dryRun: false });
    assert.equal(s.changed, false);
    assert.ok(!fs.existsSync(`${file}.bak`));
  });

  it('preserves non-JSON lines verbatim (defensive)', () => {
    const file = path.join(sb.root, 'lessons-weird.jsonl');
    writeFile(file, `not json\n${JSON.stringify({ id: 'a', rules: [BOILERPLATE, 'keep'] })}\n`);
    const s = processJsonlFile(file, { dryRun: false });
    const after = fs.readFileSync(file, 'utf8');
    assert.ok(after.includes('not json'));
    assert.equal(s.nonJsonKept, 1);
  });
});

describe('processMarkdownFile — sandbox', () => {
  let sb;
  before(() => { sb = makeSandbox(); });
  after(() => cleanup(sb));

  it('strips the boilerplate line, backs up, preserves the rest', () => {
    const file = path.join(sb.root, 'lesson.md');
    const body = ['# Lesson', '## Reuse Rules', '- keep A', `- ${BOILERPLATE}`, '- keep B', ''].join('\n');
    writeFile(file, body);
    const s = processMarkdownFile(file, { dryRun: false });
    assert.equal(s.removedLines, 1);
    assert.ok(fs.existsSync(`${file}.bak`));
    const after = fs.readFileSync(file, 'utf8');
    assert.ok(!after.includes(BOILERPLATE));
    assert.ok(after.includes('- keep A'));
    assert.ok(after.includes('- keep B'));
  });

  it('dry-run leaves the file and makes no backup', () => {
    const file = path.join(sb.root, 'lesson-dry.md');
    writeFile(file, `- ${BOILERPLATE}\n- keep\n`);
    const before = fs.readFileSync(file, 'utf8');
    processMarkdownFile(file, { dryRun: true });
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.ok(!fs.existsSync(`${file}.bak`));
  });
});
