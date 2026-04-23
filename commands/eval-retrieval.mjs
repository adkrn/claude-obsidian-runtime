#!/usr/bin/env node

/**
 * eval-retrieval — Quality axis (Design-C §2-F + §3-C).
 *
 * Reads events within a rolling window, groups by taskId, then for each task
 * computes Precision@5, Recall@10, MRR, and NDCG@10 against the per-task
 * runtime record (tasks/<taskId>.json). Emits aggregate + per-task rows as
 * a JSON object on stdout.
 *
 * Guardrail (A-C-9 / R-C-2): sampleCount < 5 => precisionAt5/recallAt10/mrr
 * are null with a `warning`. exit 0 is preserved.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  readEventsWindow,
  groupEventsByTask,
  extractFileReadsForTask,
  extractFirstEditedFile
} from '../core/eval/event-reader.mjs';
import { precisionAt, recallAt, mrr, ndcgAt } from '../core/eval/metrics.mjs';

const __filename = fileURLToPath(import.meta.url);

export function parseArgs(argv) {
  const args = { projectDir: '', windowDays: 30, help: false };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--project-dir' && argv[i + 1]) {
      args.projectDir = argv[i + 1]; i++;
    } else if (tok === '--windowDays' && argv[i + 1]) {
      const n = Number.parseInt(argv[i + 1], 10);
      if (Number.isFinite(n) && n > 0) args.windowDays = n;
      i++;
    } else if (tok === '--help' || tok === '-h') {
      args.help = true;
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write([
    'Usage: eval-retrieval --project-dir <path> [--windowDays <n>]',
    '',
    'Emits: { precisionAt5, recallAt10, mrr, ndcgAt10, sampleCount, perTaskRows, warning? }',
    ''
  ].join('\n'));
}

function loadTaskRecord(projectDir, taskId) {
  const p = path.join(projectDir, '.claude', 'runtime', 'tasks', `${taskId}.json`);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function toPathArray(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((r) => (r && typeof r === 'object' && typeof r.path === 'string' ? r.path : ''))
    .filter((s) => s.length > 0);
}

export function compute(projectDir, windowDays = 30, now = Date.now()) {
  const events = readEventsWindow(projectDir, windowDays, now);
  const grouped = groupEventsByTask(events);

  const perTaskRows = [];
  for (const [taskId, taskEvents] of grouped) {
    const record = loadTaskRecord(projectDir, taskId);
    if (!record) {
      perTaskRows.push({
        taskId,
        precisionAt5: null,
        recallAt10: null,
        mrr: null,
        ndcgAt10: null,
        reason: 'task record missing'
      });
      continue;
    }
    const fileReadSet = extractFileReadsForTask(taskEvents);
    const firstEdited = extractFirstEditedFile(taskEvents);
    const readFirst = toPathArray(record.readFirst);
    const codeHits = toPathArray(record.codeHits);
    const knowledgeHits = toPathArray(record.knowledgeHits);

    // NDCG relevanceScores: synthesize from fileReadSet (intersection → 1, else 0)
    // per A-C-6 default. If the record carries manualRelevanceScores, prefer it.
    const relevanceScores = record.manualRelevanceScores && typeof record.manualRelevanceScores === 'object'
      ? record.manualRelevanceScores
      : (() => {
          const map = {};
          for (const p of knowledgeHits) map[p] = fileReadSet.has(p) ? 1 : 0;
          return map;
        })();

    perTaskRows.push({
      taskId,
      precisionAt5: precisionAt(readFirst, fileReadSet, 5),
      recallAt10: recallAt(readFirst, fileReadSet, 10),
      mrr: mrr(codeHits, firstEdited),
      ndcgAt10: ndcgAt(knowledgeHits, relevanceScores, 10),
      fileReadCount: fileReadSet.size,
      firstEdited: firstEdited || null
    });
  }

  const sampleCount = perTaskRows.filter((r) => typeof r.precisionAt5 === 'number').length;

  if (sampleCount < 5) {
    return {
      precisionAt5: null,
      recallAt10: null,
      mrr: null,
      ndcgAt10: aggregateAvg(perTaskRows, 'ndcgAt10'),
      sampleCount,
      perTaskRows,
      warning: `insufficient data (sampleCount=${sampleCount} < 5)`
    };
  }

  return {
    precisionAt5: aggregateAvg(perTaskRows, 'precisionAt5'),
    recallAt10: aggregateAvg(perTaskRows, 'recallAt10'),
    mrr: aggregateAvg(perTaskRows, 'mrr'),
    ndcgAt10: aggregateAvg(perTaskRows, 'ndcgAt10'),
    sampleCount,
    perTaskRows
  };
}

function aggregateAvg(rows, key) {
  const values = rows
    .map((r) => r[key])
    .filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }
  const projectDir = path.resolve(
    args.projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd()
  );
  try {
    const result = compute(projectDir, args.windowDays);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`[eval-retrieval] ${err.message}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (__filename === invokedPath) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      process.stderr.write(`[eval-retrieval] ${err.message}\n`);
      process.exit(1);
    });
}
