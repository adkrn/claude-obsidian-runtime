/**
 * Shared context-resolver engine for Obsidian-Claude runtime.
 *
 * Provides project-neutral functions:
 *   - Route loading / note selection
 *   - Knowledge scoring
 *   - Guardrail building (with config injection)
 *
 * Project-specific wrappers own resolveRuntimeContext() and code discovery.
 */

import fs from 'fs';
import path from 'path';
import { limitText, loadJson, normalizePath } from './utils.mjs';
import {
  getRuntimePaths,
  loadJsonl,
  tokenizeSearchText,
  uniqueStrings
} from './runtime-lib.mjs';

// ── Route Loading & Note Selection ──────────────────────────────

export function loadContextRoutes(projectDir) {
  const routesPath = path.join(
    projectDir, 'document', 'obsidian_context', '_meta', 'context_routes.json'
  );
  return loadJson(routesPath, { always: [], groups: [], writeBack: {} });
}

function normalizeRouteText(value) {
  return String(value || '').toLowerCase();
}

function scoreRouteGroup(prompt, group) {
  let score = 0;
  for (const keyword of group.keywords || []) {
    if (!keyword) continue;
    if (prompt.includes(normalizeRouteText(keyword))) {
      score += keyword.length >= 6 ? 3 : 1;
    }
  }
  return score;
}

function uniqByPath(notes) {
  const seen = new Set();
  return notes.filter((note) => {
    if (!note?.path || seen.has(note.path)) return false;
    seen.add(note.path);
    return true;
  });
}

/**
 * Select context notes from routes based on prompt matching.
 *
 * @param {object} options
 * @param {object} options.routes - { always, groups, writeBack }
 * @param {string} options.prompt - user task text
 * @param {number} [options.maxGroups=3]
 * @param {number} [options.noteLimit=8]
 * @param {string} [options.contextRoot] - vault/mirror root for existence check
 * @returns {{ matchedGroups, notes, autoDiscovered }}
 */
export function selectContextNotes({ routes, prompt, maxGroups = 3, noteLimit = 8, contextRoot = '' }) {
  const normalizedPrompt = normalizeRouteText(prompt);
  const matchedGroups = (routes.groups || [])
    .map((group) => ({
      ...group,
      score: scoreRouteGroup(normalizedPrompt, group)
    }))
    .filter((group) => group.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, maxGroups);

  const notes = uniqByPath([
    ...(routes.always || []),
    ...matchedGroups.flatMap((group) => group.notes || [])
  ]);

  // Filter to notes that exist if contextRoot is provided
  const validNotes = contextRoot
    ? notes.filter((note) => {
      const notePath = path.join(contextRoot, ...note.path.split('/'));
      return fs.existsSync(notePath);
    })
    : notes;

  return {
    matchedGroups,
    notes: validNotes.slice(0, noteLimit),
    autoDiscovered: false
  };
}

// ── Knowledge Scoring ───────────────────────────────────────────

export function loadKnowledgeRows(projectDir, matchedScopes = []) {
  const runtimePaths = getRuntimePaths(projectDir);
  const knowledgeFiles = [
    path.join(runtimePaths.knowledgeRoot, 'lessons.jsonl'),
    path.join(runtimePaths.knowledgeRoot, 'troubleshooting.jsonl'),
    path.join(runtimePaths.knowledgeRoot, 'decisions.jsonl')
  ];
  const hasScopes = matchedScopes.length > 0;

  return knowledgeFiles
    .flatMap((filePath) => loadJsonl(filePath))
    .filter((row) => {
      if (!row || String(row.storage || '') === 'skipped' || row.duplicateOf) {
        return false;
      }
      if (hasScopes && row.scope && !matchedScopes.includes(row.scope)) {
        return false;
      }
      return true;
    });
}

export function scoreKnowledgeRow(row, promptTokens, matchedScopes, codeHits, hitCounts = {}) {
  if (!row) return null;

  const rowTokens = Array.isArray(row.tokens) ? row.tokens : [];
  const titleTokens = tokenizeSearchText(row.title || '');
  const relatedFiles = Array.isArray(row.relatedFiles) ? row.relatedFiles : [];
  const fileNameTokens = relatedFiles.flatMap((fp) => tokenizeSearchText(path.basename(String(fp))));
  const codePathTokens = codeHits.flatMap((hit) => tokenizeSearchText(hit.path));

  const tokenMatches = rowTokens.filter((t) => promptTokens.includes(t));
  const titleMatches = titleTokens.filter((t) => promptTokens.includes(t));
  const fileMatches = fileNameTokens.filter((t) =>
    promptTokens.includes(t) || codePathTokens.includes(t)
  );

  let score = 0;
  score += tokenMatches.length * 2;
  score += titleMatches.length * 3;
  score += Math.min(12, fileMatches.length * 3);

  // Code-hit path overlap bonus: relatedFiles that match current codeHits paths
  const codeHitPaths = codeHits.map((hit) => normalizePath(String(hit.path || '')));
  const relatedFileOverlap = relatedFiles.filter((rf) => {
    const normalized = normalizePath(String(rf));
    return codeHitPaths.some((cp) => cp === normalized || cp.endsWith(normalized) || normalized.endsWith(cp));
  });
  score += Math.min(8, relatedFileOverlap.length * 4);

  if (row.scope && matchedScopes.includes(row.scope)) {
    score += 4;
  }

  // Kind-specific boost
  const BUG_TOKENS = ['fix', 'bug', 'error', 'issue', '\uC2E4\uD328', '\uC5D0\uB7EC', '\uBC84\uADF8'];
  const ARCH_TOKENS = ['architecture', 'workflow', '\uAD6C\uC870', '\uC544\uD0A4\uD14D\uCC98', '\uC635\uC2DC\uB514\uC5B8', '\uD074\uB85C\uB4DC'];

  if (row.kind === 'troubleshooting' && promptTokens.some((t) => BUG_TOKENS.includes(t))) {
    score += 2;
  }
  if (row.kind === 'decision' && promptTokens.some((t) => ARCH_TOKENS.includes(t))) {
    score += 2;
  }
  if (promptTokens.some((t) => ['decision', '\uACB0\uC815'].includes(t)) && row.kind === 'decision') {
    score += 4;
  }
  if (promptTokens.some((t) => ['lesson', '\uAD50\uD6C8'].includes(t)) && row.kind === 'lesson') {
    score += 4;
  }
  if (promptTokens.some((t) => ['troubleshooting', '\uD2B8\uB7EC\uBE14\uC288\uD305'].includes(t)) && row.kind === 'troubleshooting') {
    score += 4;
  }

  // sourceDoc quality
  if (row.sourceDoc && !String(row.sourceDoc).includes('/Drafts/')) {
    score += 3;
  }

  // Recency boost
  if (row.updatedAt) {
    const ageMs = Date.now() - new Date(row.updatedAt).getTime();
    const FOURTEEN_DAYS = 14 * 24 * 60 * 60 * 1000;
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    if (ageMs <= FOURTEEN_DAYS) score += 3;
    else if (ageMs <= THIRTY_DAYS) score += 1;
  }

  // Hit count boost
  const rowHitCount = hitCounts[row.id]?.count || 0;
  if (rowHitCount > 0) {
    score += Math.min(20, rowHitCount);
  }

  // Quality boost
  const hasRelatedFiles = relatedFiles.length > 0;
  const hasRules = Array.isArray(row.rules) && row.rules.length > 0;
  if (hasRelatedFiles && hasRules) score += 3;

  // Multiplicative spread: hitCount가 높을수록 스코어 증폭 (max 2x)
  score = Math.round(score * (1 + Math.min(20, rowHitCount) * 0.05));

  if (score <= 0) return null;

  return {
    id: row.id || '',
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    sourceDoc: row.sourceDoc,
    scope: row.scope,
    score
  };
}

/**
 * Score and sort knowledge rows, returning top N.
 */
export function resolveKnowledgeHits(projectDir, { promptTokens, matchedScopes, codeHits, limit = 3 }) {
  const hitCountsPath = path.join(getRuntimePaths(projectDir).knowledgeRoot, 'hit-counts.json');
  const hitCounts = loadJson(hitCountsPath, {});

  return loadKnowledgeRows(projectDir, matchedScopes)
    .map((row) => scoreKnowledgeRow(row, promptTokens, matchedScopes, codeHits, hitCounts))
    .filter((scored) => scored && scored.score >= 5)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return String(a.sourceDoc || a.id || '').localeCompare(String(b.sourceDoc || b.id || ''));
    })
    .slice(0, limit);
}

// ── Guardrails ──────────────────────────────────────────────────

/**
 * Build context-aware guardrails from prompt tokens and matched groups.
 *
 * @param {string[]} promptTokens
 * @param {object[]} matchedGroups - groups with .id property
 * @param {string[]} matchedScopes
 * @param {object} [config]
 * @param {object} [config.groupGuardrails] - { groupId: [rule, ...] } map
 * @param {string[]} [config.extraRules] - additional rules to append (e.g. top lesson rules)
 * @returns {string[]}
 */
// 모든 task 에 무조건 박히는 세션 동작 지시(read_first 노트 읽고 계획하라).
// task-start 컨텍스트 주입(세션 가이드)에는 의미가 있으나, 산출물(worklog/lesson/
// troubleshooting)에 들어가면 보일러플레이트 노이즈다. 산출물 생성 시 isBoilerplateGuardrail
// 로 걸러낸다. (rebuild-lessons/runtime-doctor 도 이 문자열을 빈-lesson 판별 기준으로 사용 중.)
export const READ_FIRST_GUARDRAIL = 'read read_first notes before writing a plan';

/**
 * 산출물에서 제외해야 할 보일러플레이트 guardrail 인지 판정.
 * @param {string} rule
 * @returns {boolean}
 */
export function isBoilerplateGuardrail(rule) {
  return String(rule || '').trim() === READ_FIRST_GUARDRAIL;
}

export function buildGuardrails(promptTokens, matchedGroups, matchedScopes = [], config = {}) {
  const guardrails = [];

  guardrails.push(READ_FIRST_GUARDRAIL);

  const stemMatch = (tokens, stems) =>
    tokens.some((t) => stems.some((s) => t === s || t.startsWith(s)));

  if (stemMatch(promptTokens, ['eval', 'evaluate', 'score', 'quality', 'assess', 'report', '\uD3C9\uAC00', '\uC9C4\uB2E8'])) {
    guardrails.push('collect quantitative evidence before drawing conclusions');
  }
  if (stemMatch(promptTokens, ['refactor', 'clean', 'simplify', 'optimize', 'performance', '\uB9AC\uD329\uD130', '\uCD5C\uC801\uD654', '\uC131\uB2A5'])) {
    guardrails.push('verify existing tests pass before and after refactoring');
  }
  if (stemMatch(promptTokens, ['document', 'docs', 'readme', 'guide', 'spec', '\uBB38\uC11C'])) {
    guardrails.push('check existing documentation before creating new files');
  }
  if (promptTokens.some((t) => ['fix', 'bug', 'error', 'issue', '\uC2E4\uD328', '\uC5D0\uB7EC', '\uBC84\uADF8'].includes(t))) {
    guardrails.push('verify the failure mode before editing multiple files');
  }

  // Group-specific guardrails from config
  const groupGuardrails = config.groupGuardrails || {};
  for (const group of matchedGroups) {
    const extras = groupGuardrails[group.id];
    if (extras) {
      for (const rule of extras) {
        guardrails.push(rule);
      }
    }
  }

  // Extra rules (e.g. top lesson rules injected by project)
  if (Array.isArray(config.extraRules)) {
    for (const rule of config.extraRules) {
      guardrails.push(rule);
    }
  }

  return uniqueStrings(guardrails).slice(0, 6);
}

// ── Read-First Helpers ──────────────────────────────────────────

/**
 * Build readFirst + knowledgeReadFirst merged array.
 */
export function buildReadFirst(readFirst, knowledgeHits, contextRoot) {
  const existingReadPaths = new Set(readFirst.map((item) => item.path));
  const knowledgeReadFirst = knowledgeHits
    .filter((item) => item.sourceDoc && !existingReadPaths.has(item.sourceDoc))
    .map((item) => {
      const mirrorCandidate = path.join(contextRoot, ...String(item.sourceDoc).split('/'));
      const hasMirrorDoc = fs.existsSync(mirrorCandidate);
      return {
        path: item.sourceDoc,
        why: `runtime ${item.kind}: ${limitText(item.summary || item.title || '', 120)}`,
        mirrorPath: hasMirrorDoc
          ? normalizePath(path.join('document', 'obsidian_context', ...String(item.sourceDoc).split('/')))
          : ''
      };
    })
    .filter((item) => Boolean(item.mirrorPath));

  const combined = [...readFirst, ...knowledgeReadFirst];
  const seenPaths = new Set();
  return combined.filter((item) => {
    if (seenPaths.has(item.path)) return false;
    seenPaths.add(item.path);
    return true;
  }).slice(0, 8);
}
