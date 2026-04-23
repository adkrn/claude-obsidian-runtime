// Golden Task loader.
// Fallback order:
//   1) <projectDir>/.claude/runtime/eval/golden-tasks.json (project-local copy)
//   2) $CLAUDE_RUNTIME_HOME/templates/eval/golden-tasks.json (package template)
//   3) bundled template resolved via import.meta.url (final safety net)
//   4) throw GoldenTasksNotFound
// Spec: DESIGN_C §1-C + §3-A.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REQUIRED_TASK_FIELDS = [
  'id',
  'category',
  'prompt',
  'expectedScope',
  'expectedReadFirstPaths',
  'expectedCodeHitsKeywords',
  'reusability',
  'manualRelevanceScores'
];

export class GoldenTasksNotFound extends Error {
  constructor(searched) {
    super(`Golden tasks file not found. Searched: ${searched.join(', ')}`);
    this.name = 'GoldenTasksNotFound';
    this.searched = searched;
  }
}

export class GoldenTasksSchemaError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'GoldenTasksSchemaError';
    if (details) this.details = details;
  }
}

function readJsonFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return { ok: true, data: JSON.parse(raw) };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { ok: false, missing: true };
    }
    return { ok: false, error: err };
  }
}

function bundledTemplatePath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // core/eval/golden-task-loader.mjs → ../../templates/eval/golden-tasks.json
  return path.resolve(here, '..', '..', 'templates', 'eval', 'golden-tasks.json');
}

function validateTasksDoc(doc, source) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new GoldenTasksSchemaError(`golden tasks doc must be an object (source: ${source})`);
  }
  if (typeof doc.schemaVersion !== 'string' || doc.schemaVersion.length === 0) {
    throw new GoldenTasksSchemaError(`schemaVersion missing or empty (source: ${source})`);
  }
  if (!Array.isArray(doc.tasks)) {
    throw new GoldenTasksSchemaError(`tasks must be an array (source: ${source})`);
  }
  for (let i = 0; i < doc.tasks.length; i += 1) {
    const task = doc.tasks[i];
    if (!task || typeof task !== 'object' || Array.isArray(task)) {
      throw new GoldenTasksSchemaError(`task[${i}] must be an object (source: ${source})`);
    }
    for (const field of REQUIRED_TASK_FIELDS) {
      if (!(field in task)) {
        throw new GoldenTasksSchemaError(
          `task[${i}].${field} missing (source: ${source})`,
          { taskIndex: i, field }
        );
      }
    }
    if (!Array.isArray(task.expectedReadFirstPaths)) {
      throw new GoldenTasksSchemaError(`task[${i}].expectedReadFirstPaths must be array`);
    }
    if (!Array.isArray(task.expectedCodeHitsKeywords)) {
      throw new GoldenTasksSchemaError(`task[${i}].expectedCodeHitsKeywords must be array`);
    }
    if (!task.manualRelevanceScores || typeof task.manualRelevanceScores !== 'object') {
      throw new GoldenTasksSchemaError(`task[${i}].manualRelevanceScores must be object`);
    }
  }
}

export async function loadGoldenTasks({ projectDir, tasksPath } = {}) {
  const searched = [];
  const candidates = [];

  if (typeof tasksPath === 'string' && tasksPath.length > 0) {
    candidates.push(path.resolve(tasksPath));
  }
  if (typeof projectDir === 'string' && projectDir.length > 0) {
    candidates.push(path.join(projectDir, '.claude', 'runtime', 'eval', 'golden-tasks.json'));
  }
  const runtimeHome = process.env.CLAUDE_RUNTIME_HOME;
  if (typeof runtimeHome === 'string' && runtimeHome.length > 0) {
    candidates.push(path.join(runtimeHome, 'templates', 'eval', 'golden-tasks.json'));
  }
  candidates.push(bundledTemplatePath());

  for (const candidate of candidates) {
    searched.push(candidate);
    const result = readJsonFile(candidate);
    if (result.ok) {
      validateTasksDoc(result.data, candidate);
      return {
        schemaVersion: result.data.schemaVersion,
        description: result.data.description || '',
        tasks: result.data.tasks,
        source: candidate
      };
    }
    if (!result.missing) {
      throw result.error;
    }
  }

  throw new GoldenTasksNotFound(searched);
}
