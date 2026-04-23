// Golden Task runner.
// Spawns `node commands/task-start.mjs --dry-run ...` for a single golden task
// and maps the 9-field JSON (PATCH §3-B) into a GoldenRun record (DESIGN-C §3-B).
//
// Contract highlights:
//   - spawnSync with timeout 30000ms (PATCH §3-D)
//   - dry-run must not touch the filesystem (PATCH §3-C). Snapshot mtime/size
//     of sensitive paths before/after; a mismatch yields `failure`.
//   - single-task failure is recorded in the returned GoldenRun.failure field;
//     it must not block the rest of eval-run (R-C-5, R-C-8).
//   - tokenCount is estimated as ceil(text.length / 4). tiktoken is forbidden
//     (A-C-8 / R-C-6).
//
// Public exports:
//   runGoldenTask(projectDir, task) → Promise<GoldenRun>
//   estimateTokenCount(text) → number
//
// Wave 3 (commands/eval-run.mjs) consumes these signatures verbatim; do not
// change them without coordinating across waves.

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { performance } from 'perf_hooks';

const REQUIRED_OUTPUT_FIELDS = [
  'taskId',
  'readFirst',
  'codeHits',
  'knowledgeHits',
  'guardrails',
  'matchedScopes',
  'matchedGroups',
  'currentTaskPath',
  'lastContextPath'
];

const SNAPSHOT_FILES = [
  '.claude/runtime/current-task.json',
  '.claude/runtime/retrieval/last-context.json'
];

const SNAPSHOT_DIRS = [
  '.claude/runtime/events',
  '.claude/runtime/tasks'
];

export const DEFAULT_TIMEOUT_MS = 30000;

export function estimateTokenCount(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

function statSafe(filePath) {
  try {
    const st = fs.statSync(filePath);
    return { exists: true, mtimeMs: st.mtimeMs, size: st.size };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { exists: false };
    return { exists: false, error: err.message };
  }
}

function listDirSafe(dirPath) {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const full = path.join(dirPath, entry.name);
      const st = statSafe(full);
      files.push({ name: entry.name, full, mtimeMs: st.mtimeMs || 0, size: st.size || 0 });
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    return { exists: true, files };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { exists: false, files: [] };
    return { exists: false, files: [], error: err.message };
  }
}

export function captureFsSnapshot(projectDir) {
  const files = {};
  for (const rel of SNAPSHOT_FILES) {
    files[rel] = statSafe(path.join(projectDir, rel));
  }
  const dirs = {};
  for (const rel of SNAPSHOT_DIRS) {
    dirs[rel] = listDirSafe(path.join(projectDir, rel));
  }
  return { files, dirs };
}

export function compareSnapshots(before, after) {
  const changes = [];
  for (const rel of SNAPSHOT_FILES) {
    const b = before.files[rel] || { exists: false };
    const a = after.files[rel] || { exists: false };
    if (b.exists !== a.exists) {
      changes.push({ path: rel, reason: b.exists ? 'deleted' : 'created' });
      continue;
    }
    if (!b.exists) continue;
    if (b.mtimeMs !== a.mtimeMs || b.size !== a.size) {
      changes.push({ path: rel, reason: 'modified' });
    }
  }
  for (const rel of SNAPSHOT_DIRS) {
    const b = before.dirs[rel] || { files: [] };
    const a = after.dirs[rel] || { files: [] };
    const beforeMap = new Map(b.files.map((f) => [f.name, f]));
    const afterMap = new Map(a.files.map((f) => [f.name, f]));
    for (const [name, af] of afterMap) {
      const bf = beforeMap.get(name);
      if (!bf) {
        changes.push({ path: `${rel}/${name}`, reason: 'created' });
        continue;
      }
      if (bf.mtimeMs !== af.mtimeMs || bf.size !== af.size) {
        changes.push({ path: `${rel}/${name}`, reason: 'modified' });
      }
    }
    for (const [name] of beforeMap) {
      if (!afterMap.has(name)) {
        changes.push({ path: `${rel}/${name}`, reason: 'deleted' });
      }
    }
  }
  return changes;
}

function resolveTaskStartPath() {
  if (process.env.CLAUDE_RUNTIME_HOME) {
    const envPath = path.join(process.env.CLAUDE_RUNTIME_HOME, 'commands', 'task-start.mjs');
    if (fs.existsSync(envPath)) return envPath;
  }
  // core/eval/golden-task-runner.mjs → ../../commands/task-start.mjs
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'commands', 'task-start.mjs');
}

function emptyGoldenRun(task, failure) {
  return {
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
    failure
  };
}

function pickLastJsonLine(stdout) {
  if (typeof stdout !== 'string' || stdout.length === 0) return null;
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  return lines[lines.length - 1];
}

export async function runGoldenTask(projectDir, task, options = {}) {
  if (!projectDir || typeof projectDir !== 'string') {
    throw new TypeError('runGoldenTask: projectDir must be a non-empty string');
  }
  if (!task || typeof task !== 'object' || typeof task.id !== 'string') {
    throw new TypeError('runGoldenTask: task must be a GoldenTaskDef with string id');
  }

  const timeout = Number.isFinite(options.timeout) ? options.timeout : DEFAULT_TIMEOUT_MS;
  const taskStartPath = options.taskStartPath || resolveTaskStartPath();
  const nodeBin = options.nodeBin || process.execPath;
  const sessionId = `eval-${task.id}-${Date.now()}`;

  if (!fs.existsSync(taskStartPath)) {
    return emptyGoldenRun(task, {
      message: `task-start.mjs not found at ${taskStartPath}`
    });
  }

  const before = captureFsSnapshot(projectDir);
  const startTs = performance.now();
  let result;
  try {
    result = spawnSync(
      nodeBin,
      [
        taskStartPath,
        '--dry-run',
        '--task', task.prompt,
        '--project-dir', projectDir,
        '--session-id', sessionId
      ],
      { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 }
    );
  } catch (err) {
    return emptyGoldenRun(task, { message: `spawn error: ${err.message}` });
  }
  const wallTimeMs = performance.now() - startTs;

  if (result.error && result.error.code === 'ETIMEDOUT') {
    return {
      ...emptyGoldenRun(task, { message: `timeout after ${timeout}ms` }),
      wallTimeMs
    };
  }
  // Node may surface a killed signal (SIGTERM) on timeout instead of error.code.
  if (result.signal === 'SIGTERM' && wallTimeMs >= timeout - 50) {
    return {
      ...emptyGoldenRun(task, { message: `timeout after ${timeout}ms` }),
      wallTimeMs
    };
  }

  if (result.error) {
    return {
      ...emptyGoldenRun(task, { message: `spawn error: ${result.error.message}` }),
      wallTimeMs
    };
  }

  const after = captureFsSnapshot(projectDir);
  const changes = compareSnapshots(before, after);
  if (changes.length > 0) {
    return {
      ...emptyGoldenRun(task, {
        message: 'spawn violated dry-run skip-list',
        detail: { modifiedFiles: changes }
      }),
      wallTimeMs
    };
  }

  if (result.status !== 0) {
    return {
      ...emptyGoldenRun(task, {
        message: `task-start exited with code ${result.status}`,
        stderr: (result.stderr || '').toString().slice(0, 2000)
      }),
      wallTimeMs
    };
  }

  const lastLine = pickLastJsonLine(result.stdout);
  if (!lastLine) {
    return {
      ...emptyGoldenRun(task, {
        message: 'task-start stdout empty',
        stderr: (result.stderr || '').toString().slice(0, 2000)
      }),
      wallTimeMs
    };
  }

  let json;
  try {
    json = JSON.parse(lastLine);
  } catch (err) {
    return {
      ...emptyGoldenRun(task, {
        message: `stdout not parseable JSON: ${err.message}`,
        stderr: (result.stderr || '').toString().slice(0, 2000)
      }),
      wallTimeMs
    };
  }

  const missing = REQUIRED_OUTPUT_FIELDS.filter((k) => !(k in json));
  if (missing.length > 0) {
    return {
      ...emptyGoldenRun(task, {
        message: `task-start output missing required fields: ${missing.join(',')}`
      }),
      wallTimeMs
    };
  }

  const readFirst = Array.isArray(json.readFirst) ? json.readFirst : [];
  const codeHits = Array.isArray(json.codeHits) ? json.codeHits : [];
  const knowledgeHits = Array.isArray(json.knowledgeHits) ? json.knowledgeHits : [];
  const guardrails = Array.isArray(json.guardrails) ? json.guardrails : [];
  const matchedScopes = Array.isArray(json.matchedScopes) ? json.matchedScopes : [];
  const matchedGroups = Array.isArray(json.matchedGroups) ? json.matchedGroups : [];

  const rawSchemaKeys = REQUIRED_OUTPUT_FIELDS.filter((k) => k in json).sort();

  return {
    taskId: task.id,
    prompt: task.prompt,
    expectedScope: task.expectedScope,
    actualScopes: matchedScopes,
    readFirstCount: readFirst.length,
    readFirstPaths: readFirst.map((r) => (r && typeof r.path === 'string' ? r.path : '')),
    codeHitsCount: codeHits.length,
    codeHitsPaths: codeHits.map((c) => (c && typeof c.path === 'string' ? c.path : '')),
    knowledgeHitsCount: knowledgeHits.length,
    guardrailsCount: guardrails.length,
    matchedGroupsIds: matchedGroups.map((g) => (g && typeof g.id === 'string' ? g.id : '')),
    wallTimeMs,
    tokenCount: estimateTokenCount(JSON.stringify(json)),
    rawSchemaKeys,
    failure: null
  };
}
