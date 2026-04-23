#!/usr/bin/env node

/**
 * eval-routing — P3 Routing 4-metric evaluator CLI.
 *
 * Standalone command (does not modify eval-run.mjs). Loads routing-goldens.json
 * and optionally delegations-*.jsonl from project, invokes routing-evaluator.
 *
 * Stdout last line: ROUTING_REPORT=<absolute path> (pattern mirrors eval-run).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { evaluateRouting } from '../core/eval/routing-evaluator.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {
    projectDir: '',
    goldensPath: '',
    windowDays: 30,
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--project-dir' && argv[i + 1]) {
      args.projectDir = argv[i + 1]; i++;
    } else if (tok === '--goldens' && argv[i + 1]) {
      args.goldensPath = argv[i + 1]; i++;
    } else if (tok === '--window-days' && argv[i + 1]) {
      const n = Number.parseInt(argv[i + 1], 10);
      if (Number.isFinite(n) && n > 0) args.windowDays = n;
      i++;
    } else if (tok === '--help' || tok === '-h') {
      args.help = true;
    }
  }
  return args;
}

function resolvePackageRoot() {
  return process.env.CLAUDE_RUNTIME_HOME || PACKAGE_ROOT;
}

function loadRoutingGoldens(args) {
  const candidates = [];
  if (args.goldensPath) candidates.push(args.goldensPath);
  candidates.push(path.join(args.projectDir, 'templates/eval/routing-goldens.json'));
  candidates.push(path.join(resolvePackageRoot(), 'templates/eval/routing-goldens.json'));
  for (const p of candidates) {
    if (p && fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  }
  throw new Error('routing-goldens.json not found in any candidate path');
}

function loadDelegationRecords(projectDir, windowDays) {
  const runtimeDir = path.join(projectDir, '.claude', 'runtime');
  if (!fs.existsSync(runtimeDir)) return [];
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const out = [];
  for (const entry of fs.readdirSync(runtimeDir)) {
    if (!/^delegations-\d{4}-\d{2}(\.part\d+)?\.jsonl$/.test(entry)) continue;
    const full = path.join(runtimeDir, entry);
    const st = fs.statSync(full);
    if (st.mtimeMs < cutoff) continue;
    const raw = fs.readFileSync(full, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed));
      } catch {
        // skip invalid lines; evaluator will also skip via validator.
      }
    }
  }
  return out;
}

function loadAgentCatalog(projectDir) {
  const agentsDir = path.join(projectDir, '.claude', 'agents');
  if (!fs.existsSync(agentsDir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(agentsDir)) {
    if (!entry.endsWith('.md')) continue;
    const raw = fs.readFileSync(path.join(agentsDir, entry), 'utf8');
    const match = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!match) continue;
    const yaml = match[1];
    const entryObj = { name: '', triggers: [], domain: [] };
    const nameMatch = yaml.match(/^name:\s*(.+)$/m);
    if (nameMatch) entryObj.name = nameMatch[1].trim();
    const triggersMatch = yaml.match(/^triggers:\s*\n((?:\s*-\s*.+\n?)*)/m);
    if (triggersMatch) {
      entryObj.triggers = triggersMatch[1].split(/\n/)
        .map((l) => l.replace(/^\s*-\s*/, '').trim())
        .filter(Boolean);
    }
    const domainMatch = yaml.match(/^domain:\s*\n((?:\s*-\s*.+\n?)*)/m);
    if (domainMatch) {
      entryObj.domain = domainMatch[1].split(/\n/)
        .map((l) => l.replace(/^\s*-\s*/, '').trim())
        .filter(Boolean);
    }
    if (entryObj.name) out.push(entryObj);
  }
  return out;
}

function writeRoutingReport(projectDir, report) {
  const outDir = path.join(projectDir, '.claude', 'runtime', 'eval');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(outDir, `routing-report-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  return outPath;
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write([
      'Usage: eval-routing [options]',
      '  --project-dir <path>      Project root (default: cwd)',
      '  --goldens <path>          routing-goldens.json path',
      '  --window-days <n>         Delegation window in days (default: 30)',
      ''
    ].join('\n'));
    return 0;
  }
  try {
    const projectDir = path.resolve(args.projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd());
    const goldens = loadRoutingGoldens({ projectDir, goldensPath: args.goldensPath });
    const delegationLogs = loadDelegationRecords(projectDir, args.windowDays);
    const agentCatalog = loadAgentCatalog(projectDir);
    const report = evaluateRouting({ goldens, delegationLogs, agentCatalog });
    const reportPath = writeRoutingReport(projectDir, {
      schemaVersion: '1.0.0',
      reportedAt: new Date().toISOString(),
      windowDays: args.windowDays,
      metrics: {
        delegationCorrectness: report.delegationCorrectness,
        bouncingRate: report.bouncingRate,
        loopRate: report.loopRate,
        recoveryRate: report.recoveryRate
      },
      details: report.details
    });
    process.stdout.write(`ROUTING_REPORT=${reportPath}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`[eval-routing] ${err.message}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (__filename === invokedPath) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      process.stderr.write(`[eval-routing] ${err.message}\n`);
      process.exit(1);
    });
}
