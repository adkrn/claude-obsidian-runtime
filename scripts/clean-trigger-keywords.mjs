#!/usr/bin/env node

/**
 * clean-trigger-keywords.mjs — one-off maintenance (NOT shipped in core).
 *
 * Removes polluted entries from each lesson's `trigger_keywords` array.
 * Pollution sources (surveyed on real Pasim62 data, 21% of 515 kw):
 *   1. Boilerplate-derived tokens: the old guardrail
 *      "read read_first notes before writing a plan" was tokenized into
 *      trigger_keywords → read / read_first / before / notes / writing / plan.
 *   2. Korean command verbs / sentence fragments that carry no retrieval signal:
 *      구현해줘 / 하는데 / 시작해 / 명세대로 / 작성해줘 / 지금 / 바로 ...
 *   3. English stopwords, pure numbers, sub-2-char tokens.
 *
 * PRESERVED (these are GOOD signal, do not touch):
 *   - Multi-word domain phrases: "수신 핸들러", "교관 절차 완료", "멀티 동기화", "VR 조종".
 *   - Domain / code terms: ParticipantManager, Vector3S, 하드웨어, 산줄꼬임, riser ...
 *
 * Policy:
 *   - Filter each trigger_keywords entry; keep everything not matched by the
 *     stop set / structural rules. Input rows are NOT mutated.
 *   - A row whose trigger_keywords becomes empty is KEPT (unlike the rules
 *     cleanup — an empty trigger_keywords is normal and the lesson still has
 *     tokens/title/summary for search; nothing is dropped here).
 *
 * Safety: hardcoded whitelist, `.bak` backup once, `--dry-run`.
 *
 * Usage:
 *   node scripts/clean-trigger-keywords.mjs --dry-run
 *   node scripts/clean-trigger-keywords.mjs
 */

import fs from 'fs';

// Active-project lessons.jsonl whitelist. Only Pasim62 has trigger_keywords
// today; the others are listed for completeness (no-op if empty).
const TARGET_FILES = [
  'C:/UnityProject/Pasim62_Trainee/.claude/runtime/knowledge/lessons.jsonl',
  'C:/JSProj/talkSim/.claude/runtime/knowledge/lessons.jsonl',
  'C:/JSProj/magicDraft/.claude/runtime/knowledge/lessons.jsonl',
  'C:/JSProj/productSurveyEngine/.claude/runtime/knowledge/lessons.jsonl',
  'C:/JSProj/musicGame/.claude/runtime/knowledge/lessons.jsonl'
];

// Boilerplate-derived tokens (from "read read_first notes before writing a plan").
const BOILERPLATE_TOKENS = new Set([
  'read', 'read_first', 'before', 'notes', 'writing', 'plan'
]);

// Korean command verbs / fillers / sentence fragments — no retrieval signal.
// Sourced from the frequency survey of the real data.
const KO_STOP = new Set([
  '구현', '구현해줘', '구현해', '하는데', '하는', '하고', '해줘', '해', '진행해', '진행',
  '시작해', '시작', '명세대로', '문서대로', '작성', '작성해줘', '작성해', '보고',
  '지금', '바로', '현재', '어떻게', '어떤', '사용할지', '사용', '싶은데', '싶어',
  '좀', '것', '수', '읽고', '확인', '확인해줘', '정리', '정리해줘', '알려', '알려줘',
  '만들어', '만들어줘', '추가', '추가해줘', '세션', '계획', '계획좀'
]);

// English stopwords / generic verbs.
const EN_STOP = new Set([
  'the', 'a', 'an', 'is', 'in', 'on', 'with', 'and', 'or', 'to', 'for',
  'this', 'that', 'after', 'add', 'fix', 'make', 'use', 'check'
]);

export function isPollutedKeyword(kw) {
  if (typeof kw !== 'string') return true;
  const raw = kw.trim();
  if (raw.length === 0) return true;

  // Strip a single trailing punctuation (e.g. "구현해줘.") for matching.
  const norm = raw.replace(/[.!?]+$/u, '').trim();
  const lower = norm.toLowerCase();

  if (norm.length < 2) return true;            // sub-2-char
  if (/^[0-9]+$/u.test(norm)) return true;     // pure number
  if (BOILERPLATE_TOKENS.has(lower)) return true;
  if (EN_STOP.has(lower)) return true;
  if (KO_STOP.has(norm)) return true;
  return false;
}

/**
 * Filter one row's trigger_keywords WITHOUT mutating it.
 * @returns {{ row, removed: number, kept: number }}
 */
export function cleanRowKeywords(row) {
  const tk = Array.isArray(row.trigger_keywords) ? row.trigger_keywords : null;
  if (!tk || tk.length === 0) return { row, removed: 0, kept: 0 };
  const kept = tk.filter((k) => !isPollutedKeyword(k));
  const removed = tk.length - kept.length;
  if (removed === 0) return { row, removed: 0, kept: kept.length };
  return { row: { ...row, trigger_keywords: kept }, removed, kept: kept.length };
}

function backupOnce(file, summary) {
  const bak = `${file}.tk.bak`;
  if (!fs.existsSync(bak)) {
    fs.copyFileSync(file, bak);
    summary.backup = bak;
  } else {
    summary.backup = `${bak} (existed — not overwritten)`;
  }
}

export function processFile(file, { dryRun = false } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { file, error: `read failed: ${err.message}` };
  }
  const trailingNewline = /\n$/.test(raw);
  const lines = raw.split(/\r?\n/);
  const out = [];
  let rowsTouched = 0;
  let totalRemoved = 0;
  let parsedRows = 0;
  const removedSamples = [];

  for (const line of lines) {
    const t = line.trim();
    if (t.length === 0) continue;
    let parsed;
    try { parsed = JSON.parse(t); } catch { out.push(line); continue; }
    parsedRows += 1;
    const before = Array.isArray(parsed.trigger_keywords) ? parsed.trigger_keywords : [];
    const r = cleanRowKeywords(parsed);
    if (r.removed > 0) {
      rowsTouched += 1;
      totalRemoved += r.removed;
      for (const k of before) {
        if (isPollutedKeyword(k) && removedSamples.length < 25) removedSamples.push(k);
      }
    }
    out.push(JSON.stringify(r.row));
  }

  const changed = totalRemoved > 0;
  const summary = { file, parsedRows, rowsTouched, totalRemoved, changed, removedSamples };
  if (dryRun || !changed) return summary;

  backupOnce(file, summary);
  fs.writeFileSync(file, out.join('\n') + (trailingNewline ? '\n' : ''), 'utf8');
  summary.written = true;
  return summary;
}

function main(argv) {
  const dryRun = argv.includes('--dry-run');
  console.log(`[clean-trigger-keywords] ${dryRun ? 'DRY RUN' : 'APPLY'}`);
  let totRemoved = 0;
  for (const file of TARGET_FILES) {
    const s = processFile(file, { dryRun });
    if (s.error) { console.log(`  SKIP  ${file}\n        ${s.error}`); continue; }
    totRemoved += s.totalRemoved;
    const tag = s.changed ? (s.written ? 'WROTE' : 'WOULD') : 'CLEAN';
    console.log(
      `  ${tag}  ${file}\n` +
      `        rows=${s.parsedRows} touched=${s.rowsTouched} removed=${s.totalRemoved}` +
      `${s.backup ? ` backup=${s.backup}` : ''}`
    );
    if (s.removedSamples && s.removedSamples.length) {
      console.log(`        removed e.g.: ${JSON.stringify(s.removedSamples.slice(0, 20))}`);
    }
  }
  console.log(`[clean-trigger-keywords] TOTAL removed=${totRemoved}`);
  return 0;
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('clean-trigger-keywords.mjs');
if (invokedDirectly) main(process.argv.slice(2));
