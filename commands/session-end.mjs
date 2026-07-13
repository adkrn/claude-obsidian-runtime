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
 * Worklog generation (if --close) is performed inline using the shared
 * buildHandoffWorklog engine and written to <vaultRoot>/10_Worklogs/Auto/
 * via writeVaultArtifact (vault → queue fallback). Always produced on close.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { loadObsidianConfig } from '../core/obsidian-config.mjs';
import { syncManagedRoots } from '../core/obsidian-sync.mjs';
import { buildReflectionDraft, curateTaskKnowledge } from '../core/learning-curate.mjs';
import { isBoilerplateGuardrail } from '../core/context-resolver.mjs';
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
  loadTaskRecord,
  writeJsonFile,
  writeJsonlFile
} from '../core/runtime-lib.mjs';
import { loadJson, normalizePath, sanitizeSlug, toDateStamp, writeVaultArtifact } from '../core/utils.mjs';
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

const KNOWLEDGE_KIND_FILES = [
  ['lesson', 'lessons.jsonl'],
  ['decision', 'decisions.jsonl'],
  ['troubleshooting', 'troubleshooting.jsonl'],
  ['architecture', 'architecture.jsonl']
];

// D-23/D-25 이후 lesson/decision/troubleshooting/architecture 는 세션 Claude 가
// learn-write 계열 CLI 로 session-end 이전에 저장한다. curation 결과만 세면 close
// 지표가 항상 0 — knowledge index 에서 이 task 의 행을 직접 세어 집계한다.
function countTaskArtifacts(projectDir, taskId) {
  const knowledgeRoot = getRuntimePaths(projectDir).knowledgeRoot;
  const counts = { lesson: 0, decision: 0, troubleshooting: 0, architecture: 0 };
  let vaultWrites = 0;
  for (const [kind, file] of KNOWLEDGE_KIND_FILES) {
    for (const row of loadJsonl(path.join(knowledgeRoot, file))) {
      if (!row || row.sourceTaskId !== taskId) continue;
      counts[kind] += 1;
      if (row.storage === 'vault') vaultWrites += 1;
    }
  }
  return { counts, vaultWrites };
}

const EVENT_FILE_REGEX = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

// 이 task 의 이벤트만 센다. task 생성일 이후의 날짜별 이벤트 파일만 스캔.
// (이전 구현은 당일 이벤트 파일의 전체 라인 수를 기록하는 버그였다.)
function countTaskEvents(projectDir, taskId, createdAtIso) {
  const eventsRoot = getRuntimePaths(projectDir).eventsRoot;
  const sinceStamp = String(createdAtIso || '').slice(0, 10);
  let files;
  try { files = fs.readdirSync(eventsRoot); } catch { return 0; }
  let count = 0;
  for (const name of files) {
    const m = name.match(EVENT_FILE_REGEX);
    if (!m) continue;
    if (sinceStamp && m[1] < sinceStamp) continue;
    for (const row of loadJsonl(path.join(eventsRoot, name))) {
      if (row?.taskId === taskId) count += 1;
    }
  }
  return count;
}

function truncate(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function buildSection1Items(taskRecord) {
  const items = [];
  for (const f of taskRecord.files || []) {
    const path = typeof f === 'string' ? f : f?.path;
    if (path) items.push(`changed: ${path}`);
  }
  for (const h of taskRecord.knowledgeHits || []) {
    const title = truncate(h?.title || h?.id || '', 80);
    if (title) items.push(`참고: ${title}`);
  }
  for (const r of taskRecord.readFirst || []) {
    const p = typeof r === 'string' ? r : r?.path;
    if (p) items.push(`읽음: ${p}`);
  }
  return items;
}

function buildSection4Lines(taskRecord) {
  const lines = [];
  const scopes = taskRecord.matchedScopes || [];
  if (scopes.length > 0) lines.push(`matched scopes: ${scopes.join(', ')}`);
  const prev = taskRecord.previousTask;
  if (prev?.taskId) {
    lines.push(`이어받은 task: ${prev.taskId} — ${truncate(prev.title || '', 60)}`);
  }
  return lines;
}

function formatBulletList(items, fallback) {
  if (!items || items.length === 0) return `- ${fallback}`;
  return items.map((s) => `- ${s}`).join('\n');
}

function generateWorklogInline(projectDir, taskRecord, obsidianConfig, params, now) {
  const title = truncate(taskRecord.title || taskRecord.prompt || taskRecord.taskId, 80);
  const section1Items = buildSection1Items(taskRecord);
  for (const v of taskRecord.verifications || []) {
    section1Items.push(`verification: ${v.success ? 'pass' : 'fail'} \`${v.command || ''}\``);
  }
  const section4Lines = buildSection4Lines(taskRecord);
  const oneLiner = truncate(taskRecord.prompt || taskRecord.title || '', 100) || `next session entry: ${title}`;

  const handoffMarkdown = [
    `# Worklog — ${title}`,
    '',
    '## 이번 세션에서 한 일',
    formatBulletList(section1Items, '변경 사항 없음'),
    '',
    '## 남은 일 (다음 세션 먼저 할 것)',
    formatBulletList([], '남은 AC 없음'),
    '',
    '## 건드리면 안 되는 것',
    formatBulletList((taskRecord.guardrails || []).filter((g) => !isBoilerplateGuardrail(g)), '특이사항 없음'),
    '',
    '## 핵심 가정 (깨지면 재설계)',
    formatBulletList(section4Lines, '기록 없음'),
    '',
    '## 한 줄 메모',
    `"${oneLiner.replace(/"/g, '\\"')}"`,
    ''
  ].join('\n');

  const date = toDateStamp(now);
  const frontmatterLines = [
    '---',
    'type: worklog',
    `taskId: ${taskRecord.taskId}`,
    `sessionId: ${params.sessionId || ''}`,
    `hookEventName: ${params.hookEventName || 'TaskClose'}`,
    `date: ${date}`,
    `modifiedFileCount: ${(taskRecord.files || []).length}`,
    `failureCount: ${(taskRecord.verifications || []).filter((v) => v && v.success === false).length}`,
    `scopes: [${(taskRecord.matchedScopes || []).join(', ')}]`,
    '---',
    ''
  ];
  const markdown = frontmatterLines.join('\n') + handoffMarkdown;

  const slug = sanitizeSlug(taskRecord.taskId, 'worklog');
  const relativePath = `10_Worklogs/Auto/${date}_${slug}.md`;
  const writeResult = writeVaultArtifact({
    projectDir,
    vaultRoot: obsidianConfig?.vaultRoot || '',
    relativePath,
    content: markdown,
    queueRoot: 'document/obsidian_writeback_queue'
  });

  return {
    ok: true,
    worklog: {
      path: writeResult.path || '',
      relativePath,
      storage: writeResult.storage,
      markdown,
      status: 'ok'
    }
  };
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

export async function main(argv = process.argv.slice(2)) {
  const args = parseSessionEndArgs(argv);
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

  // PRINCIPLES §12-10 fix — race 차단:
  // session pointer 만 신뢰. 글로벌 pointer fallback 제거.
  // session pointer 의 taskPath 는 반드시 현재 projectDir 내부여야 함 (cross-project stale 차단).
  const resolvedProjectDir = path.resolve(projectDir);
  function isPathInsideProject(p) {
    if (!p) return false;
    const abs = path.resolve(p);
    const rel = path.relative(resolvedProjectDir, abs);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  if (sessionId) {
    const sessionPointer = loadSessionTaskPointer(projectDir, sessionId);
    if (sessionPointer?.taskPath) {
      if (isPathInsideProject(sessionPointer.taskPath)) {
        const candidate = loadJson(path.resolve(sessionPointer.taskPath), null);
        if (candidate) {
          // sessionId 가 task 의 sessionIds 에 있는지 확인 — 진짜 소유권 검증
          const ownerList = Array.isArray(candidate.sessionIds) ? candidate.sessionIds : [];
          if (ownerList.length === 0 || ownerList.includes(sessionId)) {
            taskRecord = candidate;
            resolvedTaskPath = path.resolve(sessionPointer.taskPath);
          }
        }
      }
      // taskPath 가 다른 프로젝트 가리키면 stale — 조용히 무시 (오래된 복사 흔적)
    }
  }

  if (!taskRecord && sessionId) {
    const found = findTaskBySessionId(projectDir, sessionId);
    if (found) { taskRecord = found.task; resolvedTaskPath = path.resolve(found.taskPath); }
  }

  // --task-id 명시 경로 (D-24 후속): hook 쉘이 CLAUDE_SESSION_ID 를 안 주입해 task 가
  // fallback 세션에 묶인 경우, session-id 로는 못 닫는다. 사용자가 task-id 를 명시하면
  // 그 task 를 직접 닫되, race 안전을 위해 (1) 현재 프로젝트 내부 task 이고 (2) status 가
  // 아직 닫히지 않았을 때만 허용한다(D-18 글로벌 pointer race 방어는 불변).
  if (!taskRecord && String(args.taskId || '').trim()) {
    const loaded = loadTaskRecord(projectDir, args.taskId.trim());
    if (loaded?.task && isPathInsideProject(loaded.taskPath)) {
      const status = String(loaded.task.status || '').toLowerCase();
      if (status !== 'closed' && status !== 'archived') {
        taskRecord = loaded.task;
        resolvedTaskPath = path.resolve(loaded.taskPath);
      }
    }
  }

  // 글로벌 pointer fallback 제거. session/task-id 둘 다 비면 "no active task" 로 명시 종료.
  // 이전 동작은 다른 세션이 진행중인 task 를 잘못 닫는 race 의 주원인.
  // 빈 sessionId 의 no-task 이벤트는 기록하지 않는다 — SessionEnd hook 다중 발화로
  // 동일 이벤트가 수십 ms 안에 십수 건 쌓이는 실측 노이즈(식별 정보 0). stdout 응답은 유지.
  const globalPointer = loadCurrentTaskPointer(projectDir);
  if (!taskRecord) {
    if (sessionId && globalPointer?.taskId) {
      appendJsonl(getEventFilePath(projectDir, now), {
        ts: now.toISOString(),
        taskId: '',
        eventType: 'session_end_skipped',
        scope: defaultScope,
        summary: 'session-end refused to close global-pointer task (race protection)',
        detail: {
          sessionId,
          globalTaskId: globalPointer.taskId,
          reason: 'no session-owned task; refusing to close another session\'s task'
        }
      });
    }
    if (sessionId) {
      appendJsonl(getEventFilePath(projectDir, now), {
        ts: now.toISOString(),
        taskId: '',
        eventType: 'session_ended',
        scope: defaultScope,
        summary: 'session ended without active task',
        detail: { sessionId }
      });
    }
    process.stdout.write(JSON.stringify({ ok: true, message: 'no active task' }) + '\n');
    return;
  }

  // 중복 close 가드 — 이미 완료된 task 를 다시 닫으면 task_closed 이벤트와 worklog 가
  // 이중 생성된다(CardGame 실측 2건, 10~13초 간격 재실행). 포인터 정리만 하고 종료.
  const priorStatus = String(taskRecord.status || '').toLowerCase();
  if (args.close && ['completed', 'closed', 'archived'].includes(priorStatus)) {
    if (globalPointer?.taskId === taskRecord.taskId) {
      clearCurrentTaskPointer(projectDir, taskRecord.taskId);
    }
    if (sessionId) clearSessionTaskPointer(projectDir, sessionId, taskRecord.taskId);
    process.stdout.write(JSON.stringify({
      ok: true,
      taskId: taskRecord.taskId,
      skipped: 'already_closed'
    }) + '\n');
    return;
  }

  const obsidianConfig = loadObsidianConfig(projectDir);
  const inferScope = buildInferScope(manifest);

  // lesson 본문은 세션 Claude 가 /task-close 흐름에서 learn-write 로 작성·저장한다(D-23).
  // 여기서는 troubleshooting/decision/architecture 등 휴리스틱 산출물만 처리.
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
    worklogResult = generateWorklogInline(projectDir, taskRecord, obsidianConfig, {
      sessionId,
      hookEventName: 'TaskClose'
    }, now);

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

  const artifactTotals = countTaskArtifacts(projectDir, taskRecord.taskId);

  const pendingEventType = args.close ? 'task_closed' : 'session_ended';
  appendJsonl(getEventFilePath(projectDir, now), {
    ts: now.toISOString(),
    taskId: taskRecord.taskId,
    eventType: pendingEventType,
    scope: (taskRecord.matchedScopes || []).join(',') || defaultScope,
    summary: args.close ? `task closed: ${taskRecord.title || taskRecord.taskId}` : `session ended: ${taskRecord.title || taskRecord.taskId}`,
    detail: {
      sessionId,
      lessonsCreated: artifactTotals.counts.lesson,
      decisionsCreated: artifactTotals.counts.decision,
      troubleshootingCreated: artifactTotals.counts.troubleshooting,
      architectureCreated: artifactTotals.counts.architecture,
      curatedArtifacts: newLessons.length,
      lessonsDuplicate: newLessons.filter((l) => l.duplicateOf).length,
      vaultWrites: artifactTotals.vaultWrites,
      archChanges: archChanges.length,
      promotedDocs: promotedDocs.length,
      totalHitEntries: Object.keys(hitCounts).length,
      durationMs: taskRecord.createdAt ? now.getTime() - new Date(taskRecord.createdAt).getTime() : null,
      // +1: 지금 기록하는 이 이벤트 포함
      eventCount: countTaskEvents(projectDir, taskRecord.taskId, taskRecord.createdAt) + 1,
      contextTokenEstimate: estimateContextTokens(taskRecord)
    }
  });

  if (args.close) {
    try { syncManagedRoots(projectDir, obsidianConfig); } catch { /* non-critical */ }
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    taskId: taskRecord.taskId,
    lessonsCreated: artifactTotals.counts.lesson,
    artifacts: artifactTotals.counts,
    curatedArtifacts: newLessons.length,
    vaultWrites: artifactTotals.vaultWrites,
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
