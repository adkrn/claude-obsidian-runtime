#!/usr/bin/env node

/**
 * eval-compare — diff two EvalReport JSONs (Design-C §2-C + §3-D).
 *
 * Usage: eval-compare --reports A.json B.json [--json]
 *   exit 0 = pass  (no stderr)
 *   exit 0 = warn  (stderr warning lines, stdout has table)
 *   exit 1 = fail  (stdout has table + failure reasons)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { compareReports, formatCompareTable } from '../core/eval/compare-engine.mjs';

const __filename = fileURLToPath(import.meta.url);

export function parseArgs(argv) {
  const args = { reports: [], json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--reports') {
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args.reports.push(argv[i + 1]);
        i++;
      }
    } else if (tok === '--json') {
      args.json = true;
    } else if (tok === '--help' || tok === '-h') {
      args.help = true;
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write([
    'Usage: eval-compare --reports A.json B.json [--json]',
    '',
    'Exit codes: 0=pass|warn, 1=fail',
    ''
  ].join('\n'));
}

function readReport(p) {
  const resolved = path.resolve(p);
  if (!fs.existsSync(resolved)) {
    throw new Error(`report not found: ${resolved}`);
  }
  try {
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (err) {
    throw new Error(`report not valid JSON (${resolved}): ${err.message}`);
  }
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }
  if (args.reports.length < 2) {
    process.stderr.write('[eval-compare] --reports A.json B.json required\n');
    return 1;
  }
  try {
    const reportA = readReport(args.reports[0]);
    const reportB = readReport(args.reports[1]);
    const result = compareReports(reportA, reportB);
    const out = formatCompareTable(result, args.json ? 'json' : 'text');
    process.stdout.write(`${out}\n`);
    if (result.verdict === 'warn') {
      process.stderr.write(`[eval-compare] warn: ${result.warnings.join('; ')}\n`);
    }
    return result.verdict === 'fail' ? 1 : 0;
  } catch (err) {
    process.stderr.write(`[eval-compare] ${err.message}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (__filename === invokedPath) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      process.stderr.write(`[eval-compare] ${err.message}\n`);
      process.exit(1);
    });
}
