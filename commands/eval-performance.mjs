#!/usr/bin/env node

/**
 * eval-performance — Performance axis (Design-C §2-H + §3-C).
 *
 * Reads .claude/runtime/task-usage/*.json + tasks/*.json within a rolling
 * window, aggregates per-day series (avgTokens, avgWallTimeMs, sampleCount),
 * computes the 7-day weighted moving average (tokenWma7d), delta vs. prior
 * week in percent, and whether the last 3 days show monotonically
 * decreasing token usage (monotoneDecreasing3d).
 *
 * Guardrail: sampleCount < 3 in the window ⇒ monotoneDecreasing3d is null.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const DAY_MS = 86400 * 1000;

export function parseArgs(argv) {
  const args = {
    projectDir: '',
    windowDays: 30,
    baselineDays: 3,
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--project-dir' && argv[i + 1]) {
      args.projectDir = argv[i + 1]; i++;
    } else if (tok === '--windowDays' && argv[i + 1]) {
      const n = Number.parseInt(argv[i + 1], 10);
      if (Number.isFinite(n) && n > 0) args.windowDays = n;
      i++;
    } else if (tok === '--baselineDays' && argv[i + 1]) {
      const n = Number.parseInt(argv[i + 1], 10);
      if (Number.isFinite(n) && n > 0) args.baselineDays = n;
      i++;
    } else if (tok === '--help' || tok === '-h') {
      args.help = true;
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write([
    'Usage: eval-performance --project-dir <path> [--windowDays <n>] [--baselineDays <n>]',
    '',
    'Emits: { avgTaskStartMs, tokenWma7d, deltaVsPriorWeek, monotoneDecreasing3d, perDaySeries }',
    ''
  ].join('\n'));
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function loadTaskUsageRecords(projectDir) {
  const dir = path.join(projectDir, '.claude', 'runtime', 'task-usage');
  const out = [];
  for (const name of safeReaddir(dir)) {
    if (!name.endsWith('.json')) continue;
    const full = path.join(dir, name);
    const rec = readJsonSafe(full);
    if (!rec) continue;
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(full).mtimeMs;
    } catch {}
    out.push({ file: name, rec, mtimeMs });
  }
  return out;
}

function loadTaskRecords(projectDir) {
  const dir = path.join(projectDir, '.claude', 'runtime', 'tasks');
  const out = [];
  for (const name of safeReaddir(dir)) {
    if (!name.endsWith('.json')) continue;
    const rec = readJsonSafe(path.join(dir, name));
    if (rec) out.push(rec);
  }
  return out;
}

function extractTokenTotal(record) {
  if (!record) return 0;
  if (typeof record.totalTokens === 'number') return record.totalTokens;
  if (record.usage && typeof record.usage.totalTokens === 'number') return record.usage.totalTokens;
  if (typeof record.tokens === 'number') return record.tokens;
  if (record.summary && typeof record.summary.totalTokens === 'number') return record.summary.totalTokens;
  return 0;
}

function parseTs(value) {
  if (!value) return NaN;
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : NaN;
}

function ymd(ts) {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function computePerformance(projectDir, opts = {}) {
  const windowDays = opts.windowDays || 30;
  const baselineDays = opts.baselineDays || 3;
  const now = opts.now || Date.now();
  const cutoff = now - windowDays * DAY_MS;

  const taskRecords = loadTaskRecords(projectDir);
  const usageRecords = loadTaskUsageRecords(projectDir);

  // Map taskId -> wallTime (closedAt - createdAt), createdAt.
  const taskTsById = new Map();
  for (const t of taskRecords) {
    if (!t?.taskId) continue;
    const created = parseTs(t.createdAt);
    const closed = parseTs(t.closedAt || t.updatedAt);
    if (!Number.isFinite(created)) continue;
    const wallMs = Number.isFinite(closed) && closed >= created ? closed - created : null;
    taskTsById.set(t.taskId, { createdAt: created, wallMs });
  }

  // Bucket usage records by day (YYYY-MM-DD).
  const byDay = new Map();
  for (const { rec, mtimeMs } of usageRecords) {
    const taskId = rec?.taskId || rec?.task?.taskId || '';
    const meta = taskId ? taskTsById.get(taskId) : null;
    const when = meta?.createdAt || mtimeMs;
    if (!Number.isFinite(when) || when < cutoff) continue;
    const key = ymd(when);
    const total = extractTokenTotal(rec);
    if (!byDay.has(key)) {
      byDay.set(key, { date: key, tokenSum: 0, tokenSamples: 0, wallSum: 0, wallSamples: 0 });
    }
    const b = byDay.get(key);
    if (total > 0) {
      b.tokenSum += total;
      b.tokenSamples += 1;
    }
    if (meta?.wallMs && Number.isFinite(meta.wallMs)) {
      b.wallSum += meta.wallMs;
      b.wallSamples += 1;
    }
  }

  const perDaySeries = Array.from(byDay.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((b) => ({
      date: b.date,
      avgTokens: b.tokenSamples > 0 ? b.tokenSum / b.tokenSamples : 0,
      avgWallTimeMs: b.wallSamples > 0 ? b.wallSum / b.wallSamples : null,
      sampleCount: Math.max(b.tokenSamples, b.wallSamples)
    }));

  const totalSamples = perDaySeries.reduce((s, d) => s + d.sampleCount, 0);

  // Overall avgTaskStartMs (wall time mean across records with samples).
  const wallSeries = perDaySeries.filter((d) => d.avgWallTimeMs !== null);
  const avgTaskStartMs = wallSeries.length === 0
    ? null
    : wallSeries.reduce((s, d) => s + d.avgWallTimeMs, 0) / wallSeries.length;

  // tokenWma7d: weighted moving average over the last 7 day-buckets (or fewer).
  const last7 = perDaySeries.slice(-7);
  let tokenWma7d = null;
  if (last7.length > 0) {
    let weighted = 0;
    let weightSum = 0;
    last7.forEach((d, i) => {
      const w = i + 1;
      weighted += d.avgTokens * w;
      weightSum += w;
    });
    tokenWma7d = weightSum > 0 ? weighted / weightSum : 0;
  }

  // deltaVsPriorWeek: avg of last 7 tokens vs avg of prior 7.
  let deltaVsPriorWeek = null;
  if (perDaySeries.length >= 14) {
    const latest7 = perDaySeries.slice(-7).map((d) => d.avgTokens);
    const prior7 = perDaySeries.slice(-14, -7).map((d) => d.avgTokens);
    const avgLatest = latest7.reduce((s, v) => s + v, 0) / latest7.length;
    const avgPrior = prior7.reduce((s, v) => s + v, 0) / prior7.length;
    if (avgPrior > 0) {
      deltaVsPriorWeek = (avgLatest - avgPrior) / avgPrior;
    }
  }

  // monotoneDecreasing3d: last `baselineDays` points strictly decreasing.
  let monotoneDecreasing3d = null;
  if (totalSamples >= baselineDays && perDaySeries.length >= baselineDays) {
    const tail = perDaySeries.slice(-baselineDays);
    let strict = true;
    for (let i = 1; i < tail.length; i++) {
      if (!(tail[i].avgTokens < tail[i - 1].avgTokens)) {
        strict = false;
        break;
      }
    }
    monotoneDecreasing3d = strict;
  }

  return {
    avgTaskStartMs,
    tokenWma7d,
    deltaVsPriorWeek,
    monotoneDecreasing3d,
    perDaySeries
  };
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
    const result = computePerformance(projectDir, {
      windowDays: args.windowDays,
      baselineDays: args.baselineDays
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`[eval-performance] ${err.message}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (__filename === invokedPath) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      process.stderr.write(`[eval-performance] ${err.message}\n`);
      process.exit(1);
    });
}
