#!/usr/bin/env node

/**
 * task-start CLI — starts a runtime task (or previews it with --dry-run).
 *
 * Contract (PATCH_Phase1 §3-A/B/C):
 *   Output JSON (last stdout line) contains the 9 mandatory fields:
 *     taskId, readFirst, codeHits, knowledgeHits, guardrails,
 *     matchedScopes, matchedGroups, currentTaskPath, lastContextPath
 *
 *   --dry-run skips all side effects:
 *     - .claude/runtime/current-task.json
 *     - .claude/runtime/tasks/<taskId>.json
 *     - .claude/runtime/events/*.jsonl
 *     - .claude/runtime/retrieval/last-context.json
 *     - obsidian-sync
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  parseCliArgs,
  tokenizeSearchText,
  toTaskPointer,
  writeSessionTaskPointer
} from '../core/runtime-lib.mjs';
import { createAndStartTask } from '../core/task-start-engine.mjs';
import {
  loadContextRoutes,
  selectContextNotes,
  resolveKnowledgeHits,
  buildGuardrails,
  buildReadFirst
} from '../core/context-resolver.mjs';
import { applyMMR, emitSortByPath } from '../core/memory/mmr.mjs';
import { scoreItems } from '../core/memory/retrieval-scoring.mjs';
import { improvedSimilarity, buildIdf, bm25Lite } from '../core/memory/similarity.mjs';
import { bumpHitCounts } from '../core/memory/hit-counts.mjs';
import { generateInitialTodoList, writeTodoFile } from '../core/todo-writer.mjs';
import { loadObsidianConfig } from '../core/obsidian-config.mjs';

// ── DESIGN_MANUS_C §6-B-1 — lesson MMR pipeline ─────────────────

function loadProjectManifest(projectDir) {
  try {
    const raw = fs.readFileSync(
      path.join(projectDir, '.claude', 'runtime-manifest.json'),
      'utf8'
    );
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function loadLessonRows(projectDir) {
  try {
    const file = path.join(projectDir, '.claude', 'runtime', 'knowledge', 'lessons.jsonl');
    const raw = fs.readFileSync(file, 'utf8');
    return raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * C §6-B-1 — lesson readFirst chain: scoreItems → filter -Inf → applyMMR → top-N → emitSortByPath.
 *
 * Returns supplementary readFirst entries (path/why/mirrorPath shape) sourced
 * from lessons.jsonl, ordered by path asc for cache-friendly emit. Empty array
 * when no lessons exist or none survive the gate.
 */
export function buildLessonReadFirst({
  projectDir,
  promptTokens,
  matchedScopes,
  candidatePaths,
  manifest,
  contextRoot,
  topN = 3,
  now
}) {
  const lessons = loadLessonRows(projectDir);
  if (lessons.length === 0) return [];

  const weights = manifest?.retrievalWeights || null;
  const lambda = Number.isFinite(manifest?.retrievalWeights?.diversityLambda)
    ? manifest.retrievalWeights.diversityLambda
    : undefined;
  const jaccardThreshold = Number.isFinite(manifest?.retrievalWeights?.diversityJaccardThreshold)
    ? manifest.retrievalWeights.diversityJaccardThreshold
    : undefined;

  // Phase A (G1) — lightweight relevance weights, overridable via manifest.
  // Only numeric overrides are forwarded; absent → similarity defaults.
  const similarityWeights = {};
  if (Number.isFinite(manifest?.retrievalWeights?.triggerKeywordWeight)) {
    similarityWeights.triggerKeywordWeight = manifest.retrievalWeights.triggerKeywordWeight;
  }
  if (Number.isFinite(manifest?.retrievalWeights?.trigramWeight)) {
    similarityWeights.trigramWeight = manifest.retrievalWeights.trigramWeight;
  }

  // Phase B (G2) — IDF over the lesson corpus, built ONCE per call. High-frequency
  // boilerplate tokens get low idf → suppressed; rare discriminating tokens win.
  // The relevanceFn closure captures this idf map (no per-item rescan).
  const { idf, avgdl, n } = buildIdf(lessons.map((l) => (Array.isArray(l.tokens) ? l.tokens : [])));
  const simOpts = { weights: similarityWeights, idf, avgdl, n, bm25: bm25Lite };

  // 1 + 2. F gate + 3-axis score (scoreItem handles both inside scoreItems).
  const ctx = {
    promptTokens,
    weights,
    candidatePaths,
    signalTokens: promptTokens,
    activeScopes: matchedScopes,
    gateMode: 'exclude',
    now: now instanceof Date ? now : new Date(),
    // Phase A+B seam: trigger_keywords (G1) + IDF-weighted base (G2) contribute
    // to the relevance score, not just the applicable_when gate. Jaccard is the
    // fallback only when no idf is supplied (e.g. empty corpus).
    relevanceFn: (item) => improvedSimilarity(ctx, item, simOpts)
  };
  const scored = scoreItems(lessons, ctx);

  // 3. Drop gate-excluded entries (-Infinity).
  const filtered = scored.filter((s) => Number.isFinite(s.score));
  if (filtered.length === 0) return [];

  // 4. MMR diversity penalty.
  const mmrApplied = applyMMR(filtered, { lambda, jaccardThreshold });

  // 5. top-N slice → emit-time path asc sort (cache-friendly).
  const top = mmrApplied.slice(0, topN);
  const items = top.map((entry) => entry.item);
  const ordered = emitSortByPath(items);

  return ordered.map((lesson) => {
    const sourcePath = lesson.sourceDoc || lesson.path || '';
    const mirrorCandidate = sourcePath
      ? path.join(contextRoot || '', ...String(sourcePath).split('/'))
      : '';
    const hasMirror = mirrorCandidate ? fs.existsSync(mirrorCandidate) : false;
    return {
      path: sourcePath,
      why: `lesson: ${(lesson.title || lesson.summary || '').slice(0, 120)}`,
      mirrorPath: hasMirror
        ? path.posix.join('document', 'obsidian_context', sourcePath)
        : '',
      lessonId: lesson.id || ''
    };
  }).filter((item) => item.path);
}

function defaultSyncVault() {
  // Lightweight no-op sync: task-start should never block on vault mirroring.
  // The real mirror refresh is owned by commands/obsidian-sync.mjs, invoked
  // explicitly from session hooks.
  return { ok: true, skipped: true, message: 'sync deferred to obsidian-sync hook' };
}

function defaultResolveContext({ projectDir, task, limit = 6 }) {
  const routes = loadContextRoutes(projectDir);
  const contextRoot = path.join(projectDir, 'document', 'obsidian_context');
  const { matchedGroups, notes } = selectContextNotes({
    routes,
    prompt: task,
    contextRoot
  });

  const promptTokens = tokenizeSearchText(task);
  const matchedScopes = Array.from(
    new Set(matchedGroups.flatMap((group) => group.scopes || []))
  );

  const codeHits = [];
  const knowledgeHits = resolveKnowledgeHits(projectDir, {
    promptTokens,
    matchedScopes,
    codeHits,
    limit
  });

  const baseReadFirst = notes.map((note) => ({
    path: note.path,
    why: note.why || '',
    mirrorPath: note.mirrorPath || ''
  }));
  const knowledgeReadFirst = buildReadFirst(baseReadFirst, knowledgeHits, contextRoot);

  // C §6-B-1 — supplementary lesson MMR chain (F gate → score → MMR → emit asc).
  const manifest = loadProjectManifest(projectDir);
  const candidatePaths = baseReadFirst
    .map((entry) => String(entry.path || '').replace(/\\/g, '/'))
    .filter(Boolean);
  const lessonReadFirst = buildLessonReadFirst({
    projectDir,
    promptTokens,
    matchedScopes,
    candidatePaths,
    manifest,
    contextRoot,
    topN: 3
  });

  // Merge + dedup by path, then emit path asc (D §5-C-1 / C §5-A-3 alignment).
  const seenPaths = new Set();
  const mergedReadFirst = [];
  for (const entry of [...knowledgeReadFirst, ...lessonReadFirst]) {
    if (!entry?.path || seenPaths.has(entry.path)) continue;
    seenPaths.add(entry.path);
    mergedReadFirst.push(entry);
  }
  const readFirst = emitSortByPath(mergedReadFirst).slice(0, 8);

  const guardrails = buildGuardrails(promptTokens, matchedGroups, matchedScopes);

  return {
    matchedScopes,
    matchedGroups: matchedGroups.map((group) => ({
      id: group.id,
      label: group.label || group.id,
      score: group.score || 0
    })),
    readFirst,
    knowledgeHits,
    codeHits,
    guardrails
  };
}

function printHelp() {
  process.stdout.write([
    'Usage: task-start --task <prompt> [--project-dir <path>] [--session-id <id>] [--dry-run]',
    '',
    'Options:',
    '  --task <prompt>         Task text (required)',
    '  --project-dir <path>    Project root (default: $CLAUDE_PROJECT_DIR or cwd)',
    '  --session-id <id>       Session identifier (optional)',
    '  --task-id <id>          Explicit task id (default: generated from prompt + timestamp)',
    '  --limit <n>             Max knowledge hits (default: 6)',
    '  --dry-run               Compute context without writing files or syncing',
    '  --help                  Show this help',
    ''
  ].join('\n'));
}

export function runTaskStart(argv) {
  const args = parseCliArgs(argv);

  if (!args.projectDir) {
    args.projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  }
  args.projectDir = path.resolve(args.projectDir);

  // hook 쉘이 --session-id "" (빈 값) 를 넘기는 케이스 대비: 빈 값이면 환경변수에서 복구.
  // 실제 환경변수명은 CLAUDE_SESSION_ID (이전엔 SESSION_ID 오타로 항상 fallback id 생성됨).
  if (!String(args.sessionId || '').trim()) {
    args.sessionId = process.env.CLAUDE_SESSION_ID || process.env.SESSION_ID || '';
  }

  return createAndStartTask(args, {
    syncVault: defaultSyncVault,
    resolveContext: defaultResolveContext,
    defaultScope: 'repo',
    afterWrite: ({ projectDir, sessionId, taskRecord, taskFilePath, runtimePaths }) => {
      // PRINCIPLES §6 — readFirst에 포함된 lesson의 hit-counts 누적
      // 3축 retrieval scoring 의 recency/importance 데이터 소스.
      // 실패해도 task 진행을 막지 않는다 (silent).
      try {
        bumpHitCounts(projectDir, taskRecord.readFirst || [], {
          taskId: taskRecord.taskId
        });
      } catch { /* non-critical */ }

      // DESIGN_MANUS_AG §6-A — emit Current_Todo.md from initial readFirst.
      // Silent skip when vault is unavailable; task creation still succeeds.
      try {
        const obsidianCfg = loadObsidianConfig(projectDir);
        const vaultRoot = obsidianCfg?.vaultAvailable ? obsidianCfg.vaultRoot : '';
        const initialTodos = generateInitialTodoList(
          taskRecord,
          taskRecord.readFirst || [],
          taskRecord.matchedScopes || []
        );
        writeTodoFile(projectDir, vaultRoot, {
          taskId: taskRecord.taskId,
          title: taskRecord.title || taskRecord.prompt || '',
          items: initialTodos
        });
      } catch { /* non-critical: never block task creation */ }

      // Bind the new task to this session so SessionStart on a different
      // session can't accidentally claim or close it via the global pointer.
      if (!sessionId) return;
      writeSessionTaskPointer(
        projectDir,
        sessionId,
        toTaskPointer(taskRecord, taskFilePath, runtimePaths.lastContextPath)
      );
    }
  });
}

// ── CLI Entrypoint ──────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const invokedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : '';

if (__filename === invokedFilePath) {
  const rawArgs = process.argv.slice(2);

  if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  if (!rawArgs.some((token) => token === '--task')) {
    process.stderr.write('[task-start] --task <prompt> is required\n');
    process.exit(2);
  }

  try {
    const result = runTaskStart(rawArgs);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (err) {
    process.stderr.write(`[task-start] ${err.message}\n`);
    process.exit(1);
  }
}
