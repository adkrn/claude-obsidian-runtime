#!/usr/bin/env node

/**
 * eval-lesson-reuse — LessonReuse axis (Design-C §2-G + §3-C).
 *
 * Walks knowledge/lessons.jsonl, filters lessons created ≥ windowDays ago
 * (lessonsCreatedPre), then scans tasks/*.json knowledgeHits within the
 * window to count how many distinct lesson ids got re-matched. Emits the
 * reuseRate plus a confidence distribution (high/medium/low).
 *
 * Optional --compareWith <otherProjectDir>: computes chi-squared homogeneity
 * test over the two confidence distributions using core/eval/metrics.chiSquared.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { chiSquared } from '../core/eval/metrics.mjs';

const __filename = fileURLToPath(import.meta.url);
const DAY_MS = 86400 * 1000;

export function parseArgs(argv) {
  const args = {
    projectDir: '',
    windowDays: 30,
    compareWith: '',
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
    } else if (tok === '--compareWith' && argv[i + 1]) {
      args.compareWith = argv[i + 1]; i++;
    } else if (tok === '--help' || tok === '-h') {
      args.help = true;
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write([
    'Usage: eval-lesson-reuse --project-dir <path> [--windowDays <n>] [--compareWith <otherProjectDir>]',
    '',
    'Emits: { reuseRate, lessonsCreatedPre, lessonsRematched, confidenceDist, chiSquared?, warning? }',
    ''
  ].join('\n'));
}

function loadLessonRows(projectDir) {
  const p = path.join(projectDir, '.claude', 'runtime', 'knowledge', 'lessons.jsonl');
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // skip malformed
    }
  }
  return out;
}

function loadTaskRecords(projectDir) {
  const dir = path.join(projectDir, '.claude', 'runtime', 'tasks');
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const rows = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    try {
      const row = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      rows.push(row);
    } catch {
      // skip unreadable
    }
  }
  return rows;
}

function parseTs(value) {
  if (!value) return NaN;
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : NaN;
}

function buildConfidenceDist(lessons) {
  const dist = { high: 0, medium: 0, low: 0 };
  for (const l of lessons) {
    const key = String(l?.confidence || 'medium').toLowerCase();
    if (key in dist) dist[key] += 1;
    else dist.medium += 1;
  }
  return dist;
}

export function computeReuseRate(projectDir, windowDays = 30, now = Date.now()) {
  const cutoff = now - windowDays * DAY_MS;
  const lessons = loadLessonRows(projectDir);

  // lessonsCreatedPre: created BEFORE the rolling window started.
  const lessonsCreatedPre = lessons.filter((l) => {
    const ts = parseTs(l?.created_at);
    return Number.isFinite(ts) && ts < cutoff && !l?.duplicateOf;
  });
  const lessonIdsPre = new Set(lessonsCreatedPre.map((l) => String(l.id || '')));

  const tasks = loadTaskRecords(projectDir);
  const rematched = new Set();
  for (const task of tasks) {
    const ts = parseTs(task?.updatedAt || task?.createdAt);
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    const hits = Array.isArray(task.knowledgeHits) ? task.knowledgeHits : [];
    for (const hit of hits) {
      const id = hit && typeof hit === 'object' ? String(hit.id || '') : '';
      if (id && lessonIdsPre.has(id)) rematched.add(id);
    }
  }

  const confidenceDist = buildConfidenceDist(lessons);
  const base = {
    lessonsCreatedPre: lessonsCreatedPre.length,
    lessonsRematched: rematched.size,
    confidenceDist
  };
  if (lessonsCreatedPre.length === 0) {
    return {
      reuseRate: 0,
      ...base,
      warning: 'no lessons created before the rolling window'
    };
  }
  return {
    reuseRate: rematched.size / lessonsCreatedPre.length,
    ...base
  };
}

export function compare(projectDir, otherDir, windowDays = 30, now = Date.now()) {
  const self = computeReuseRate(projectDir, windowDays, now);
  const other = computeReuseRate(otherDir, windowDays, now);
  const keys = ['high', 'medium', 'low'];
  const obsA = keys.map((k) => self.confidenceDist[k] || 0);
  const obsB = keys.map((k) => other.confidenceDist[k] || 0);
  const chi = chiSquared(obsA, obsB);
  return {
    ...self,
    chiSquared: chi,
    other: {
      reuseRate: other.reuseRate,
      lessonsCreatedPre: other.lessonsCreatedPre,
      confidenceDist: other.confidenceDist
    }
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
    const result = args.compareWith
      ? compare(projectDir, path.resolve(args.compareWith), args.windowDays)
      : computeReuseRate(projectDir, args.windowDays);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`[eval-lesson-reuse] ${err.message}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (__filename === invokedPath) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      process.stderr.write(`[eval-lesson-reuse] ${err.message}\n`);
      process.exit(1);
    });
}
