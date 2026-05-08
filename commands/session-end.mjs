#!/usr/bin/env node

/**
 * SessionEnd / TaskClose hook handler.
 *
 * Orchestrates end-of-session pipeline:
 *   1. Curate task knowledge (lessons/troubleshooting/decisions) via shared engine
 *   2. Detect architecture changes and write pending docs
 *   3. Promote pending architecture docs when thresholds met
 *   4. Flush hit counts (writes current hit-counts.json)
 *   5. Rotate stale event logs
 *   6. Update task record status
 *   7. Log session_ended / task_closed event
 *
 * Configuration is sourced from .claude/runtime-manifest.json:
 *   - scopeFolderMap: { "<scope>": "<FolderName>" }
 *   - projectTag: string
 *   - defaultScope: string (fallback scope)
 *   - surfacePatterns: string[] (path segments that indicate architecture surfaces)
 *   - architecturePromoteThreshold: number (default 3)
 *
 * Worklog generation (if --close) is delegated to project-local worklog-generate.mjs
 * if present; otherwise skipped without error.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { loadObsidianConfig } from '../core/obsidian-config.mjs';
import { syncManagedRoots } from '../core/obsidian-sync.mjs';
import { buildReflectionDraft, curateTaskKnowledge } from '../core/learning-curate.mjs';
import {
  parseSessionEndArgs,
  rotateStaleEventLogs
} from '../core/session-end-engine.mjs';
import {
  appendJsonl,
  clearCurrentTaskPointer,
  clearSessionTaskPointer,
  ensureRuntimeLayout,
  findTaskBySessionId,
  getEventFilePath,
  getRuntimePaths,
  loadCurrentTaskPointer,
  loadJsonl,
  loadSessionTaskPointer,
  writeJsonFile,
  writeJsonlFile
} from '../core/runtime-lib.mjs';
import { loadJson, normalizePath, sanitizeSlug, writeVaultArtifact } from '../core/utils.mjs';
import {
  buildContext as buildDoctorContext,
  runChecks as runDoctorChecks
} from './doctor.mjs';
import {
  buildReflectionInput,
  deriveWorklogStatus,
  evaluateVerifyResult,
  formatUnverifiedBadge,
  formatUnverifiedNotify,
  prependUnverifiedBadge,
  reflectionDraftRelativePath,
  resolveVerifyOptions
} from '../core/task-close-verify.mjs';
import { carryOverAndReset } from '../core/todo-writer.mjs';

function writeToVault(projectDir, relativePath, content, config) {
  return writeVaultArtifact({
    projectDir,
    vaultRoot: config?.vaultRoot || '',
    relativePath,
    content,
    queueRoot: 'document/obsidian_writeback_queue'
  });
}

function loadManifest(projectDir) {
  const p = path.join(projectDir, '.claude', 'runtime-manifest.json');
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

function buildInferScope(manifest) {
  const scopeMap = manifest.scopeFolderMap || {};
  const defaultScope = manifest.defaultScope || 'repo';
  if (!scopeMap || Object.keys(scopeMap).length === 0) {
    return () => defaultScope;
  }
  return (filePath) => {
    const p = String(filePath || '').replace(/\\/g, '/');
    for (const [folder, scope] of Object.entries(scopeMap)) {
      if (p.includes(folder)) return scope;
    }
    return defaultScope;
  };
}

function detectArchitectureChanges(projectDir, taskRecord, surfacePatterns) {
  const runtimePaths = getRuntimePaths(projectDir);
  const surfacesPath = path.join(runtimePaths.architectureRoot, 'detected-surfaces.jsonl');
  const pendingPath = path.join(runtimePaths.architectureRoot, 'pending-docs.jsonl');

  const files = (taskRecord.files || []).length > 0
    ? taskRecord.files
    : (taskRecord.codeHits || []).map((h) => h.path);

  const defaultPatterns = [
    { pattern: 'stores/', type: 'store' },
    { pattern: 'types/', type: 'type' },
    { pattern: 'components/', type: 'component' },
    { pattern: 'lib/', type: 'module' },
    { pattern: 'app/', type: 'page' },
    { pattern: 'routes/', type: 'route' },
    { pattern: 'controllers/', type: 'controller' },
    { pattern: 'services/', type: 'service' }
  ];

  const patterns = Array.isArray(surfacePatterns) && surfacePatterns.length > 0
    ? surfacePatterns.map((p) => {
        const clean = p.replace(/^\//, '').replace(/\/$/, '/');
        return { pattern: clean.endsWith('/') ? clean : `${clean}/`, type: clean.replace(/\/$/, '') };
      })
    : defaultPatterns;

  const detected = [];
  for (const filePath of files) {
    const normalized = normalizePath(filePath).toLowerCase();
    for (const { pattern, type } of patterns) {
      if (normalized.includes(pattern)) {
        detected.push({
          path: normalizePath(filePath),
          surfaceType: type,
          taskId: taskRecord.taskId,
          detectedAt: new Date().toISOString()
        });
        break;
      }
    }
  }

  for (const entry of detected) appendJsonl(surfacesPath, entry);

  if (detected.length >= 2) {
    appendJsonl(pendingPath, {
      id: `pending-${taskRecord.taskId}`,
      title: `Architecture changes from: ${taskRecord.title || taskRecord.taskId}`,
      summary: `${detected.length} surface changes detected: ${detected.map((d) => d.surfaceType).join(', ')}`,
      surfaces: detected.map((d) => d.path),
      recommendPromotion: detected.length >= 3,
      promoted: false,
      generated: false,
      createdAt: new Date().toISOString()
    });
  }
  return detected;
}

function promotePendingDocs(projectDir, obsidianConfig) {
  const runtimePaths = getRuntimePaths(projectDir);
  const pendingPath = path.join(runtimePaths.architectureRoot, 'pending-docs.jsonl');
  const pendingDocs = loadJsonl(pendingPath);
  const promoted = [];

  for (const doc of pendingDocs) {
    if (!doc.recommendPromotion || doc.promoted) continue;
    const content = [
      `# ${doc.title}`, '',
      `**Generated:** ${new Date().toISOString()}`,
      `**Task:** ${doc.id}`, '',
      '## Summary', '', doc.summary, '',
      '## Affected Surfaces', '',
      ...(doc.surfaces || []).map((s) => `- \`${s}\``), ''
    ].join('\n');

    const fileName = `${sanitizeSlug(doc.title, 'arch-change')}.md`;
    const relativePath = `04_Architecture/Generated/${fileName}`;
    const result = writeToVault(projectDir, relativePath, content, obsidianConfig);
    if (result.storage === 'vault' || result.storage === 'queue') {
      doc.promoted = true;
      doc.generated = true;
      doc.promotedAt = new Date().toISOString();
      promoted.push(doc.id);
    }
  }
  if (promoted.length > 0) writeJsonlFile(pendingPath, pendingDocs);
  return promoted;
}

function flushHitCounts(projectDir) {
  const runtimePaths = getRuntimePaths(projectDir);
  const hitCountsPath = path.join(runtimePaths.knowledgeRoot, 'hit-counts.json');
  const hitCounts = loadJson(hitCountsPath, {});
  writeJsonFile(hitCountsPath, hitCounts);
  return hitCounts;
}

function estimateContextTokens(taskRecord) {
  if (!taskRecord) return 0;
  return (taskRecord.readFirst || []).length * 500
    + (taskRecord.codeHits || []).length * 200
    + (taskRecord.knowledgeHits || []).length * 150
    + (taskRecord.guardrails || []).length * 20;
}

async function tryGenerateWorklog(projectDir, params) {
  const candidates = [
    path.join(projectDir, 'scripts', 'runtime', 'worklog-generate.mjs'),
    path.join(projectDir, '.claude', 'runtime', 'scripts', 'worklog-generate.mjs')
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const mod = await import(pathToFileURL(candidate).href);
      if (typeof mod.generateTaskWorklog === 'function') {
        return mod.generateTaskWorklog(projectDir, params);
      }
    } catch (err) {
      process.stderr.write(`[session-end] worklog-generate import failed: ${err.message}\n`);
    }
  }
  return null;
}

async function tryCalculateTaskUsage(projectDir, params) {
  try {
    const mod = await import(pathToFileURL(path.join(fileURLToPath(import.meta.url), '..', 'task-usage.mjs')).href);
    if (typeof mod.calculateTaskUsage === 'function') {
      return mod.calculateTaskUsage(projectDir, params);
    }
  } catch { /* optional */ }
  return null;
}

async function main() {
  const args = parseSessionEndArgs(process.argv.slice(2));
  const projectDir = path.resolve(args.projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const manifest = loadManifest(projectDir);
  const runtimePaths = ensureRuntimeLayout(projectDir);
  const now = new Date();
  const sessionId = args.sessionId || '';
  const defaultScope = manifest.defaultScope || 'repo';

  // Resolution order, strictest → loosest:
  //   1) per-session pointer (current-task-<sessionId>.json) — strongest signal
  //      that this task belongs to this session.
  //   2) findTaskBySessionId — task record explicitly lists this sessionId.
  //   3) global pointer — only if the task was originated by this session
  //      (sessionIds[0] === sessionId). Without this guard, an unrelated
  //      session can close another session's active task.
  let taskRecord = null;
  let resolvedTaskPath = '';

  if (sessionId) {
    const sessionPointer = loadSessionTaskPointer(projectDir, sessionId);
    if (sessionPointer?.taskPath) {
      const candidate = loadJson(path.resolve(sessionPointer.taskPath), null);
      if (candidate) {
        taskRecord = candidate;
        resolvedTaskPath = path.resolve(sessionPointer.taskPath);
      }
    }
  }

  if (!taskRecord && sessionId) {
    const found = findTaskBySessionId(projectDir, sessionId);
    if (found) { taskRecord = found.task; resolvedTaskPath = path.resolve(found.taskPath); }
  }

  const globalPointer = loadCurrentTaskPointer(projectDir);
  if (!taskRecord && globalPointer?.taskPath) {
    const candidate = loadJson(path.resolve(globalPointer.taskPath), null);
    const ownerSession = Array.isArray(candidate?.sessionIds) ? candidate.sessionIds[0] : '';
    const ownsTask = !sessionId || !ownerSession || ownerSession === sessionId;
    if (candidate && ownsTask) {
      taskRecord = candidate;
      resolvedTaskPath = path.resolve(globalPointer.taskPath);
    }
  }

  if (!taskRecord) {
    appendJsonl(getEventFilePath(projectDir, now), {
      ts: now.toISOString(),
      taskId: '',
      eventType: 'session_ended',
      scope: defaultScope,
      summary: 'session ended without active task',
      detail: { sessionId }
    });
    process.stdout.write(JSON.stringify({ ok: true, message: 'no active task' }) + '\n');
    return;
  }

  const obsidianConfig = loadObsidianConfig(projectDir);
  const inferScope = buildInferScope(manifest);

  const curationResult = curateTaskKnowledge(projectDir, {
    taskId: taskRecord.taskId,
    publish: true
  }, {
    loadObsidianConfig: () => obsidianConfig,
    writeVaultArtifact: (params) => writeToVault(projectDir, params.relativePath, params.content),
    projectTag: manifest.projectTag || 'project',
    scopeFolderMap: manifest.scopeFolderMap || {},
    inferScope
  });
  const newLessons = curationResult.ok ? curationResult.artifacts : [];

  const archChanges = detectArchitectureChanges(projectDir, taskRecord, manifest.surfacePatterns);
  const promotedDocs = promotePendingDocs(projectDir, obsidianConfig);
  const hitCounts = flushHitCounts(projectDir);
  rotateStaleEventLogs(projectDir);

  let worklogResult = null;
  let tokenUsage = null;
  let verifyOutcome = null;
  if (args.close) {
    // DESIGN_MANUS_4A §6 — verify gate (default ON, --no-verify skip).
    const verifyOpts = resolveVerifyOptions(args);
    if (verifyOpts.enabled && verifyOpts.invalidIds.length > 0) {
      // §6-C — invalid check id → exit 1 with error, no worklog.
      process.stderr.write(
        `[session-end] unknown check id: ${verifyOpts.invalidIds.join(',')}\n`
      );
      process.exit(1);
    }

    if (verifyOpts.enabled) {
      const doctorCtx = buildDoctorContext({ projectDir });
      const checks = await runDoctorChecks(verifyOpts.checkIds, doctorCtx);
      const evaluation = evaluateVerifyResult(checks);
      verifyOutcome = {
        unverified: evaluation.unverified,
        failedChecks: evaluation.failedChecks,
        warnedChecks: evaluation.warnedChecks,
        rawCheckResults: evaluation.rawCheckResults,
        reflectionDraftPath: '',
        notify: '',
        status: deriveWorklogStatus({ failedChecks: evaluation.failedChecks })
      };

      if (evaluation.unverified) {
        // §5-B — synthesize input + invoke E §8 SSOT (algorithm not redefined).
        const reflectionInput = buildReflectionInput({
          task: taskRecord,
          failedChecks: evaluation.failedChecks,
          rawCheckResults: evaluation.rawCheckResults
        });
        const draft = buildReflectionDraft(reflectionInput);
        if (draft) {
          const relativePath = reflectionDraftRelativePath(taskRecord.taskId, now);
          const draftBody = [
            `# ${draft.title}`,
            '',
            `**Task:** ${draft.related_task}`,
            `**Scope:** ${draft.scope}`,
            `**Status:** ${draft.status}`,
            `**Confidence of fix:** ${draft.confidence_of_fix}`,
            '',
            '## Summary',
            '',
            draft.verbal_summary || draft.summary,
            '',
            '## Failed Checks',
            '',
            ...evaluation.failedChecks.map((id) => `- ${id}`),
            '',
            '## Related Failures',
            '',
            ...(draft.related_failures || []).map((s) => `- ${s}`)
          ].join('\n');
          const writeResult = writeVaultArtifact({
            projectDir,
            vaultRoot: obsidianConfig?.vaultRoot || '',
            relativePath,
            content: draftBody,
            queueRoot: 'document/obsidian_writeback_queue'
          });
          if (writeResult.storage === 'vault' || writeResult.storage === 'queue') {
            verifyOutcome.reflectionDraftPath = relativePath;
          }
        }
        // §5-A [NOTIFY] alert text — emitted on stderr so it does not corrupt
        // the JSON stdout payload that callers parse.
        verifyOutcome.notify = formatUnverifiedNotify({
          failedChecks: evaluation.failedChecks,
          reflectionDraftPath: verifyOutcome.reflectionDraftPath
        });
        process.stderr.write(`${verifyOutcome.notify}\n`);
      }
    }

    const usage = await tryCalculateTaskUsage(projectDir, { taskId: taskRecord.taskId, sessionId, closedAt: now.toISOString() });
    if (usage?.ok) tokenUsage = usage.usage;
    worklogResult = await tryGenerateWorklog(projectDir, {
      taskId: taskRecord.taskId,
      sessionId,
      hookEventName: 'TaskClose',
      usage: usage?.ok ? usage.usage : null,
      curation: {
        knowledgeFollowUp: taskRecord.knowledgeFollowUp || {},
        lessons: newLessons
      },
      verify: verifyOutcome
    });

    // DESIGN_MANUS_AG §6-C — carry-over unfinished todo items onto the
    // worklog and reset Current_Todo.md to the no-active-task body. Runs
    // even when verify fails (worklog still produced). Silent on no-vault.
    try {
      const vaultRoot = obsidianConfig?.vaultAvailable ? obsidianConfig.vaultRoot : '';
      const worklogPath = worklogResult?.worklog?.path || '';
      carryOverAndReset(projectDir, vaultRoot, taskRecord, worklogPath);
    } catch { /* non-critical */ }

    // §5-A — prepend unverified badge to whatever worklog markdown the
    // project-local generator returned. Done here (shared layer) so
    // project-local worklog-generate.mjs needs no awareness of the verify
    // gate. If the generator returned no markdown we still emit the alert.
    if (verifyOutcome?.unverified && worklogResult?.worklog?.markdown) {
      const badge = formatUnverifiedBadge({
        failedChecks: verifyOutcome.failedChecks,
        reflectionDraftPath: verifyOutcome.reflectionDraftPath
      });
      worklogResult.worklog.markdown = prependUnverifiedBadge(
        worklogResult.worklog.markdown,
        badge
      );
      worklogResult.worklog.status = verifyOutcome.status;
      // If the generator already wrote the file, rewrite with the badge.
      if (worklogResult.worklog.path) {
        try {
          fs.writeFileSync(worklogResult.worklog.path, worklogResult.worklog.markdown, 'utf8');
        } catch (err) {
          process.stderr.write(`[session-end] worklog badge write failed: ${err.message}\n`);
        }
      }
    }
  }

  const finalStatus = args.close ? 'completed' : taskRecord.status || 'active';
  taskRecord.status = finalStatus;
  taskRecord.updatedAt = now.toISOString();
  if (args.close) taskRecord.completedAt = now.toISOString();
  if (resolvedTaskPath && fs.existsSync(resolvedTaskPath)) {
    writeJsonFile(resolvedTaskPath, taskRecord);
  }

  // Only touch the global current-task pointer when it actually points at
  // the task we just resolved. Otherwise we'd clobber another session's
  // active task pointer.
  const globalTargetsThisTask = globalPointer?.taskId === taskRecord.taskId;

  if (args.close) {
    if (globalTargetsThisTask) {
      clearCurrentTaskPointer(projectDir, taskRecord.taskId);
    }
    if (sessionId) {
      clearSessionTaskPointer(projectDir, sessionId, taskRecord.taskId);
    }
  } else if (globalTargetsThisTask) {
    writeJsonFile(runtimePaths.currentTaskPath, {
      taskId: taskRecord.taskId,
      status: finalStatus,
      title: taskRecord.title || '',
      taskPath: normalizePath(resolvedTaskPath),
      updatedAt: now.toISOString()
    });
  }

  const pendingEventType = args.close ? 'task_closed' : 'session_ended';
  appendJsonl(getEventFilePath(projectDir, now), {
    ts: now.toISOString(),
    taskId: taskRecord.taskId,
    eventType: pendingEventType,
    scope: (taskRecord.matchedScopes || []).join(',') || defaultScope,
    summary: args.close ? `task closed: ${taskRecord.title || taskRecord.taskId}` : `session ended: ${taskRecord.title || taskRecord.taskId}`,
    detail: {
      sessionId,
      lessonsCreated: newLessons.length,
      lessonsDuplicate: newLessons.filter((l) => l.duplicateOf).length,
      vaultWrites: newLessons.filter((l) => l.result?.storage === 'vault').length,
      archChanges: archChanges.length,
      promotedDocs: promotedDocs.length,
      totalHitEntries: Object.keys(hitCounts).length,
      durationMs: taskRecord.createdAt ? now.getTime() - new Date(taskRecord.createdAt).getTime() : null,
      eventCount: loadJsonl(getEventFilePath(projectDir, now)).length,
      contextTokenEstimate: estimateContextTokens(taskRecord)
    }
  });

  if (args.close) {
    try { syncManagedRoots(projectDir, obsidianConfig); } catch { /* non-critical */ }
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    taskId: taskRecord.taskId,
    lessonsCreated: newLessons.length,
    vaultWrites: newLessons.filter((l) => l.result?.storage === 'vault').length,
    archChanges: archChanges.length,
    promotedDocs: promotedDocs.length,
    hitCountEntries: Object.keys(hitCounts).length,
    worklog: worklogResult?.ok ? worklogResult.worklog : null,
    tokenUsage
  }, null, 2) + '\n');
}

const currentFilePath = fileURLToPath(import.meta.url);
const invokedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (currentFilePath === invokedFilePath) {
  main().catch((err) => { process.stderr.write(`[session-end] ${err.message}\n`); process.exit(1); });
}
