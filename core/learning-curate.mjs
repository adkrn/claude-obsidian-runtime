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

// ── Constants ──────────────────────────────────────────────────────

const KNOWLEDGE_INDEX_FILES = {
  lesson: 'lessons.jsonl',
  troubleshooting: 'troubleshooting.jsonl',
  decision: 'decisions.jsonl'
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

function buildLessonCandidate({ task, scope, dateStamp, config }) {
  const files = collectImportantFiles(task);
  const verifications = collectVerificationSummary(task);
  const rules = buildLessonRules(task, scope, config);
  const projectTag = config?.projectTag || 'project';
  const summary = files.length > 0
    ? `Changed ${files.length} file(s) in ${scope} scope with ${verifications.all.length} verification record(s).`
    : `Captured reusable workflow guidance for ${scope} scope.`;

  return {
    kind: 'lesson',
    id: buildCandidateId('lesson', task.taskId),
    scope,
    title: `Lesson - ${limitText(task.title || task.prompt || task.taskId, 72)}`,
    summary,
    relatedFiles: files,
    rules,
    relativePath: buildRelativeDocPath('lesson', scope, dateStamp, task.taskId, config),
    content: `---
title: Auto Lesson ${dateStamp} (${task.taskId})
date: ${dateStamp}
task_id: ${task.taskId}
type: lesson
status: draft
scope: ${scope}
tags: [${projectTag}, ${scope}, lesson, runtime-memory]
generated_by: runtime-learning-curate
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
${formatMarkdownList((task.guardrails || []).slice(0, 4))}
`
  };
}

function buildDecisionCandidate({ task, scope, dateStamp, config }) {
  if (!shouldCreateDecision(task, scope, config)) return null;

  const scopeFn = config?.inferScope || inferScopeFromPath;
  const projectTag = config?.projectTag || 'project';
  const files = collectImportantFiles(task).filter((f) => scopeFn(f) === 'workflow');
  const rules = buildLessonRules(task, scope, config);
  const decisionStatement = scope === 'workflow'
    ? 'Keep runtime memory in compact repo-local indexes and publish curated docs only at task close or session end.'
    : 'Document architecture and workflow changes as explicit decisions when they alter the operating path.';

  return {
    kind: 'decision',
    id: buildCandidateId('decision', task.taskId),
    scope,
    title: `Decision - ${limitText(task.title || task.prompt || task.taskId, 72)}`,
    summary: decisionStatement,
    relatedFiles: files,
    rules,
    relativePath: buildRelativeDocPath('decision', scope, dateStamp, task.taskId, config),
    content: `---
title: Auto Decision ${dateStamp} (${task.taskId})
date: ${dateStamp}
task_id: ${task.taskId}
type: decision
status: draft
scope: ${scope}
tags: [${projectTag}, ${scope}, decision, runtime-memory]
generated_by: runtime-learning-curate
${buildKnowledgeMetadataFrontmatter(files, config)}---

# Context
- task: \`${limitText(task.title || task.prompt || task.taskId, 120).replace(/`/g, "'")}\`
- primary scope: \`${scope}\`

# Decision
- ${decisionStatement}

# Why
${formatMarkdownList(
  [
    ...rules,
    ...(files.length > 0 ? ['The workflow touched concrete hook/script files, so the operating path should be written down explicitly.'] : [])
  ].slice(0, 4)
)}

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

function upsertKnowledgeRow(projectDir, kind, nextRow) {
  const runtimePaths = getRuntimePaths(projectDir);
  const targetPath = path.join(runtimePaths.knowledgeRoot, KNOWLEDGE_INDEX_FILES[kind]);
  const rows = loadJsonl(targetPath)
    .filter((r) => r?.id !== nextRow.id)
    .concat(nextRow)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  writeJsonlFile(targetPath, rows);
  return targetPath;
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

  const candidates = [
    buildTroubleshootingCandidate({ task, scope: primaryScope, dateStamp, config }),
    buildLessonCandidate({ task, scope: primaryScope, dateStamp, config }),
    buildDecisionCandidate({ task, scope: primaryScope, dateStamp, config })
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
    upsertKnowledgeRow(projectDir, candidate.kind, row);

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
