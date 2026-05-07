#!/usr/bin/env node

/**
 * doctor — 12-check runtime health diagnostic (Design-B §1~§5).
 *
 * Modes:
 *   (default)  basic: C01..C06 (6 checks)
 *   --full     full:  C01..C12 (all 12 via core/doctor-checks ALL_CHECK_IDS)
 *   --eval     spawn eval-run after full pass (Design-C integration)
 *   --json     machine-readable output (Design-B §5-3)
 *
 * Rollback (§12-4):
 *   --since-init           : enable post-init rollback flow
 *   --no-rollback-on-failure : skip rollback prompt (CI mode)
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  ALL_CHECK_IDS,
  checkRuntimeHome,
  checkManifestSchema,
  checkObsidianPaths,
  checkManagedRoots,
  checkHookWrappers,
  checkLeadAgent,
  checkCodeIndex,
  checkKnowledgeIndex,
  checkTaskStartDryRun,
  checkPrerequisites,
  checkTemplateIntegrity,
  checkPerformanceObservability
} from '../core/doctor-checks.mjs';

import {
  findLatestBackup,
  diffAgainstBackup,
  promptRollback,
  performRollback
} from '../core/doctor-rollback.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '..');

const BASIC_CHECK_IDS = ['c01', 'c02', 'c03', 'c04', 'c05', 'c06'];

const CHECK_FN_MAP = {
  c01: checkRuntimeHome,
  c02: checkManifestSchema,
  c03: checkObsidianPaths,
  c04: checkManagedRoots,
  c05: checkHookWrappers,
  c06: checkLeadAgent,
  c07: checkCodeIndex,
  c08: checkKnowledgeIndex,
  c09: checkTaskStartDryRun,
  c10: checkPrerequisites,
  c11: checkTemplateIntegrity,
  c12: checkPerformanceObservability
};

/**
 * @typedef {Object} DoctorArgs
 * @property {string} projectDir
 * @property {boolean} full
 * @property {boolean} eval
 * @property {boolean} json
 * @property {boolean} noRollback
 * @property {boolean} sinceInit
 * @property {boolean} help
 */

export function parseArgs(argv) {
  const args = {
    projectDir: '',
    full: false,
    eval: false,
    json: false,
    noRollback: false,
    sinceInit: false,
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--project-dir' && argv[i + 1]) {
      args.projectDir = argv[i + 1];
      i++;
    } else if (tok === '--full') {
      args.full = true;
    } else if (tok === '--eval') {
      args.eval = true;
    } else if (tok === '--json') {
      args.json = true;
    } else if (tok === '--no-rollback-on-failure') {
      args.noRollback = true;
    } else if (tok === '--since-init') {
      args.sinceInit = true;
    } else if (tok === '--help' || tok === '-h') {
      args.help = true;
    }
  }
  args.projectDir = path.resolve(
    args.projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd()
  );
  return args;
}

function printHelp() {
  process.stdout.write([
    'Usage: doctor [options]',
    '',
    'Options:',
    '  --project-dir <path>       Project root (default: $CLAUDE_PROJECT_DIR or cwd)',
    '  --full                     Run all 12 checks (default runs C01..C06)',
    '  --eval                     After full pass, run eval-run (Design-C)',
    '  --json                     Machine-readable output (Design-B §5-3)',
    '  --since-init               Enable post-init rollback flow (§12-4)',
    '  --no-rollback-on-failure   Skip rollback prompt (CI mode)',
    '  --help                     Show this help',
    ''
  ].join('\n'));
}

function pkgVersion() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')
    ).version;
  } catch {
    return 'unknown';
  }
}

function resolvePackageRoot() {
  return process.env.CLAUDE_RUNTIME_HOME || PACKAGE_ROOT;
}

export function buildContext(args) {
  return {
    projectDir: args.projectDir,
    packageRoot: resolvePackageRoot(),
    manifest: null,
    paths: null
  };
}

/**
 * Run selected checks sequentially, sharing ctx across calls so that
 * C02/C03 populate manifest/paths for downstream checks.
 *
 * Exported for in-process callers (DESIGN_MANUS_4A §7 — task-close --verify
 * imports doctor instead of spawning, to keep the call cheap and one-way:
 * task-close → doctor). Caller-supplied ctx must include `projectDir` and
 * `packageRoot`; pass `buildContext(parseArgs([...]))` to construct one
 * with the same defaults the CLI uses.
 */
export async function runChecks(checkIds, ctx) {
  const checks = [];
  for (const id of checkIds) {
    const fn = CHECK_FN_MAP[id];
    if (!fn) continue;
    let result;
    try {
      result = await fn(ctx);
    } catch (err) {
      result = {
        id,
        name: id,
        status: 'fail',
        message: `check threw: ${err.message}`
      };
    }
    checks.push(result);
  }
  return checks;
}

function countStatuses(checks) {
  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const c of checks) {
    if (counts[c.status] !== undefined) counts[c.status] += 1;
  }
  return counts;
}

function statusIcon(status) {
  return {
    pass: '[OK]',
    warn: '[WARN]',
    fail: '[FAIL]',
    pending: '[...]'
  }[status] || '[?]';
}

/**
 * Design-B §5-1/§5-2: human-readable report. Returns exit code.
 */
function printReportText(checks, args, elapsedMs) {
  const counts = countStatuses(checks);
  const mode = args.full ? 'full' : 'basic';
  const suffix = args.sinceInit ? ' (--since-init)' : '';

  console.log('claude-obsidian-runtime doctor');
  console.log(`Package:     v${pkgVersion()}`);
  console.log(`Project:     ${args.projectDir}`);
  console.log(`Mode:        ${mode}${suffix}`);
  console.log('');

  for (const c of checks) {
    const id = (c.id || '').toUpperCase().padEnd(4);
    const icon = statusIcon(c.status).padEnd(7);
    const name = (c.name || '').padEnd(38);
    console.log(`${icon} ${id} ${name} ${c.message}`);
    if (c.detail?.remedy) {
      console.log(`        -> ${c.detail.remedy}`);
    }
  }
  console.log('');
  const elapsedSec = (elapsedMs / 1000).toFixed(1);
  console.log(
    `Summary: ${counts.pass} pass, ${counts.warn} warn, ${counts.fail} fail   (elapsed: ${elapsedSec}s)`
  );
  return counts.fail > 0 ? 1 : 0;
}

/**
 * Design-B §5-3: JSON output.
 */
function printReportJson(checks, args, elapsedMs, rollbackInfo) {
  const counts = countStatuses(checks);
  const payload = {
    package: pkgVersion(),
    projectDir: args.projectDir,
    mode: args.full ? 'full' : 'basic',
    sinceInit: args.sinceInit,
    counts,
    elapsedMs,
    checks: checks.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      message: c.message,
      detail: c.detail,
      elapsedMs: c.elapsedMs
    }))
  };
  if (rollbackInfo) payload.rollback = rollbackInfo;
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  return counts.fail > 0 ? 1 : 0;
}

/**
 * Design-B §5-2, §12-4: rollback flow.
 * Returns { handled: boolean, exitCode?: number, info?: object }.
 */
async function maybeRollback(args, checks) {
  const failCount = checks.filter((c) => c.status === 'fail').length;
  if (failCount === 0) return { handled: false };
  if (!args.sinceInit) return { handled: false };

  const backupDir = findLatestBackup(args.projectDir);
  if (!backupDir) {
    return {
      handled: false,
      info: {
        available: false,
        performed: false,
        reason: 'no backup found'
      }
    };
  }

  // CI mode / non-interactive — skip prompt.
  if (args.noRollback || args.json || !process.stdin.isTTY) {
    return {
      handled: false,
      info: {
        available: true,
        backupDir,
        performed: false,
        reason: args.noRollback
          ? '--no-rollback-on-failure'
          : args.json
          ? '--json (non-interactive)'
          : 'non-TTY'
      }
    };
  }

  const diff = diffAgainstBackup(args.projectDir, backupDir);
  console.log('');
  console.log('---');
  console.log(`${failCount} check(s) failed during post-init validation.`);
  console.log('Automatic rollback available:');
  console.log(`  Backup: ${path.basename(backupDir)}/`);
  if (diff.length > 0) {
    console.log('  Changes to restore:');
    for (const line of diff.slice(0, 10)) {
      console.log(`    ${line.status} ${line.path}`);
    }
    if (diff.length > 10) {
      console.log(`    ... (${diff.length - 10} more)`);
    }
  }
  console.log('');

  const choice = await promptRollback(diff);
  if (choice !== 'rollback') {
    return {
      handled: true,
      exitCode: 1,
      info: {
        available: true,
        backupDir,
        performed: false,
        reason: 'user declined'
      }
    };
  }

  const outcome = await performRollback({
    projectDir: args.projectDir,
    backupDir,
    failures: checks.filter((c) => c.status === 'fail')
  });
  console.log('');
  console.log(
    `Rollback complete: ${outcome.restored.length} restored, ${outcome.partial.length} partial.`
  );
  if (outcome.partial.length > 0 && outcome.logPath) {
    console.log(`  Partial log: ${outcome.logPath}`);
  }
  return {
    handled: true,
    exitCode: 2,
    info: {
      available: true,
      backupDir,
      performed: true,
      restored: outcome.restored.length,
      partial: outcome.partial.length
    }
  };
}

/**
 * Design-B §5-4: --eval spawns commands/eval-run.mjs after full pass.
 */
function runEvalMode(args, checks) {
  const counts = countStatuses(checks);
  if (counts.fail > 0) {
    console.log('');
    console.log('Cannot run eval with failed checks. Eval skipped.');
    return 1;
  }

  const evalRunPath = path.join(resolvePackageRoot(), 'commands', 'eval-run.mjs');
  if (!fs.existsSync(evalRunPath)) {
    console.log('');
    console.log(`Eval report: (skipped — Design-C not yet integrated at ${evalRunPath})`);
    return counts.fail > 0 ? 1 : 0;
  }

  const result = spawnSync(
    process.execPath,
    [evalRunPath, '--golden', '--all', '--project-dir', args.projectDir],
    { encoding: 'utf8' }
  );

  if (result.error) {
    console.log('');
    console.log(`Eval report: (spawn failed: ${result.error.message})`);
    return 1;
  }

  const stdout = String(result.stdout || '');
  if (stdout) process.stdout.write(stdout);
  const stderr = String(result.stderr || '');
  if (stderr) process.stderr.write(stderr);

  const reportLine = stdout
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.startsWith('REPORT='));
  const reportPath = reportLine ? reportLine.slice('REPORT='.length).trim() : '';
  console.log('');
  if (reportPath) {
    console.log(`Eval report: ${reportPath}`);
  } else {
    console.log('Eval report: (no REPORT= line in eval-run stdout)');
  }

  return result.status ?? 1;
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }

  const started = Date.now();
  const ctx = buildContext(args);
  const checkIds = args.full ? ALL_CHECK_IDS : BASIC_CHECK_IDS;
  const checks = await runChecks(checkIds, ctx);
  const elapsedMs = Date.now() - started;

  // JSON mode: skip rollback prompt entirely, emit machine-readable report.
  if (args.json) {
    const rb = await maybeRollback(args, checks);
    const exitCode = printReportJson(checks, args, elapsedMs, rb.info);
    return rb.handled && typeof rb.exitCode === 'number' ? rb.exitCode : exitCode;
  }

  let exitCode = printReportText(checks, args, elapsedMs);

  // --eval takes precedence over rollback when all checks pass.
  if (args.eval && args.full) {
    const evalExit = runEvalMode(args, checks);
    if (typeof evalExit === 'number') exitCode = evalExit;
    return exitCode;
  }

  const rb = await maybeRollback(args, checks);
  if (rb.handled && typeof rb.exitCode === 'number') {
    return rb.exitCode;
  }
  return exitCode;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (__filename === invokedPath) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      console.error(`[doctor] ${err.message}`);
      process.exit(1);
    });
}
