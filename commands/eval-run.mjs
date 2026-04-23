#!/usr/bin/env node

/**
 * eval-run — 4-axis eval orchestrator (Design-C §2-A).
 *
 * Loads Golden Tasks, invokes runGoldenTask for each (or a single --task),
 * then spawns eval-retrieval / eval-lesson-reuse / eval-performance sibling CLIs
 * for Quality / LessonReuse / Performance sections. Assembles the 9-top-level
 * EvalReport (§3-B) and writes via core/eval/report-writer. The last stdout
 * line is `REPORT=<absolute path>` for doctor --eval to parse (§4-D).
 *
 * Unidirectional: eval-run never calls doctor. exit 0 always; single-task
 * failures land in GoldenRun.failure and must not block other tasks.
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

import { loadGoldenTasks } from '../core/eval/golden-task-loader.mjs';
import { runGoldenTask } from '../core/eval/golden-task-runner.mjs';
import { writeReport } from '../core/eval/report-writer.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '..');

export function parseArgs(argv) {
  const args = {
    projectDir: '',
    goldenTasks: '',
    taskId: '',
    all: false,
    noRetrieval: false,
    noLessonReuse: false,
    noPerformance: false,
    windowDays: 30,
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--project-dir' && argv[i + 1]) {
      args.projectDir = argv[i + 1]; i++;
    } else if (tok === '--goldenTasks' && argv[i + 1]) {
      args.goldenTasks = argv[i + 1]; i++;
    } else if (tok === '--task' && argv[i + 1]) {
      args.taskId = argv[i + 1]; i++;
    } else if (tok === '--golden') {
      // accepted as a flag alias for --all
    } else if (tok === '--all') {
      args.all = true;
    } else if (tok === '--noRetrieval') {
      args.noRetrieval = true;
    } else if (tok === '--noLessonReuse') {
      args.noLessonReuse = true;
    } else if (tok === '--noPerformance') {
      args.noPerformance = true;
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
    'Usage: eval-run --golden --all [options]',
    '',
    'Options:',
    '  --project-dir <path>   Project root (default: $CLAUDE_PROJECT_DIR or cwd)',
    '  --goldenTasks <path>   Custom golden-tasks.json path',
    '  --golden               (marker flag)',
    '  --all                  Run all 10 tasks',
    '  --task <id>            Run a single task by id',
    '  --noRetrieval          Skip Quality axis',
    '  --noLessonReuse        Skip LessonReuse axis',
    '  --noPerformance        Skip Performance axis',
    '  --windowDays <n>       Rolling window for quality/reuse/perf (default: 30)',
    '  --help                 Show this help',
    ''
  ].join('\n'));
}

function resolvePackageRoot() {
  return process.env.CLAUDE_RUNTIME_HOME || PACKAGE_ROOT;
}

function readPackageVersion() {
  try {
    const raw = fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8');
    return JSON.parse(raw).version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function deriveProjectId(projectDir) {
  const base = path.basename(path.resolve(projectDir));
  return base || 'project';
}

function spawnJsonCli(cliRelPath, cliArgs) {
  const absCliPath = path.join(resolvePackageRoot(), cliRelPath);
  if (!fs.existsSync(absCliPath)) {
    return { ok: false, reason: `cli not found: ${absCliPath}` };
  }
  const result = spawnSync(
    process.execPath,
    [absCliPath, ...cliArgs],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
  );
  if (result.error) {
    return { ok: false, reason: `spawn error: ${result.error.message}` };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      reason: `exit ${result.status}`,
      stderr: (result.stderr || '').slice(0, 2000)
    };
  }
  const stdout = String(result.stdout || '').trim();
  if (!stdout) {
    return { ok: false, reason: 'empty stdout' };
  }
  // Parse the last JSON-looking line.
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.startsWith('{') || line.startsWith('[')) {
      try {
        return { ok: true, data: JSON.parse(line) };
      } catch {
        // keep looking
      }
    }
  }
  // Fallback: try parsing whole stdout.
  try {
    return { ok: true, data: JSON.parse(stdout) };
  } catch (err) {
    return { ok: false, reason: `stdout not JSON: ${err.message}` };
  }
}

export async function runEval(args) {
  const projectDir = path.resolve(
    args.projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd()
  );
  if (!fs.existsSync(projectDir)) {
    throw new Error(`project-dir does not exist: ${projectDir}`);
  }

  // 1) Load golden tasks.
  const loaded = await loadGoldenTasks({
    projectDir,
    tasksPath: args.goldenTasks || ''
  });
  let tasks = Array.isArray(loaded.tasks) ? loaded.tasks : [];
  if (args.taskId) {
    tasks = tasks.filter((t) => t.id === args.taskId);
    if (tasks.length === 0) {
      throw new Error(`task not found: ${args.taskId}`);
    }
  }

  // 2) Run each golden task (soft-fail per task).
  const goldenRuns = [];
  for (const task of tasks) {
    try {
      const run = await runGoldenTask(projectDir, task);
      goldenRuns.push(run);
    } catch (err) {
      goldenRuns.push({
        taskId: task.id,
        prompt: task.prompt,
        expectedScope: task.expectedScope,
        actualScopes: [],
        readFirstCount: 0,
        readFirstPaths: [],
        codeHitsCount: 0,
        codeHitsPaths: [],
        knowledgeHitsCount: 0,
        guardrailsCount: 0,
        matchedGroupsIds: [],
        wallTimeMs: 0,
        tokenCount: 0,
        rawSchemaKeys: [],
        failure: { message: `runGoldenTask threw: ${err.message}` }
      });
    }
  }

  // 3) Quality axis.
  let quality = {
    precisionAt5: null,
    recallAt10: null,
    mrr: null,
    ndcgAt10: null,
    sampleCount: 0,
    skipped: args.noRetrieval === true
  };
  if (!args.noRetrieval) {
    const r = spawnJsonCli('commands/eval-retrieval.mjs', [
      '--project-dir', projectDir,
      '--windowDays', String(args.windowDays)
    ]);
    if (r.ok && r.data && typeof r.data === 'object') {
      quality = { ...quality, ...r.data, skipped: false };
    } else {
      quality = { ...quality, warning: r.reason || 'eval-retrieval spawn failed' };
    }
  }

  // 4) Lesson reuse axis.
  let lessonReuse = {
    reuseRate: null,
    lessonsCreatedPre: 0,
    lessonsRematched: 0,
    confidenceDist: { high: 0, medium: 0, low: 0 },
    skipped: args.noLessonReuse === true
  };
  if (!args.noLessonReuse) {
    const r = spawnJsonCli('commands/eval-lesson-reuse.mjs', [
      '--project-dir', projectDir,
      '--windowDays', String(args.windowDays)
    ]);
    if (r.ok && r.data && typeof r.data === 'object') {
      lessonReuse = { ...lessonReuse, ...r.data, skipped: false };
    } else {
      lessonReuse = { ...lessonReuse, warning: r.reason || 'eval-lesson-reuse spawn failed' };
    }
  }

  // 5) Performance axis.
  let performance = {
    avgTaskStartMs: null,
    tokenWma7d: null,
    deltaVsPriorWeek: null,
    monotoneDecreasing3d: null,
    perDaySeries: [],
    skipped: args.noPerformance === true
  };
  if (!args.noPerformance) {
    const r = spawnJsonCli('commands/eval-performance.mjs', [
      '--project-dir', projectDir,
      '--windowDays', String(args.windowDays)
    ]);
    if (r.ok && r.data && typeof r.data === 'object') {
      performance = { ...performance, ...r.data, skipped: false };
    } else {
      performance = { ...performance, warning: r.reason || 'eval-performance spawn failed' };
    }
  }

  // 6) Assemble report (§3-B).
  const report = {
    projectId: deriveProjectId(projectDir),
    runtimeVersion: readPackageVersion(),
    reportedAt: new Date().toISOString(),
    goldenRuns,
    presence: {
      checksPassed: null,
      note: 'run doctor --full separately'
    },
    equivalence: {
      schemaMatch: 1.0,
      distributionSkew: 0
    },
    quality,
    lessonReuse,
    performance
  };

  // 7) Write + emit REPORT= stdout line.
  const reportPath = writeReport(projectDir, report);
  return { reportPath, report };
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }
  try {
    const { reportPath } = await runEval(args);
    // §4-D: last stdout line MUST be REPORT=<absolute path>.
    process.stdout.write(`REPORT=${reportPath}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`[eval-run] ${err.message}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (__filename === invokedPath) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      process.stderr.write(`[eval-run] ${err.message}\n`);
      process.exit(1);
    });
}
