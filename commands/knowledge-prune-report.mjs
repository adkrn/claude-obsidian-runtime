#!/usr/bin/env node

/**
 * knowledge-prune-report — READ-ONLY stale/duplicate report for knowledge indexes.
 *
 * Scans .claude/runtime/knowledge/{lessons,decisions,troubleshooting,architecture}.jsonl
 * and prints candidates for human review:
 *   - STALE: updatedAt older than --stale-days AND unaccessed (access_count 0/absent).
 *   - DUPLICATE: same-scope pairs with high token jaccard OR file overlap.
 *
 * THIS COMMAND NEVER DELETES, QUARANTINES, OR EDITS ANYTHING. It only reads the
 * jsonl files and writes a report to stdout. Acting on the report is a manual,
 * human-reviewed step (03_ROADMAP Phase D — conservative forgetting, surface only).
 * Rationale: a prior incident permanently lost mirror-only files to a direct unlink.
 *
 * Usage:
 *   node commands/knowledge-prune-report.mjs [--project-dir <dir>] [--kind <k>]
 *                                            [--stale-days N] [--jaccard 0.6] [--json]
 *   --kind: lesson|decision|troubleshooting|architecture (default: all)
 *   --json: emit a single JSON object instead of human-readable text.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { getRuntimePaths, loadJsonl } from '../core/runtime-lib.mjs';
import { buildPruneReport, DEFAULT_PRUNE_OPTS } from '../core/knowledge-prune.mjs';

const KIND_FILES = {
  lesson: 'lessons.jsonl',
  decision: 'decisions.jsonl',
  troubleshooting: 'troubleshooting.jsonl',
  architecture: 'architecture.jsonl'
};

function parseArgs(argv) {
  const args = {
    projectDir: '',
    kind: '',
    staleDays: DEFAULT_PRUNE_OPTS.staleDays,
    jaccard: DEFAULT_PRUNE_OPTS.jaccardThreshold,
    top: 20,
    json: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--project-dir') { args.projectDir = argv[++i] || ''; }
    else if (a === '--kind') { args.kind = argv[++i] || ''; }
    else if (a === '--stale-days') { args.staleDays = Number.parseInt(argv[++i], 10) || args.staleDays; }
    else if (a === '--jaccard') { args.jaccard = Number.parseFloat(argv[++i]) || args.jaccard; }
    else if (a === '--top') { args.top = Number.parseInt(argv[++i], 10) || args.top; }
    else if (a === '--json') { args.json = true; }
  }
  return args;
}

function reportForKind(projectDir, kind, opts) {
  const file = path.join(getRuntimePaths(projectDir).knowledgeRoot, KIND_FILES[kind]);
  const rows = loadJsonl(file); // loadJsonl returns [] if the file is missing
  const report = buildPruneReport(rows, opts);
  return { kind, file, ...report };
}

function printText(reports, opts, top) {
  const lines = [];
  lines.push('# knowledge-prune-report (READ-ONLY — no files were changed)');
  lines.push(`  stale-days=${opts.staleDays}  jaccard>=${opts.jaccardThreshold}  fileOverlap>=${opts.fileOverlapMin}  show-top=${top}`);
  for (const r of reports) {
    lines.push('');
    lines.push(`## ${r.kind} (${r.totalRows} rows) — stale=${r.staleCount} duplicatePairs=${r.duplicateCount}`);
    if (r.staleCount > 0) {
      lines.push('  STALE (old + unaccessed) — review, do not auto-delete:');
      for (const s of r.stale.slice(0, top)) {
        lines.push(`    - [${s.ageDays}d] ${s.id}  access=${s.access_count}  ${truncate(s.title, 60)}`);
      }
      if (r.staleCount > top) lines.push(`    … +${r.staleCount - top} more (raise --top or use --json for all)`);
    }
    if (r.duplicateCount > 0) {
      lines.push('  DUPLICATE candidates (same scope, high overlap) — review for merge:');
      for (const d of r.duplicatePairs.slice(0, top)) {
        lines.push(`    - jaccard=${d.jaccard} files=${d.fileOverlap} [${d.scope}]`);
        lines.push(`        ${d.a.id}  ::  ${d.b.id}`);
      }
      if (r.duplicateCount > top) lines.push(`    … +${r.duplicateCount - top} more (raise --top or use --json for all)`);
    }
    if (r.staleCount === 0 && r.duplicateCount === 0) {
      lines.push('  (clean — no stale or duplicate candidates)');
    }
  }
  lines.push('');
  lines.push('NOTE: This is a report only. To act, review each candidate and remove/merge');
  lines.push('      manually (with backup). Nothing here was deleted or modified.');
  return lines.join('\n');
}

function truncate(s, n) {
  const str = String(s || '');
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

export function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const projectDir = path.resolve(args.projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const opts = {
    staleDays: args.staleDays,
    jaccardThreshold: args.jaccard,
    fileOverlapMin: DEFAULT_PRUNE_OPTS.fileOverlapMin
  };

  const kinds = args.kind ? [args.kind] : Object.keys(KIND_FILES);
  const reports = kinds
    .filter((k) => KIND_FILES[k])
    .map((k) => reportForKind(projectDir, k, opts));

  if (args.json) {
    process.stdout.write(JSON.stringify({ ok: true, projectDir, opts, reports }) + '\n');
  } else {
    process.stdout.write(printText(reports, opts, args.top) + '\n');
  }
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exit(run());
}
