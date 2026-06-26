/**
 * Shared learning-curate engine for Obsidian-Claude runtime.
 *
 * Curates task knowledge into lesson/troubleshooting/decision documents,
 * deduplicates against existing knowledge, publishes to Obsidian vault,
 * and updates JSONL knowledge indexes.
 *
 * Project-specific behaviour is injected via `config`:
 *   config.loadObsidianConfig(projectDir)   -- returns vault/context config
 *   config.writeVaultArtifact(params)        -- writes to vault or queue
 *   config.mapDomain?(filePath, scope)       -- optional domain mapper for architecture refs
 *   config.scopeFolderMap?                   -- scope->folder name mapping
 *   config.decisionTokens?                   -- tokens that trigger decision creation
 *   config.projectTag?                       -- project tag for frontmatter (default: 'project')
 *   config.inferScope?(filePath)             -- override scope inference
 */

import fs from 'fs';
import path from 'path';
import {
  ensureRuntimeLayout,
  formatMarkdownList,
  getRuntimePaths,
  inferScopeFromPath,
  loadJsonl,
  loadTaskEvents,
  loadTaskRecord,
  parseCliArgs,
  shortenPath,
  tokenizeSearchText,
  uniqueStrings,
  updateTaskRecord,
  writeJsonlFile
} from './runtime-lib.mjs';
import {
  limitText,
  normalizePath,
  toDateStamp
} from './utils.mjs';
import { extractLessonContent } from './memory/lesson-extractor.mjs';
import { isBoilerplateGuardrail } from './context-resolver.mjs';
import { moveFileToQuarantine } from './obsidian-sync.mjs';

// ── Constants ──────────────────────────────────────────────────────

const KNOWLEDGE_INDEX_FILES = {
  lesson: 'lessons.jsonl',
  troubleshooting: 'troubleshooting.jsonl',
  decision: 'decisions.jsonl',
  architecture: 'architecture.jsonl'
};

const DEFAULT_DECISION_TOKENS = [
  'architecture', 'workflow', 'runtime', 'memory', 'hook', 'plan',
  'obsidian', 'claude', '구조', '아키텍처', '옵시디언', '클로드', '학습', '메모리'
];

const DEFAULT_SCOPE_FOLDER_MAP = {
  backend: 'Backend',
  frontend: 'Frontend',
  frontend_admin: 'Frontend_Admin',
  workflow: 'Workflow',
  prompt: 'Prompt',
  'prompt-engine': 'Prompt_Engine',
  llm: 'LLM',
  'ui-configure': 'UI',
  'ui-pipeline': 'UI',
  'ui-simulate': 'UI',
  'ui-evaluate': 'UI'
};

const DEDUP_STOP_TOKENS = new Set([
  'lesson', 'decision', 'troubleshooting',
  'session', 'id', 'backend', 'frontend', 'workflow', 'repo', 'scope',
  'captured', 'reusable', 'guidance', 'file', 'verification',
  'src', 'js', 'mjs', 'ts', 'md',
  'jsproj', 'talkup', 'talksim', 'claude', 'runtime', 'memory'
]);

// ── Helper functions ───────────────────────────────────────────────

function buildScopeCounts(task, config) {
  const counts = new Map();
  const scopeFn = config?.inferScope || inferScopeFromPath;

  for (const scope of task.matchedScopes || []) {
    counts.set(scope, (counts.get(scope) || 0) + 1);
  }

  for (const filePath of (task.files || []).filter((v) => !path.isAbsolute(String(v)))) {
    const scope = scopeFn(filePath);
    counts.set(scope, (counts.get(scope) || 0) + 2);
  }

  return counts;
}

function determinePrimaryScope(task, config) {
  const counts = buildScopeCounts(task, config);
  if (counts.size === 0) return 'repo';

  return Array.from(counts.entries())
    .sort((a, b) => b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0]))[0][0];
}

function toScopeFolder(scope, folderMap) {
  const map = { ...DEFAULT_SCOPE_FOLDER_MAP, ...folderMap };
  const normalized = String(scope || 'repo').toLowerCase();
  return map[normalized] || 'Repo';
}

function normalizeFailureSummary(value) {
  return limitText(String(value || '').replace(/\s+/g, ' ').trim(), 180);
}

function collectVerificationSummary(task) {
  const items = Array.isArray(task.verifications) ? task.verifications : [];
  return {
    all: items,
    passed: items.filter((i) => i.success),
    failed: items.filter((i) => i.success === false)
  };
}

function collectImportantFiles(task) {
  return uniqueStrings(
    (task.files || []).filter(Boolean).filter((f) => !path.isAbsolute(String(f)))
  ).slice(0, 8);
}

function collectChangedScopes(task, config) {
  const scopeFn = config?.inferScope || inferScopeFromPath;
  return uniqueStrings([
    ...(task.matchedScopes || []),
    ...(task.files || []).map((f) => scopeFn(f))
  ]).filter((s) => s && s !== 'repo');
}

// ── Rule builders ──────────────────────────────────────────────────

function buildLessonRules(task, primaryScope, config) {
  const scopes = collectChangedScopes(task, config);
  const verifications = collectVerificationSummary(task);
  const rules = [];

  if (scopes.includes('backend') && scopes.includes('frontend')) {
    rules.push('Backend and frontend contract changes should stay in one task and be verified from both entrypoints before close.');
  }

  if ((task.detectedSurfaces || []).length > 0) {
    rules.push('When a public surface changes, record the path first and queue architecture follow-up before writing a long narrative doc.');
  }

  if (verifications.failed.length > 0) {
    rules.push('Keep the failing verification command and summary in the task record before retrying or publishing a lesson.');
  } else if (verifications.passed.length > 0) {
    rules.push('Carry at least one successful verification command into the task close note so the next session can reuse it immediately.');
  }

  for (const guardrail of task.guardrails || []) {
    if (isBoilerplateGuardrail(guardrail)) continue;  // 세션 동작 지시 보일러플레이트 제외
    rules.push(String(guardrail));
  }

  if (primaryScope === 'workflow') {
    rules.push('Hook and writeback changes should stay incremental so the working path remains recoverable during migration.');
  }

  return uniqueStrings(rules).slice(0, 4);
}

function buildTroubleshootingChecks(task) {
  const verifications = collectVerificationSummary(task);
  const failures = Array.isArray(task.failures) ? task.failures : [];
  const checks = [];

  for (const f of failures) {
    if (f.summary) checks.push(normalizeFailureSummary(f.summary));
  }
  for (const v of verifications.failed) {
    if (v.command) checks.push(`retry \`${v.command}\``);
  }
  for (const fp of collectImportantFiles(task)) {
    checks.push(`inspect ${shortenPath(fp)}`);
  }

  return uniqueStrings(checks).slice(0, 6);
}

function shouldCreateDecision(task, primaryScope, config) {
  const decisionTokens = config?.decisionTokens || DEFAULT_DECISION_TOKENS;
  const scopeFn = config?.inferScope || inferScopeFromPath;
  const promptTokens = tokenizeSearchText(task.prompt || task.title || '');
  const workflowFiles = (task.files || []).filter((f) => scopeFn(f) === 'workflow');

  return primaryScope === 'workflow' && (
    workflowFiles.length >= 2 ||
    promptTokens.some((t) => decisionTokens.includes(t))
  );
}

// ── Path & metadata helpers ────────────────────────────────────────

function buildRelativeDocPath(kind, scope, dateStamp, taskId, config) {
  if (kind === 'decision') {
    return `07_Decisions/Drafts/${dateStamp}_${taskId}.md`;
  }
  // architecture 는 scope 폴더 분기 없이 Generated 디렉토리 평면 배치(WRITE_POLICY.architectureDraft).
  if (kind === 'architecture') {
    return `04_Architecture/Generated/${dateStamp}_${taskId}.md`;
  }
  const folder = toScopeFolder(scope, config?.scopeFolderMap);
  return kind === 'lesson'
    ? `08_Lessons/${folder}/Drafts/${dateStamp}_${taskId}.md`
    : `06_Troubleshooting/${folder}/Drafts/${dateStamp}_${taskId}.md`;
}

function buildCandidateId(kind, taskId) {
  return `${kind}-${taskId}`;
}

function formatFrontmatterListBlock(key, items) {
  const normalizedItems = uniqueStrings(
    (items || []).map((i) => normalizePath(String(i || '').trim())).filter(Boolean)
  );
  if (normalizedItems.length === 0) return '';
  return `${key}:\n${normalizedItems.map((i) => `  - ${i}`).join('\n')}\n`;
}

function buildArchitectureRefs(files, config) {
  if (!config?.mapDomain) return [];
  const scopeFn = config.inferScope || inferScopeFromPath;
  return uniqueStrings(
    (files || []).map((f) => {
      const scope = scopeFn(f);
      const mapping = config.mapDomain(f, scope);
      return mapping?.architectureDoc ? `04_Architecture/${mapping.architectureDoc}` : '';
    })
  ).filter(Boolean).slice(0, 8);
}

function buildKnowledgeMetadataFrontmatter(files, config) {
  const relatedCode = uniqueStrings(
    (files || []).map((f) => normalizePath(f))
  ).filter(Boolean).slice(0, 12);
  const architectureRefs = buildArchitectureRefs(relatedCode, config);
  return `${formatFrontmatterListBlock('related_code', relatedCode)}${formatFrontmatterListBlock('architecture_refs', architectureRefs)}`;
}

// ── Candidate builders ─────────────────────────────────────────────

function buildLessonCandidate({ task, scope, dateStamp, config, override }) {
  const verifications = collectVerificationSummary(task);
  const projectTag = config?.projectTag || 'project';

  // 본문(summary/rules)은 세션작성 override 가 생성. override 없으면 heuristic 감지 필드만(summary/rules 빈값).
  const extracted = override || extractLessonContent({ task, scope });
  // 세션작성(override) 경로는 세션이 쓴 rules 만 쓴다 — legacy 휴리스틱(buildLessonRules:
  // "read read_first notes..." 등 보일러플레이트)을 섞으면 D-23 "보일러플레이트 0" 철학이 깨진다.
  // 휴리스틱 경로(override 없음)에서만 legacy rules 를 합쳐 하위호환 유지.
  // files 는 실데이터(보일러플레이트 아님)라 양쪽 모두 task files 폴백 유지.
  const legacyRules = override ? [] : buildLessonRules(task, scope, config);
  const rules = uniqueStrings([...(extracted.rules || []), ...legacyRules]).slice(0, 5);
  const files = uniqueStrings([
    ...(extracted.relatedFiles || []),
    ...collectImportantFiles(task)
  ]).slice(0, 12);
  const summary = extracted.summary || '';
  // 세션 작성(override)은 사람 검수 없이 바로 active(검색 대상). 휴리스틱 경로는 draft 유지.
  const status = override ? 'active' : 'draft';
  const generatedBy = override ? 'session-claude' : 'runtime-learning-curate';

  return {
    kind: 'lesson',
    // update 면 세션이 기존 id 를 넘김(같은 문서 교체). create 면 task 기반 새 id.
    id: override?.id || buildCandidateId('lesson', task.taskId),
    scope,
    title: `Lesson - ${limitText(task.title || task.prompt || task.taskId, 72)}`,
    summary,
    relatedFiles: files,
    rules,
    applicable_when: extracted.applicable_when,
    trigger_keywords: extracted.trigger_keywords,
    relativePath: buildRelativeDocPath('lesson', scope, dateStamp, task.taskId, config),
    content: `---
title: Auto Lesson ${dateStamp} (${task.taskId})
date: ${dateStamp}
task_id: ${task.taskId}
type: lesson
status: ${status}
scope: ${scope}
tags: [${projectTag}, ${scope}, lesson, runtime-memory]
generated_by: ${generatedBy}
${buildKnowledgeMetadataFrontmatter(files, config)}---

# Lesson
- task: \`${limitText(task.title || task.prompt || task.taskId, 120).replace(/`/g, "'")}\`
- summary: ${summary}

## Reuse Rules
${formatMarkdownList(rules.map((r) => limitText(r, 180)))}

## Related Files
${formatMarkdownList(files.map((f) => shortenPath(f)))}

## Verification Signals
${formatMarkdownList(
  verifications.all.slice(0, 6).map((i) => `${i.success ? 'PASS' : 'FAIL'} \`${i.command}\` :: ${limitText(i.summary || '', 160)}`),
  'No verification records'
)}
`
  };
}

function buildTroubleshootingCandidate({ task, scope, dateStamp, config }) {
  const failures = Array.isArray(task.failures) ? task.failures : [];
  if (failures.length === 0) return null;

  const verifications = collectVerificationSummary(task);
  const files = collectImportantFiles(task);
  const projectTag = config?.projectTag || 'project';
  const topFailure = failures[0];
  const summary = `Failure captured during "${limitText(task.title || task.prompt || task.taskId, 80)}": ${normalizeFailureSummary(topFailure.summary)}`;

  return {
    kind: 'troubleshooting',
    id: buildCandidateId('troubleshooting', task.taskId),
    scope,
    title: `Troubleshooting - ${limitText(task.title || task.prompt || task.taskId, 72)}`,
    summary,
    relatedFiles: files,
    checks: buildTroubleshootingChecks(task),
    relativePath: buildRelativeDocPath('troubleshooting', scope, dateStamp, task.taskId, config),
    content: `---
title: Auto Troubleshooting ${dateStamp} (${task.taskId})
date: ${dateStamp}
task_id: ${task.taskId}
type: troubleshooting
status: draft
scope: ${scope}
tags: [${projectTag}, ${scope}, troubleshooting, runtime-memory]
generated_by: runtime-learning-curate
${buildKnowledgeMetadataFrontmatter(files, config)}---

## Symptom
- ${normalizeFailureSummary(topFailure.summary)}

## Failed Verification
${formatMarkdownList(
  verifications.failed.slice(0, 6).map((i) => `\`${i.command}\` :: ${limitText(i.summary || '', 160)}`),
  'No failed verifications'
)}

## Checks
${formatMarkdownList(buildTroubleshootingChecks(task))}

## Related Files
${formatMarkdownList(files.map((f) => shortenPath(f)))}

## Guardrails
${formatMarkdownList((task.guardrails || []).filter((g) => !isBoilerplateGuardrail(g)).slice(0, 4))}
`
  };
}

function buildDecisionCandidate({ task, scope, dateStamp, config, override }) {
  // 세션 작성 경로(override)는 scope 게이트 우회 — 세션이 "이건 결정이다" 라고 판단했으므로.
  if (!override && !shouldCreateDecision(task, scope, config)) return null;

  const scopeFn = config?.inferScope || inferScopeFromPath;
  const projectTag = config?.projectTag || 'project';
  const legacyFiles = collectImportantFiles(task).filter((f) => scopeFn(f) === 'workflow');
  const legacyRules = buildLessonRules(task, scope, config);

  // override(세션 작성) 우선. 없으면 휴리스틱 고정문장(하위호환).
  const statement = override?.statement || (scope === 'workflow'
    ? 'Keep runtime memory in compact repo-local indexes and publish curated docs only at task close or session end.'
    : 'Document architecture and workflow changes as explicit decisions when they alter the operating path.');
  const why = (override && Array.isArray(override.why) && override.why.length > 0)
    ? override.why.slice(0, 6)
    : [
        ...legacyRules,
        ...(legacyFiles.length > 0 ? ['The workflow touched concrete hook/script files, so the operating path should be written down explicitly.'] : [])
      ].slice(0, 4);
  const files = (override && Array.isArray(override.relatedFiles) && override.relatedFiles.length > 0)
    ? uniqueStrings(override.relatedFiles).slice(0, 12)
    : legacyFiles;
  // 세션이 직접 판단·작성한 건 사람 검수 없이 바로 active. 휴리스틱 경로는 draft 유지.
  const status = override ? 'active' : 'draft';
  const generatedBy = override ? 'session-claude' : 'runtime-learning-curate';

  return {
    kind: 'decision',
    id: override?.id || buildCandidateId('decision', task.taskId),
    scope,
    title: `Decision - ${limitText(task.title || task.prompt || task.taskId, 72)}`,
    summary: statement,
    relatedFiles: files,
    rules: why,
    // 검색 신호 (G1): 세션 작성 경로에서만 채워짐. 휴리스틱 경로(override 없음)는 빈 값 유지.
    trigger_keywords: (override && Array.isArray(override.trigger_keywords)) ? override.trigger_keywords : [],
    applicable_when: (override && override.applicable_when && typeof override.applicable_when === 'object')
      ? override.applicable_when
      : {},
    relativePath: buildRelativeDocPath('decision', scope, dateStamp, task.taskId, config),
    content: `---
title: Auto Decision ${dateStamp} (${task.taskId})
date: ${dateStamp}
task_id: ${task.taskId}
type: decision
status: ${status}
scope: ${scope}
tags: [${projectTag}, ${scope}, decision, runtime-memory]
generated_by: ${generatedBy}
${buildKnowledgeMetadataFrontmatter(files, config)}---

# Context
- task: \`${limitText(task.title || task.prompt || task.taskId, 120).replace(/`/g, "'")}\`
- primary scope: \`${scope}\`

# Decision
- ${statement}

# Why
${formatMarkdownList(why.map((w) => limitText(String(w), 240)))}

# Related Files
${formatMarkdownList(files.map((f) => shortenPath(f)), 'No workflow files changed')}
`
  };
}

// ── Dedup ──────────────────────────────────────────────────────────

function buildCandidateRow(candidate, task, publishedArtifact, duplicateOf = '') {
  const baseTokens = uniqueStrings([
    ...tokenizeSearchText(candidate.title),
    ...tokenizeSearchText(candidate.summary),
    ...candidate.relatedFiles.flatMap((f) => tokenizeSearchText(f))
  ]).slice(0, 24);

  return {
    id: candidate.id,
    kind: candidate.kind,
    scope: candidate.scope,
    title: candidate.title,
    summary: candidate.summary,
    rules: candidate.rules || [],
    checks: candidate.checks || [],
    relatedFiles: candidate.relatedFiles,
    applicable_when: candidate.applicable_when || {},
    trigger_keywords: candidate.trigger_keywords || [],
    sourceTaskId: task.taskId,
    sourceDoc: candidate.relativePath,
    storage: publishedArtifact?.result?.storage || '',
    path: publishedArtifact?.result?.path ? normalizePath(publishedArtifact.result.path) : '',
    duplicateOf,
    updatedAt: new Date().toISOString(),
    tokens: baseTokens
  };
}

function findDuplicateCandidate(existingRows, candidate, vaultRoot) {
  const candidateFileNames = new Set(
    candidate.relatedFiles.map((f) => path.basename(f).toLowerCase())
  );
  const rawTokens = tokenizeSearchText(`${candidate.title} ${candidate.summary}`);
  const candidateTokens = new Set(rawTokens.filter((t) => !DEDUP_STOP_TOKENS.has(t)));

  for (const row of existingRows) {
    if (!row || row.sourceTaskId === candidate.id.replace(/^(lesson|troubleshooting|decision)-/, '')) continue;
    if (row.scope !== candidate.scope) continue;

    const rowFileNames = new Set((row.relatedFiles || []).map((f) => path.basename(String(f)).toLowerCase()));
    const fileOverlap = Array.from(candidateFileNames).filter((fn) => rowFileNames.has(fn)).length;
    const filteredRowTokens = (row.tokens || []).filter((t) => !DEDUP_STOP_TOKENS.has(t));
    const tokenOverlap = Array.from(candidateTokens).filter((t) => filteredRowTokens.includes(t)).length;

    if (fileOverlap >= 2 || tokenOverlap >= 5) {
      if (vaultRoot && row.sourceDoc) {
        const vaultPath = path.join(vaultRoot, row.sourceDoc);
        if (!fs.existsSync(vaultPath)) continue;
      }
      return row;
    }
  }

  return null;
}

// ── Publish & index helpers ────────────────────────────────────────

function publishCandidate(projectDir, obsidianConfig, candidate, publish, config) {
  if (!publish) {
    return {
      kind: candidate.kind,
      relativePath: candidate.relativePath,
      result: { storage: 'skipped', path: '', skipped: true }
    };
  }

  const writeFn = config?.writeVaultArtifact;
  if (!writeFn) {
    return {
      kind: candidate.kind,
      relativePath: candidate.relativePath,
      result: { storage: 'local', path: '', skipped: true }
    };
  }

  return {
    kind: candidate.kind,
    relativePath: candidate.relativePath,
    result: writeFn({
      projectDir,
      vaultRoot: obsidianConfig.vaultRoot,
      relativePath: candidate.relativePath,
      content: candidate.content,
      queueRoot: 'document/obsidian_writeback_queue'
    })
  };
}

function upsertKnowledgeRow(projectDir, kind, nextRow, obsidianConfig = null) {
  const runtimePaths = getRuntimePaths(projectDir);
  const targetPath = path.join(runtimePaths.knowledgeRoot, KNOWLEDGE_INDEX_FILES[kind]);
  const existing = loadJsonl(targetPath);

  // On update (same id), the doc filename is taskId-based, so a re-run from a new
  // task writes a NEW .md and leaves the previous one orphaned on disk with stale
  // content (no index points at it; sync no longer prunes it). Quarantine the old
  // doc — move, never delete (past mirror-only deletion lost data irrecoverably).
  const prior = existing.find((r) => r?.id === nextRow.id);
  quarantineSupersededDoc(prior, nextRow, obsidianConfig);

  const rows = existing
    .filter((r) => r?.id !== nextRow.id)
    .concat(nextRow)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  writeJsonlFile(targetPath, rows);
  return targetPath;
}

/**
 * When an update replaces a row whose vault doc lived at a different path,
 * move the now-orphaned old .md into _quarantine (best-effort, never throws).
 */
function quarantineSupersededDoc(priorRow, nextRow, obsidianConfig) {
  if (!obsidianConfig?.vaultRoot || !obsidianConfig?.contextRoot) return;
  const priorDoc = normalizePath(priorRow?.sourceDoc || '');
  const nextDoc = normalizePath(nextRow?.sourceDoc || '');
  if (!priorDoc || priorDoc === nextDoc) return; // no prior, or same file (overwritten in place)

  const oldAbs = path.join(obsidianConfig.vaultRoot, priorDoc);
  if (!fs.existsSync(oldAbs)) return; // already gone / queued elsewhere

  try {
    moveFileToQuarantine(obsidianConfig.contextRoot, oldAbs, priorDoc);
  } catch {
    // Best-effort: a failed quarantine must never block the index write.
  }
}

function buildKnowledgeFollowUpEntry(candidate, artifact, duplicateOf = '') {
  return {
    kind: candidate.kind,
    title: candidate.title,
    summary: candidate.summary,
    relativePath: candidate.relativePath,
    storage: artifact?.result?.storage || '',
    path: artifact?.result?.path ? normalizePath(artifact.result.path) : '',
    duplicateOf
  };
}

// ── Main exported function ─────────────────────────────────────────

/**
 * @param {string} projectDir
 * @param {object} options      - { taskId, publish, forcePublish }
 * @param {object} [config]     - project-specific overrides
 * @param {function} config.loadObsidianConfig  - (projectDir) => obsidianConfig
 * @param {function} config.writeVaultArtifact  - (params) => { storage, path }
 * @param {function} [config.mapDomain]         - (filePath, scope) => { architectureDoc? }
 * @param {function} [config.inferScope]        - (filePath) => scopeString
 * @param {object}   [config.scopeFolderMap]    - { scopeName: FolderName }
 * @param {string[]} [config.decisionTokens]    - tokens that trigger decision creation
 * @param {string}   [config.projectTag]        - tag for frontmatter (default: 'project')
 */
export function curateTaskKnowledge(projectDir, options = {}, config = {}) {
  ensureRuntimeLayout(projectDir);
  const loaded = loadTaskRecord(projectDir, options.taskId || '');
  if (!loaded?.task) {
    return { ok: false, reason: 'task_not_found' };
  }

  const task = loaded.task;
  const primaryScope = determinePrimaryScope(task, config);
  const dateStamp = toDateStamp(new Date(task.updatedAt || task.createdAt || new Date()));
  const obsidianConfig = config.loadObsidianConfig
    ? config.loadObsidianConfig(projectDir)
    : { vaultRoot: '', vaultAvailable: false };
  const taskEvents = loadTaskEvents(projectDir, task.taskId);

  const lessonCandidate = buildLessonCandidate({
    task, scope: primaryScope, dateStamp, config, override: options.lessonOverride
  });
  // 게이트: lesson 본문(summary)이 비면 보일러플레이트 생성을 막기 위해 건너뛴다.
  // (override 없이 LLM 비활성 상태 → summary='' → lesson 생성 skip, 쓰레기 0)
  const lessonGated = lessonCandidate && lessonCandidate.summary ? lessonCandidate : null;

  // decision 은 세션 Claude 가 /task-close 흐름에서 decision-write 로 직접 작성한다(D-25).
  // 휴리스틱 buildDecisionCandidate(고정문장)는 자동 생성에서 제외 — 쓰레기 0.
  // troubleshooting 은 그대로(failures 기반, 95% 멀쩡).
  const candidates = [
    buildTroubleshootingCandidate({ task, scope: primaryScope, dateStamp, config }),
    lessonGated
  ].filter(Boolean);

  const artifacts = [];
  const knowledgeFollowUp = {
    architecture: Array.isArray(task.knowledgeFollowUp?.architecture) ? task.knowledgeFollowUp.architecture : [],
    troubleshooting: [],
    lessons: [],
    decisions: []
  };

  for (const candidate of candidates) {
    const indexPath = path.join(getRuntimePaths(projectDir).knowledgeRoot, KNOWLEDGE_INDEX_FILES[candidate.kind]);
    const existingRows = loadJsonl(indexPath);
    const duplicate = options.forcePublish ? null : findDuplicateCandidate(existingRows, candidate, obsidianConfig.vaultRoot);
    const artifact = publishCandidate(projectDir, obsidianConfig, candidate, options.publish !== false && !duplicate, config);
    const row = buildCandidateRow(candidate, task, artifact, duplicate?.sourceDoc || '');
    upsertKnowledgeRow(projectDir, candidate.kind, row, obsidianConfig);

    artifacts.push({
      kind: candidate.kind,
      relativePath: candidate.relativePath,
      duplicateOf: duplicate?.sourceDoc || '',
      result: artifact.result,
      preview: {
        title: candidate.title,
        summary: candidate.summary,
        rules: candidate.rules || [],
        relatedFiles: candidate.relatedFiles
      }
    });

    const entry = buildKnowledgeFollowUpEntry(candidate, artifact, duplicate?.sourceDoc || '');
    if (candidate.kind === 'lesson') knowledgeFollowUp.lessons.push(entry);
    else if (candidate.kind === 'troubleshooting') knowledgeFollowUp.troubleshooting.push(entry);
    else if (candidate.kind === 'decision') knowledgeFollowUp.decisions.push(entry);
  }

  const curatedAt = new Date().toISOString();
  const updated = updateTaskRecord(projectDir, (currentTask) => ({
    ...currentTask,
    updatedAt: curatedAt,
    lastCuratedAt: curatedAt,
    knowledgeFollowUp
  }), task.taskId);

  return {
    ok: true,
    taskId: task.taskId,
    primaryScope,
    eventCount: taskEvents.length,
    artifacts,
    knowledgeFollowUp,
    task: updated?.task || task
  };
}

/**
 * 세션 Claude 가 직접 작성한 lesson 을 frontmatter 문서 + jsonl 인덱스로 저장한다 (D-23).
 *
 * 휴리스틱/API 추출 대신, 작업을 수행한 세션 Claude 가 "무엇을 왜 배웠는가"를 직접
 * 써서 넘긴다(맥락 보존, API 비용 0). lesson 본문은 commands/learn-write.mjs 가
 * stdin 으로 받아 이 함수에 lessonOverride 로 전달한다.
 *
 * create/update/skip 판단은 세션 Claude 가 task-close 흐름에서 직접 함(D-25 미러링).
 * 같은 주제 lesson 이 있으면 mode:update 로 같은 id 를 교체(중복 문서 방지),
 * 없으면 mode:create. 충분하면 아예 호출하지 않음(skip). 코드의 토큰겹침 추측
 * (findDuplicateCandidate)은 우회 — 세션이 판단했으므로 항상 publish.
 *
 * @param {string} projectDir
 * @param {object} options    { taskId, mode: 'create'|'update', lesson, publish }
 *   - lesson: { summary, rules[], applicable_when?, trigger_keywords?, relatedFiles?,
 *               language?, kind?, task_type?, importance?, confidence?, id? }
 * @param {object} config     curateTaskKnowledge 와 동일 (loadObsidianConfig/writeVaultArtifact/...)
 * @returns {{ ok, action, taskId, artifact } | { ok:false, reason }}
 */
export function writeSessionLesson(projectDir, options = {}, config = {}) {
  ensureRuntimeLayout(projectDir);
  const loaded = loadTaskRecord(projectDir, options.taskId || '');
  if (!loaded?.task) {
    return { ok: false, reason: 'task_not_found' };
  }
  const lesson = options.lesson;
  if (!lesson || typeof lesson !== 'object' || !lesson.summary) {
    return { ok: false, reason: 'invalid_lesson', detail: 'summary 가 필요합니다.' };
  }

  const task = loaded.task;
  const mode = options.mode === 'update' ? 'update' : 'create';
  const primaryScope = determinePrimaryScope(task, config);
  const dateStamp = toDateStamp(new Date(task.updatedAt || task.createdAt || new Date()));
  const obsidianConfig = config.loadObsidianConfig
    ? config.loadObsidianConfig(projectDir)
    : { vaultRoot: '', vaultAvailable: false };

  // 세션 작성 lesson 을 override 로 주입 → 기존 frontmatter 빌더/퍼블리시 로직 재사용.
  // update 면 기존 lesson id 를 유지(같은 문서 교체). create 면 task 기반 새 id.
  const override = {
    summary: lesson.summary,
    rules: Array.isArray(lesson.rules) ? lesson.rules : [],
    applicable_when: lesson.applicable_when || {},
    trigger_keywords: Array.isArray(lesson.trigger_keywords) ? lesson.trigger_keywords : [],
    relatedFiles: Array.isArray(lesson.relatedFiles) ? lesson.relatedFiles : [],
    language: lesson.language,
    kind: lesson.kind,
    task_type: lesson.task_type,
    importance: lesson.importance,
    confidence: lesson.confidence,
    id: mode === 'update' ? lesson.id : undefined
  };
  const candidate = buildLessonCandidate({ task, scope: primaryScope, dateStamp, config, override });

  // 세션이 판단했으므로 중복판정 우회 — 항상 publish(active). upsert 가 같은 id 교체.
  const artifact = publishCandidate(projectDir, obsidianConfig, candidate, options.publish !== false, config);
  const row = buildCandidateRow(candidate, task, artifact, '');
  upsertKnowledgeRow(projectDir, 'lesson', row, obsidianConfig);

  return {
    ok: true,
    action: mode,
    taskId: task.taskId,
    artifact: {
      kind: 'lesson',
      id: candidate.id,
      relativePath: candidate.relativePath,
      result: artifact.result,
      title: candidate.title,
      summary: candidate.summary
    }
  };
}

/**
 * 세션 Claude 가 직접 판단·작성한 decision 을 저장한다 (D-25).
 *
 * create/update/skip 판단은 세션 Claude 가 task-close 흐름에서 직접 함(코드의
 * 토큰겹침 추측 폐기). 세션이 명시한 mode 대로 저장하고, 사람 검수 없이 active.
 *
 * @param {string} projectDir
 * @param {object} options  { taskId, mode: 'create'|'update',
 *   decision: { statement, why[], relatedFiles[], scope?, id? } }
 * @param {object} config   writeSessionLesson 과 동일 (loadObsidianConfig/writeVaultArtifact/...)
 * @returns {{ ok, action, taskId, artifact } | { ok:false, reason }}
 */
export function writeSessionDecision(projectDir, options = {}, config = {}) {
  ensureRuntimeLayout(projectDir);
  const loaded = loadTaskRecord(projectDir, options.taskId || '');
  if (!loaded?.task) {
    return { ok: false, reason: 'task_not_found' };
  }
  const decision = options.decision;
  if (!decision || typeof decision !== 'object' || !decision.statement) {
    return { ok: false, reason: 'invalid_decision', detail: 'statement 가 필요합니다.' };
  }

  const task = loaded.task;
  const mode = options.mode === 'update' ? 'update' : 'create';
  const scope = decision.scope || determinePrimaryScope(task, config);
  const dateStamp = toDateStamp(new Date(task.updatedAt || task.createdAt || new Date()));
  const obsidianConfig = config.loadObsidianConfig
    ? config.loadObsidianConfig(projectDir)
    : { vaultRoot: '', vaultAvailable: false };

  // update 면 기존 decision id 를 유지(같은 문서 교체). create 면 task 기반 새 id.
  const override = {
    statement: decision.statement,
    why: Array.isArray(decision.why) ? decision.why : [],
    relatedFiles: Array.isArray(decision.relatedFiles) ? decision.relatedFiles : [],
    // 검색 신호 (G1): 세션이 채운 trigger_keywords / applicable_when 을 보존해 게이트·점수에 기여하게 한다.
    trigger_keywords: Array.isArray(decision.trigger_keywords) ? decision.trigger_keywords : [],
    applicable_when: (decision.applicable_when && typeof decision.applicable_when === 'object')
      ? decision.applicable_when
      : {},
    id: mode === 'update' ? decision.id : undefined
  };
  const candidate = buildDecisionCandidate({ task, scope, dateStamp, config, override });

  // 세션이 판단했으므로 중복판정 우회 — 항상 publish(active). upsert 가 같은 id 교체.
  const artifact = publishCandidate(projectDir, obsidianConfig, candidate, options.publish !== false, config);
  const row = buildCandidateRow(candidate, task, artifact, '');
  upsertKnowledgeRow(projectDir, 'decision', row, obsidianConfig);

  return {
    ok: true,
    action: mode,
    taskId: task.taskId,
    artifact: {
      kind: 'decision',
      id: candidate.id,
      relativePath: candidate.relativePath,
      result: artifact.result,
      title: candidate.title,
      summary: candidate.summary
    }
  };
}

/**
 * 기존 산출물 목록을 조회한다 (세션이 create/update/skip 판단 시 참고).
 * @param {string} projectDir
 * @param {'lesson'|'decision'|'troubleshooting'|'architecture'} kind
 * @returns {Array<{id,title,summary,scope,sourceDoc,updatedAt}>}
 */
export function listSessionArtifacts(projectDir, kind = 'decision') {
  const indexFile = KNOWLEDGE_INDEX_FILES[kind];
  if (!indexFile) return [];
  const indexPath = path.join(getRuntimePaths(projectDir).knowledgeRoot, indexFile);
  return loadJsonl(indexPath).map((r) => ({
    id: r?.id || '',
    title: r?.title || '',
    summary: r?.summary || '',
    scope: r?.scope || '',
    sourceDoc: r?.sourceDoc || '',
    updatedAt: r?.updatedAt || ''
  }));
}

// ── 세션작성 troubleshooting / architecture (D-26, D-25 미러링) ──────

/**
 * 세션 Claude 가 직접 작성한 troubleshooting 후보를 만든다 (D-26).
 *
 * 기존 buildTroubleshootingCandidate(failures 게이트 + CURATOR_TODO 마커)와 달리,
 * 세션이 증상~검증 6섹션을 직접 채워 넘긴다. failures 게이트 우회, status:active.
 */
function buildSessionTroubleshootingCandidate({ task, scope, dateStamp, config, override }) {
  const projectTag = config?.projectTag || 'project';
  const files = uniqueStrings([
    ...(Array.isArray(override.relatedFiles) ? override.relatedFiles : []),
    ...collectImportantFiles(task)
  ]).slice(0, 12);
  const symptom = String(override.symptom || '').trim();
  const cause = String(override.cause || '').trim();
  const fix = String(override.fix || '').trim();
  const prevention = String(override.prevention || '').trim();
  const verification = String(override.verification || '').trim();
  const summary = limitText(symptom, 180);

  return {
    kind: 'troubleshooting',
    id: override.id || buildCandidateId('troubleshooting', task.taskId),
    scope,
    title: `Troubleshooting - ${limitText(task.title || task.prompt || task.taskId, 72)}`,
    summary,
    relatedFiles: files,
    checks: [],
    // 검색 신호 (G1): 세션이 채운 trigger_keywords / applicable_when 보존.
    trigger_keywords: Array.isArray(override.trigger_keywords) ? override.trigger_keywords : [],
    applicable_when: (override.applicable_when && typeof override.applicable_when === 'object')
      ? override.applicable_when
      : {},
    relativePath: buildRelativeDocPath('troubleshooting', scope, dateStamp, task.taskId, config),
    content: `---
title: Troubleshooting ${dateStamp} (${task.taskId})
date: ${dateStamp}
task_id: ${task.taskId}
type: troubleshooting
status: active
scope: ${scope}
tags: [${projectTag}, ${scope}, troubleshooting, runtime-memory]
generated_by: session-claude
${buildKnowledgeMetadataFrontmatter(files, config)}---

## 증상
- ${symptom || '(증상 없음)'}

## 실제 원인
- ${cause || '(원인 미기재)'}

## 수정 방법
- ${fix || '(수정 미기재)'}

## 재발 방지 규칙
- ${prevention || '(재발 방지 규칙 미기재)'}

## 검증
- ${verification || '(검증 미기재)'}

## 관련 파일
${formatMarkdownList(files.map((f) => shortenPath(f)), 'No related files')}
`
  };
}

/**
 * 세션 Claude 가 직접 작성한 architecture 후보를 만든다 (D-26).
 *
 * 전체 재작성 — upsertMarkedSection 부분교체 불필요. 세션이 기존 읽고 통째로 다시 씀.
 * 입력은 단순 { summary, body(markdown) } — 세션이 본문 마크다운을 직접 작성.
 */
function buildArchitectureCandidate({ task, scope, dateStamp, config, override }) {
  const projectTag = config?.projectTag || 'project';
  const files = uniqueStrings([
    ...(Array.isArray(override.relatedFiles) ? override.relatedFiles : []),
    ...collectImportantFiles(task)
  ]).slice(0, 12);
  const summary = limitText(String(override.summary || '').trim(), 240);
  const body = String(override.body || '').trim();
  const title = override.title
    ? limitText(String(override.title), 72)
    : limitText(task.title || task.prompt || task.taskId, 72);

  return {
    kind: 'architecture',
    id: override.id || buildCandidateId('architecture', task.taskId),
    scope,
    title: `Architecture - ${title}`,
    summary,
    relatedFiles: files,
    // 검색 신호 (G1): 세션이 채운 trigger_keywords / applicable_when 보존.
    trigger_keywords: Array.isArray(override.trigger_keywords) ? override.trigger_keywords : [],
    applicable_when: (override.applicable_when && typeof override.applicable_when === 'object')
      ? override.applicable_when
      : {},
    relativePath: buildRelativeDocPath('architecture', scope, dateStamp, task.taskId, config),
    content: `---
title: Architecture ${dateStamp} (${task.taskId})
date: ${dateStamp}
task_id: ${task.taskId}
type: architecture
status: active
scope: ${scope}
tags: [${projectTag}, ${scope}, architecture, runtime-memory]
generated_by: session-claude
${buildKnowledgeMetadataFrontmatter(files, config)}---

# ${title}

${body || `- ${summary || '(본문 미기재)'}`}

## 관련 파일
${formatMarkdownList(files.map((f) => shortenPath(f)), 'No related files')}
`
  };
}

/**
 * 세션 Claude 가 직접 판단·작성한 troubleshooting 을 저장한다 (D-26, D-25 미러링).
 *
 * @param {string} projectDir
 * @param {object} options  { taskId, mode: 'create'|'update',
 *   troubleshooting: { symptom, cause?, fix?, prevention?, verification?, relatedFiles[], scope?, id? } }
 * @param {object} config   writeSessionDecision 과 동일
 * @returns {{ ok, action, taskId, artifact } | { ok:false, reason }}
 */
export function writeSessionTroubleshooting(projectDir, options = {}, config = {}) {
  ensureRuntimeLayout(projectDir);
  const loaded = loadTaskRecord(projectDir, options.taskId || '');
  if (!loaded?.task) {
    return { ok: false, reason: 'task_not_found' };
  }
  const trouble = options.troubleshooting;
  if (!trouble || typeof trouble !== 'object' || !trouble.symptom) {
    return { ok: false, reason: 'invalid_troubleshooting', detail: 'symptom 이 필요합니다.' };
  }

  const task = loaded.task;
  const mode = options.mode === 'update' ? 'update' : 'create';
  const scope = trouble.scope || determinePrimaryScope(task, config);
  const dateStamp = toDateStamp(new Date(task.updatedAt || task.createdAt || new Date()));
  const obsidianConfig = config.loadObsidianConfig
    ? config.loadObsidianConfig(projectDir)
    : { vaultRoot: '', vaultAvailable: false };

  const override = {
    symptom: trouble.symptom,
    cause: trouble.cause,
    fix: trouble.fix,
    prevention: trouble.prevention,
    verification: trouble.verification,
    relatedFiles: Array.isArray(trouble.relatedFiles) ? trouble.relatedFiles : [],
    // 검색 신호 (G1): 세션이 채운 trigger_keywords / applicable_when 을 보존해 게이트·점수에 기여하게 한다.
    trigger_keywords: Array.isArray(trouble.trigger_keywords) ? trouble.trigger_keywords : [],
    applicable_when: (trouble.applicable_when && typeof trouble.applicable_when === 'object')
      ? trouble.applicable_when
      : {},
    id: mode === 'update' ? trouble.id : undefined
  };
  const candidate = buildSessionTroubleshootingCandidate({ task, scope, dateStamp, config, override });

  // 세션이 판단했으므로 중복판정 우회 — 항상 publish(active). upsert 가 같은 id 교체.
  const artifact = publishCandidate(projectDir, obsidianConfig, candidate, options.publish !== false, config);
  const row = buildCandidateRow(candidate, task, artifact, '');
  upsertKnowledgeRow(projectDir, 'troubleshooting', row, obsidianConfig);

  return {
    ok: true,
    action: mode,
    taskId: task.taskId,
    artifact: {
      kind: 'troubleshooting',
      id: candidate.id,
      relativePath: candidate.relativePath,
      result: artifact.result,
      title: candidate.title,
      summary: candidate.summary
    }
  };
}

/**
 * 세션 Claude 가 직접 판단·작성한 architecture 를 저장한다 (D-26, D-25 미러링).
 *
 * @param {string} projectDir
 * @param {object} options  { taskId, mode: 'create'|'update',
 *   architecture: { summary, body?, title?, relatedFiles[], scope?, id? } }
 * @param {object} config   writeSessionDecision 과 동일
 * @returns {{ ok, action, taskId, artifact } | { ok:false, reason }}
 */
export function writeSessionArchitecture(projectDir, options = {}, config = {}) {
  ensureRuntimeLayout(projectDir);
  const loaded = loadTaskRecord(projectDir, options.taskId || '');
  if (!loaded?.task) {
    return { ok: false, reason: 'task_not_found' };
  }
  const arch = options.architecture;
  if (!arch || typeof arch !== 'object' || !arch.summary) {
    return { ok: false, reason: 'invalid_architecture', detail: 'summary 가 필요합니다.' };
  }

  const task = loaded.task;
  const mode = options.mode === 'update' ? 'update' : 'create';
  const scope = arch.scope || determinePrimaryScope(task, config);
  const dateStamp = toDateStamp(new Date(task.updatedAt || task.createdAt || new Date()));
  const obsidianConfig = config.loadObsidianConfig
    ? config.loadObsidianConfig(projectDir)
    : { vaultRoot: '', vaultAvailable: false };

  const override = {
    summary: arch.summary,
    body: arch.body,
    title: arch.title,
    relatedFiles: Array.isArray(arch.relatedFiles) ? arch.relatedFiles : [],
    // 검색 신호 (G1): 세션이 채운 trigger_keywords / applicable_when 을 보존해 게이트·점수에 기여하게 한다.
    trigger_keywords: Array.isArray(arch.trigger_keywords) ? arch.trigger_keywords : [],
    applicable_when: (arch.applicable_when && typeof arch.applicable_when === 'object')
      ? arch.applicable_when
      : {},
    id: mode === 'update' ? arch.id : undefined
  };
  const candidate = buildArchitectureCandidate({ task, scope, dateStamp, config, override });

  // 세션이 판단했으므로 중복판정 우회 — 항상 publish(active). upsert 가 같은 id 교체.
  const artifact = publishCandidate(projectDir, obsidianConfig, candidate, options.publish !== false, config);
  const row = buildCandidateRow(candidate, task, artifact, '');
  upsertKnowledgeRow(projectDir, 'architecture', row, obsidianConfig);

  return {
    ok: true,
    action: mode,
    taskId: task.taskId,
    artifact: {
      kind: 'architecture',
      id: candidate.id,
      relativePath: candidate.relativePath,
      result: artifact.result,
      title: candidate.title,
      summary: candidate.summary
    }
  };
}

// ── v3 Builders (Design-A §2-D / §3-A/D/E) ────────────────────────
//
// 5 pure (or explicitly I/O) functions used by session-end-engine to seed
// Layer 2/3/4 memories from a closed task. Kept out of `curateTaskKnowledge`
// so session-end can invoke them incrementally and conditionally
// (per manifest.memoryLayers flags).

const CONFIDENCE_TO_IMPORTANCE = { high: 9, medium: 6, low: 3 };

function confidenceFromVerificationCount(count) {
  if (count >= 3) return 'high';
  if (count >= 1) return 'medium';
  return 'low';
}

function extractTriggerKeywords(task, events = []) {
  const sources = [
    task?.title || '',
    task?.prompt || '',
    ...(Array.isArray(task?.files) ? task.files : []).map((f) => path.basename(String(f))),
    ...(Array.isArray(events) ? events : [])
      .map((event) => String(event?.detail?.filePath || event?.filePath || ''))
      .filter(Boolean)
      .map((p) => path.basename(p))
  ];
  const tokens = sources.flatMap((source) => tokenizeSearchText(source));
  const filtered = uniqueStrings(tokens).filter((t) => !DEDUP_STOP_TOKENS.has(t));
  return filtered.slice(0, 8);
}

/**
 * buildLessonDraft — pure. Returns Auto Lesson v3 record (Design-A §3-A).
 * @param {object} task            active/closed task record
 * @param {object[]} [events]      events for this task (tokens for trigger_keywords)
 * @returns {object}               lesson draft (semantic-store.upsertLesson input)
 */
export function buildLessonDraft(task, events = [], override = null) {
  const safeTask = task || {};
  const verificationCount = Array.isArray(safeTask.verifications)
    ? safeTask.verifications.filter((v) => v && v.success).length
    : 0;
  // confidence/importance: LLM override 우선, 없으면 verification 기반 계산.
  const confidence = (override && ['high', 'medium', 'low'].includes(override.confidence))
    ? override.confidence
    : confidenceFromVerificationCount(verificationCount);
  const importance = (override && Number.isFinite(override.importance))
    ? override.importance
    : CONFIDENCE_TO_IMPORTANCE[confidence];
  const scope = Array.isArray(safeTask.matchedScopes) && safeTask.matchedScopes.length > 0
    ? safeTask.matchedScopes[0]
    : 'repo';
  const title = limitText(
    safeTask.title || safeTask.prompt || safeTask.taskId || 'Auto Lesson',
    72
  );

  // 본문(summary/rules)은 LLM override 가 채운다. override 없으면 감지 필드만(summary/rules 빈값).
  const extracted = override || extractLessonContent({ task: safeTask, scope });
  const legacyTriggerKeywords = extractTriggerKeywords(safeTask, events);
  const triggerKeywords = uniqueStrings([
    ...(extracted.trigger_keywords || []),
    ...legacyTriggerKeywords
  ]).slice(0, 12);

  return {
    id: `lesson-${safeTask.taskId || 'unknown'}`,
    type: 'lesson',
    kind: 'lesson',
    scope,
    title: `Lesson - ${title}`,
    summary: limitText(extracted.summary || '', 240),
    rules: extracted.rules || [],
    trigger_keywords: triggerKeywords,
    applicable_when: extracted.applicable_when,
    confidence,
    importance,
    access_count: 0,
    last_accessed_at: '',
    evolved_at: [],
    linked_reflection: null,
    related_task: safeTask.taskId || '',
    related_files: extracted.relatedFiles,
    tokens: uniqueStrings([
      ...tokenizeSearchText(title),
      ...triggerKeywords
    ]).slice(0, 32),
    status: 'draft'
  };
}

/**
 * buildTroubleshootingDraft — pure.
 * Splits content into auto-filled vs manual-fill sections (Design-A §2-D).
 * Returns null when no failures recorded.
 */
export function buildTroubleshootingDraft(task, failures) {
  const safeTask = task || {};
  const failureList = Array.isArray(failures)
    ? failures
    : (Array.isArray(safeTask.failures) ? safeTask.failures : []);
  if (failureList.length === 0) return null;

  const topFailure = failureList[0] || {};
  const files = collectImportantFiles(safeTask);
  const scope = Array.isArray(safeTask.matchedScopes) && safeTask.matchedScopes.length > 0
    ? safeTask.matchedScopes[0]
    : 'repo';
  const verifications = collectVerificationSummary(safeTask);

  const symptom = normalizeFailureSummary(topFailure.summary || '');
  const reproSteps = verifications.failed.slice(0, 3)
    .map((v) => `- \`${v.command}\` → ${limitText(v.summary || '', 160)}`)
    .join('\n') || '- (재현 단계 기록 없음)';
  const impactScope = [scope, ...(files.slice(0, 3).map((f) => shortenPath(f)))].join(' / ');
  const relatedLinks = files.slice(0, 6).map((f) => `- ${shortenPath(f)}`).join('\n') || '- (관련 파일 없음)';

  const body = [
    '## 증상 (auto)',
    `- ${symptom || '(증상 요약 없음)'}`,
    '',
    '## 재현 조건 (auto)',
    reproSteps,
    '',
    '## 영향 범위 (auto)',
    `- ${impactScope}`,
    '',
    '## 관련 링크 (auto)',
    relatedLinks,
    '',
    '## 실제 원인 (manual)',
    '<!-- CURATOR_TODO: fill after investigation -->',
    '',
    '## 수정 방법 (manual)',
    '<!-- CURATOR_TODO: fill after investigation -->',
    '',
    '## 재발 방지 규칙 (manual)',
    '<!-- CURATOR_TODO: fill after investigation -->',
    '',
    '## 검증 (manual)',
    '<!-- CURATOR_TODO: fill after investigation -->',
    ''
  ].join('\n');

  return {
    kind: 'troubleshooting',
    id: `troubleshooting-${safeTask.taskId || 'unknown'}`,
    scope,
    title: `Troubleshooting - ${limitText(safeTask.title || safeTask.prompt || safeTask.taskId || '', 72)}`,
    summary: limitText(`Failure: ${symptom}`, 180),
    relatedFiles: files,
    failureCount: failureList.length,
    autoSections: ['증상', '재현 조건', '영향 범위', '관련 링크'],
    manualSections: ['실제 원인', '수정 방법', '재발 방지 규칙', '검증'],
    body,
    status: 'draft'
  };
}

/**
 * buildReflectionDraft — pure. Returns ReflectionDraft (§3-D) or null.
 * Trigger: at least one failure AND contains a `verification_failed`-like event.
 */
export function buildReflectionDraft(task) {
  const safeTask = task || {};
  const failures = Array.isArray(safeTask.failures) ? safeTask.failures : [];
  if (failures.length < 1) return null;

  const verifications = Array.isArray(safeTask.verifications) ? safeTask.verifications : [];
  const hasVerificationFailure = failures.some((f) =>
    String(f?.eventType || f?.type || '').toLowerCase().includes('verification')
  ) || verifications.some((v) => v && v.success === false);
  if (!hasVerificationFailure) return null;

  const scope = Array.isArray(safeTask.matchedScopes) && safeTask.matchedScopes.length > 0
    ? safeTask.matchedScopes[0]
    : 'repo';
  const lessonId = `lesson-${safeTask.taskId || 'unknown'}`;
  const title = limitText(safeTask.title || safeTask.prompt || safeTask.taskId || '', 72);
  const failureSummaries = failures.slice(0, 3).map((f) => normalizeFailureSummary(f?.summary || ''));
  const verbalSummary = limitText(
    `Task "${title}" failed ${failures.length} time(s). Top symptom: ${failureSummaries[0] || '(none)'}`,
    240
  );

  return {
    id: `reflection-${safeTask.taskId || 'unknown'}`,
    kind: 'reflection',
    scope,
    title: `Reflection - ${title}`,
    summary: verbalSummary,
    related_task: safeTask.taskId || '',
    related_failures: failureSummaries,
    linked_lesson: lessonId,
    verbal_summary: verbalSummary,
    confidence_of_fix: verifications.some((v) => v && v.success) ? 'medium' : 'low',
    status: 'draft'
  };
}

/**
 * evolveRelatedMemories — I/O. Delegates to memory-evolution.
 * Returns { evolved: [{ lessonId, proposal }], error?: string }.
 * The memoryEvolution + semanticStore modules are passed via `deps` so this
 * stays test-friendly without circular imports.
 *
 * @param {object} newLesson            lesson draft (from buildLessonDraft)
 * @param {object} opts
 *   - projectDir  required (for semantic-store lookups)
 *   - deps        { findNeighbors, applyEvolution, listLessons, upsertLesson }
 *   - threshold?  default 0.7
 *   - topN?       default 3
 */
export function evolveRelatedMemories(newLesson, opts = {}) {
  const { projectDir, deps, threshold = 0.7, topN = 3 } = opts;
  if (!projectDir || !deps) {
    return { evolved: [], error: 'missing_projectDir_or_deps' };
  }
  const { findNeighbors, applyEvolution, listLessons, upsertLesson } = deps;
  if (!findNeighbors || !applyEvolution || !listLessons || !upsertLesson) {
    return { evolved: [], error: 'missing_deps' };
  }

  const all = listLessons(projectDir);
  const neighbors = findNeighbors(newLesson, all, threshold, topN);
  const evolved = [];
  const nowIso = new Date().toISOString();
  for (const { lesson: neighbor } of neighbors) {
    const proposal = {
      neighborId: neighbor.id,
      evolvedAt: nowIso,
      addContext: `Linked from ${newLesson.id}`,
      note: ''
    };
    const updated = applyEvolution(neighbor, proposal);
    upsertLesson(projectDir, updated, { evolutionEnabled: false });
    evolved.push({ lessonId: neighbor.id, proposal });
  }
  return { evolved };
}

/**
 * LCS-based similarity between two surface-pattern arrays (Design-A O-2).
 * Returns a ratio [0..1] of longest common subsequence length over max length.
 */
function lcsRatio(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return 0;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      table[i][j] = a[i - 1] === b[j - 1]
        ? table[i - 1][j - 1] + 1
        : Math.max(table[i - 1][j], table[i][j - 1]);
    }
  }
  return table[a.length][b.length] / Math.max(a.length, b.length);
}

/**
 * distillProceduralMemory — filters task history and returns procedure drafts.
 *
 * Pattern detection: bucket tasks by a stable `surfacePattern` signature
 * (default: sorted detectedSurfaces[].surfaceType). A bucket becomes a
 * procedure draft when it contains >= repeatThreshold tasks inside the
 * windowDays window, AND their surface sequences share LCS ratio >= 0.5.
 *
 * @param {object[]} taskHistory       closed task records
 * @param {object}   [opts]
 *   - repeatThreshold: default 3
 *   - windowDays:      default 30
 *   - now:             Date (test injection)
 *   - similarityMin:   default 0.5
 * @returns {{ candidates: object[] }}
 */
export function distillProceduralMemory(taskHistory, opts = {}) {
  const {
    repeatThreshold = 3,
    windowDays = 30,
    now = new Date(),
    similarityMin = 0.5
  } = opts;
  const history = Array.isArray(taskHistory) ? taskHistory : [];
  if (history.length === 0) return { candidates: [] };

  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const cutoff = now.getTime() - windowMs;
  const recent = history.filter((task) => {
    const ts = new Date(task?.closedAt || task?.updatedAt || task?.createdAt || 0).getTime();
    return Number.isFinite(ts) && ts >= cutoff;
  });

  const buckets = new Map();
  for (const task of recent) {
    const surfaces = Array.isArray(task.detectedSurfaces) ? task.detectedSurfaces : [];
    const signature = uniqueStrings(surfaces.map((s) => String(s.surfaceType || s.type || '').trim()).filter(Boolean))
      .sort()
      .join('+');
    if (!signature) continue;
    const bucket = buckets.get(signature) || { signature, tasks: [], sequences: [] };
    bucket.tasks.push(task);
    bucket.sequences.push(
      surfaces.map((s) => String(s.surfaceType || s.type || '').trim()).filter(Boolean)
    );
    buckets.set(signature, bucket);
  }

  const candidates = [];
  for (const bucket of buckets.values()) {
    if (bucket.tasks.length < repeatThreshold) continue;

    // LCS cross-check: majority pair-wise similarity >= similarityMin.
    let pairs = 0, similarPairs = 0;
    for (let i = 0; i < bucket.sequences.length; i += 1) {
      for (let j = i + 1; j < bucket.sequences.length; j += 1) {
        pairs += 1;
        if (lcsRatio(bucket.sequences[i], bucket.sequences[j]) >= similarityMin) {
          similarPairs += 1;
        }
      }
    }
    if (pairs > 0 && similarPairs / pairs < 0.5) continue;

    const scope = bucket.tasks.find((t) => Array.isArray(t.matchedScopes) && t.matchedScopes.length > 0)
      ?.matchedScopes[0] || 'repo';
    const distilledFrom = bucket.tasks.map((t) => t.taskId).filter(Boolean);

    candidates.push({
      id: `procedure-${scope}-${bucket.signature.replace(/[^a-z0-9_-]/gi, '_')}`,
      kind: 'procedure',
      scope,
      title: `Procedure - ${bucket.signature} (${scope})`,
      summary: limitText(
        `Repeated ${bucket.tasks.length} time(s) in ${windowDays}d for ${scope} scope.`,
        180
      ),
      pattern_signature: bucket.signature,
      distilled_from_tasks: distilledFrom,
      confidence_after_n_uses: 0,
      access_count: 0,
      tokens: uniqueStrings(bucket.signature.split('+')),
      importance: 6,
      status: 'draft'
    });
  }

  return { candidates };
}

// ── CLI entry point ────────────────────────────────────────────────

function parseCurateArgs(argv) {
  const base = parseCliArgs(argv);
  const args = { ...base, publish: true };

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--no-publish') args.publish = false;
    if (argv[i] === '--force-publish') args.forcePublish = true;
  }

  return args;
}

const args = parseCurateArgs(process.argv.slice(2));
const currentFilePath = path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1'));
const invokedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : '';

if (currentFilePath === invokedFilePath) {
  const projectDir = path.resolve(args.projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  // When invoked directly, config must be provided by project wrapper
  // This CLI mode is mainly for testing the shared engine
  const result = curateTaskKnowledge(projectDir, {
    taskId: args.taskId,
    publish: args.publish,
    forcePublish: args.forcePublish
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
