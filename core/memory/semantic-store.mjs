/**
 * L2 Semantic memory store.
 *
 * Backs `08_Lessons/Drafts/<date>_<slug>.md` (frontmatter + body) and the
 * retrieval-side index `.claude/runtime/knowledge/lessons.jsonl`.
 *
 * Responsibilities:
 *   - upsertLesson: write/update lesson record (jsonl row + optional vault md)
 *   - touchAccess: bump last_accessed_at + access_count after a retrieval hit
 *   - computeImportance: confidence -> 1..10 mapping (Design-A §3-A fallback)
 *   - A-Mem evolution hook: on upsert, run evolveAgainst on existing rows and
 *     persist mutated neighbors back to the jsonl.
 *
 * Vault writes are best-effort: when vaultRoot is unavailable the lesson is
 * still recorded in the runtime jsonl so retrieval still works.
 */

import path from 'path';
import {
  appendJsonl,
  getRuntimePaths,
  loadJsonl,
  writeJsonlFile
} from '../runtime-lib.mjs';
import { ensureDir } from '../utils.mjs';
import { evolveAgainst } from './memory-evolution.mjs';

const LESSONS_JSONL = 'lessons.jsonl';

const CONFIDENCE_TO_IMPORTANCE = {
  high: 9,
  medium: 6,
  low: 3
};

function isoNow() {
  return new Date().toISOString();
}

/**
 * Normalize lesson `applicable_when` field (DESIGN_MANUS_F §6-A).
 *
 *   - null/undefined            → null
 *   - "" (empty string)         → null
 *   - non-empty string (legacy) → preserved as-is (gate handles via legacyString)
 *   - object                    → sub-field validated copy
 *   - other primitives/arrays   → null
 */
export function normalizeApplicableWhen(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    return value.length === 0 ? null : value;
  }
  if (typeof value !== 'object' || Array.isArray(value)) return null;

  const out = {};
  if (Array.isArray(value.path_glob)) {
    const arr = value.path_glob.filter((s) => typeof s === 'string' && s.length > 0);
    if (arr.length > 0) out.path_glob = arr;
  }
  if (Array.isArray(value.trigger_keywords)) {
    const arr = value.trigger_keywords.filter((s) => typeof s === 'string' && s.length > 0);
    if (arr.length > 0) out.trigger_keywords = arr;
  }
  if (typeof value.scope_id === 'string' && value.scope_id.length > 0) {
    out.scope_id = value.scope_id;
  } else if (Array.isArray(value.scope_id)) {
    const arr = value.scope_id.filter((s) => typeof s === 'string' && s.length > 0);
    if (arr.length > 0) out.scope_id = arr;
  }
  return out;
}

function lessonsPath(projectDir) {
  const { knowledgeRoot } = getRuntimePaths(projectDir);
  return path.join(knowledgeRoot, LESSONS_JSONL);
}

function loadAllLessons(projectDir) {
  return loadJsonl(lessonsPath(projectDir));
}

function persistAllLessons(projectDir, rows) {
  writeJsonlFile(lessonsPath(projectDir), rows);
}

/**
 * confidence → importance fallback (Design-A §3-A).
 * Caller may override by passing an explicit `importance` field on the lesson.
 */
export function computeImportance(lesson) {
  if (!lesson || typeof lesson !== 'object') return 6;
  if (Number.isFinite(lesson.importance) && lesson.importance >= 1 && lesson.importance <= 10) {
    return Math.round(lesson.importance);
  }
  const key = String(lesson.confidence || '').toLowerCase();
  if (key in CONFIDENCE_TO_IMPORTANCE) {
    return CONFIDENCE_TO_IMPORTANCE[key];
  }
  return 6;
}

function normalizeLesson(lesson) {
  const now = isoNow();
  const next = {
    id: String(lesson.id || ''),
    kind: 'lesson',
    title: String(lesson.title || '').trim(),
    summary: String(lesson.summary || '').trim(),
    sourceDoc: lesson.sourceDoc || '',
    scope: lesson.scope || 'repo',
    tokens: Array.isArray(lesson.tokens) ? lesson.tokens : [],
    importance: computeImportance(lesson),
    last_accessed_at: lesson.last_accessed_at || now,
    access_count: Number.isFinite(lesson.access_count) ? lesson.access_count : 0,
    linked_reflection: lesson.linked_reflection || null,
    evolved_at: Array.isArray(lesson.evolved_at) ? lesson.evolved_at : [],
    duplicateOf: lesson.duplicateOf || null,
    created_at: lesson.created_at || now,
    updated_at: lesson.updated_at || now,
    confidence: lesson.confidence || 'medium',
    trigger_keywords: Array.isArray(lesson.trigger_keywords) ? lesson.trigger_keywords : [],
    applicable_when: normalizeApplicableWhen(lesson.applicable_when),
    related_task: lesson.related_task || '',
    related_files: Array.isArray(lesson.related_files) ? lesson.related_files : [],
    status: lesson.status || 'draft'
  };
  if (!next.id) {
    throw new Error('semantic-store.upsertLesson: lesson.id is required');
  }
  return next;
}

/**
 * @param {string} projectDir
 * @param {object} lesson - LessonRecord (Design-A §3-A / §3-F)
 * @param {object} [options]
 *   - evolutionEnabled?: boolean (default true)
 *   - evolutionThreshold?: number (default 0.7)
 *   - evolutionTopN?: number (default 3)
 * @returns {{ ok: true, lessonId: string, evolved: Array<{lessonId,proposal}> }}
 */
export function upsertLesson(projectDir, lesson, options = {}) {
  const normalized = normalizeLesson(lesson);
  const all = loadAllLessons(projectDir);
  const idx = all.findIndex((row) => row?.id === normalized.id);

  let evolved = [];
  if (options.evolutionEnabled !== false && idx === -1) {
    evolved = evolveAgainst(normalized, all, {
      threshold: options.evolutionThreshold,
      topN: options.evolutionTopN,
      nowIso: normalized.updated_at
    });
  }

  if (idx === -1) {
    all.push(normalized);
  } else {
    const existing = all[idx];
    all[idx] = {
      ...existing,
      ...normalized,
      created_at: existing.created_at || normalized.created_at,
      access_count: Math.max(existing.access_count || 0, normalized.access_count || 0),
      evolved_at: existing.evolved_at?.length
        ? existing.evolved_at
        : normalized.evolved_at
    };
  }

  persistAllLessons(projectDir, all);

  return { ok: true, lessonId: normalized.id, evolved };
}

/**
 * Bump retrieval metadata after a hit.
 * Idempotent — caller may call repeatedly per session.
 */
export function touchAccess(projectDir, lessonId, nowIso = isoNow()) {
  if (!lessonId) return { ok: false, reason: 'missing_id' };
  const all = loadAllLessons(projectDir);
  const idx = all.findIndex((row) => row?.id === lessonId);
  if (idx === -1) return { ok: false, reason: 'not_found' };
  const current = all[idx];
  all[idx] = {
    ...current,
    last_accessed_at: nowIso,
    access_count: (Number.isFinite(current.access_count) ? current.access_count : 0) + 1
  };
  persistAllLessons(projectDir, all);
  return { ok: true, lessonId, access_count: all[idx].access_count };
}

/**
 * Append-only insert into a per-project jsonl with no merging.
 * Used by knowledge-index-build for full reindex.
 */
export function appendLessonRow(projectDir, lesson) {
  const normalized = normalizeLesson(lesson);
  const file = lessonsPath(projectDir);
  ensureDir(path.dirname(file));
  appendJsonl(file, normalized);
  return { ok: true, lessonId: normalized.id };
}

export function listLessons(projectDir) {
  return loadAllLessons(projectDir);
}

export function findLesson(projectDir, lessonId) {
  if (!lessonId) return null;
  return loadAllLessons(projectDir).find((row) => row?.id === lessonId) || null;
}
