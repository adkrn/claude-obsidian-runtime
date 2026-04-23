/**
 * Shared task-start engine for Obsidian-Claude runtime.
 *
 * Provides createAndStartTask() that handles the common workflow:
 *   1. Parse args & validate
 *   2. Sync Obsidian vault
 *   3. Resolve context
 *   4. Create task record
 *   5. Write files (task, pointer, last-context)
 *   6. Log event
 *
 * Project-specific differences are handled via config callbacks.
 */

import path from 'path';
import {
  appendJsonl,
  createTaskId,
  ensureRuntimeLayout,
  getEventFilePath,
  getRuntimePaths,
  loadCurrentTaskPointer,
  toTaskPointer,
  uniqueStrings,
  writeJsonFile
} from './runtime-lib.mjs';

/**
 * @typedef {object} TaskStartConfig
 * @property {(projectDir: string) => object} syncVault - sync obsidian, return sync result
 * @property {(params: {projectDir, task, limit}) => object} resolveContext - resolve runtime context
 * @property {string} [defaultScope='repo'] - default scope for event log
 * @property {(taskRecord: object, options: object) => object} [enrichTaskRecord] - add project-specific fields
 * @property {(params: object) => void} [afterWrite] - called after file writes (e.g. writeSessionTaskPointer)
 * @property {(params: object) => object} [enrichOutput] - add project-specific output fields
 */

/**
 * Create and start a new runtime task.
 *
 * @param {object} args - Parsed CLI args (task, taskId, sessionId, projectDir, limit, dryRun)
 * @param {TaskStartConfig} config
 * @returns {object} output JSON
 */
export function createAndStartTask(args, config) {
  const projectDir = args.projectDir;
  const now = new Date();
  const createdAt = now.toISOString();
  const dryRun = Boolean(args.dryRun);
  // dry-run: compute paths without creating directories (read-only mode).
  // dry-run: compute paths without creating directories (read-only mode).
  const runtimePaths = dryRun
    ? getRuntimePaths(projectDir)
    : ensureRuntimeLayout(projectDir);
  const previousTask = dryRun ? null : loadCurrentTaskPointer(projectDir);
  const sessionId = args.sessionId || '';

  if (!dryRun && previousTask?.status === 'active' && previousTask?.taskId) {
    process.stderr.write(`[runtime] Warning: overwriting active task ${previousTask.taskId} with new task\n`);
  }

  // 1. Sync Obsidian vault (skip in dry-run)
  const sync = dryRun
    ? { ok: true, skipped: true, message: 'dry-run: obsidian-sync skipped' }
    : config.syncVault(projectDir);

  // 2. Resolve context
  const context = config.resolveContext({
    projectDir,
    task: args.task,
    limit: args.limit
  });

  // 3. Create task record (in-memory only during dry-run)
  const taskId = args.taskId || createTaskId(args.task, now);
  const taskFilePath = path.join(runtimePaths.tasksRoot, `${taskId}.json`);

  let taskRecord = {
    taskId,
    title: args.task,
    prompt: args.task,
    status: 'active',
    source: 'runtime-task-start',
    createdAt,
    updatedAt: createdAt,
    matchedScopes: context.matchedScopes,
    matchedGroups: context.matchedGroups,
    readFirst: context.readFirst,
    knowledgeHits: context.knowledgeHits || [],
    codeHits: context.codeHits,
    guardrails: context.guardrails,
    verificationPlan: [],
    knowledgeFollowUp: {
      architecture: [],
      troubleshooting: [],
      lessons: [],
      decisions: []
    },
    files: [],
    sessionIds: uniqueStrings([sessionId]),
    sync,
    previousTask: previousTask ? {
      taskId: previousTask.taskId || '',
      title: previousTask.title || '',
      status: previousTask.status || ''
    } : null
  };

  // 4. Project-specific enrichment
  if (config.enrichTaskRecord) {
    taskRecord = config.enrichTaskRecord(taskRecord, {
      sessionId,
      createdAt,
      context,
      previousTask
    });
  }

  if (!dryRun) {
    // 5. Write files
    writeJsonFile(taskFilePath, taskRecord);
    writeJsonFile(
      runtimePaths.currentTaskPath,
      toTaskPointer(taskRecord, taskFilePath, runtimePaths.lastContextPath)
    );
    writeJsonFile(runtimePaths.lastContextPath, {
      generatedAt: createdAt,
      taskId,
      sync,
      ...context
    });

    // 6. Project-specific after-write (e.g. session pointer)
    if (config.afterWrite) {
      config.afterWrite({
        projectDir,
        sessionId,
        taskRecord,
        taskFilePath,
        runtimePaths
      });
    }

    // 7. Log event
    const defaultScope = config.defaultScope || 'repo';
    appendJsonl(getEventFilePath(projectDir, now), {
      ts: createdAt,
      taskId,
      eventType: 'task_started',
      scope: context.matchedScopes.join(',') || defaultScope,
      summary: args.task,
      detail: {
        readFirstCount: context.readFirst.length,
        codeHitCount: context.codeHits.length,
        knowledgeHitCount: (context.knowledgeHits || []).length,
        matchedGroups: context.matchedGroups.map((g) => g.id),
        sync: sync.ok ? 'ok' : sync.message
      }
    });
  }

  // 8. Build output — 9 mandatory fields per PATCH_Phase1 §3-B (+ compat extras).
  const normalizeFsPath = (value) => path.resolve(value).replace(/\\/g, '/');
  const output = {
    taskId,
    readFirst: context.readFirst,
    codeHits: context.codeHits,
    knowledgeHits: context.knowledgeHits || [],
    guardrails: context.guardrails,
    matchedScopes: context.matchedScopes,
    matchedGroups: context.matchedGroups,
    currentTaskPath: normalizeFsPath(runtimePaths.currentTaskPath),
    lastContextPath: normalizeFsPath(runtimePaths.lastContextPath),
    // Back-compat fields (existing callers rely on these)
    createdAt,
    taskPath: normalizeFsPath(taskFilePath),
    sync
  };

  if (config.enrichOutput) {
    return config.enrichOutput(output, { context, taskRecord, runtimePaths, dryRun });
  }

  return output;
}
