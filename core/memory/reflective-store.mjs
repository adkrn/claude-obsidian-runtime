/**
 * L4 Reflective memory store.
 *
 * Backs `08_Reflections/Drafts/<date>_<taskId>_reflection.md` and the
 * retrieval index `.claude/runtime/knowledge/reflections.jsonl`.
 *
 * Each reflection is paired 1:1 with a lesson (`linked_lesson`) so the
 * Reflexion loop can surface "next-time rules" alongside their motivating
 * lesson at retrieval time (Design-A §3-D).
 */

import path from 'path';
import {
  appendJsonl,
  getRuntimePaths,
  loadJsonl,
  writeJsonlFile
} from '../runtime-lib.mjs';
import { ensureDir } from '../utils.mjs';

const REFLECTIONS_JSONL = 'reflections.jsonl';

function isoNow() {
  return new Date().toISOString();
}

function reflectionsPath(projectDir) {
  const { knowledgeRoot } = getRuntimePaths(projectDir);
  return path.join(knowledgeRoot, REFLECTIONS_JSONL);
}

function loadAll(projectDir) {
  return loadJsonl(reflectionsPath(projectDir));
}

function persistAll(projectDir, rows) {
  writeJsonlFile(reflectionsPath(projectDir), rows);
}

function normalizeReflection(reflection) {
  const now = isoNow();
  if (!reflection || !reflection.id) {
    throw new Error('reflective-store: reflection.id is required');
  }
  return {
    id: String(reflection.id),
    kind: 'reflection',
    title: String(reflection.title || '').trim(),
    summary: String(reflection.summary || '').trim(),
    sourceDoc: reflection.sourceDoc || '',
    scope: reflection.scope || 'repo',
    related_task: reflection.related_task || '',
    related_failures: Array.isArray(reflection.related_failures) ? reflection.related_failures : [],
    linked_lesson: reflection.linked_lesson || null,
    confidence_of_fix: reflection.confidence_of_fix || 'low',
    tokens: Array.isArray(reflection.tokens) ? reflection.tokens : [],
    importance: Number.isFinite(reflection.importance) ? reflection.importance : 6,
    last_accessed_at: reflection.last_accessed_at || now,
    access_count: Number.isFinite(reflection.access_count) ? reflection.access_count : 0,
    status: reflection.status || 'draft',
    created_at: reflection.created_at || now,
    updated_at: reflection.updated_at || now
  };
}

/**
 * @returns {{ ok: true, reflectionId: string, created: boolean }}
 */
export function upsertReflection(projectDir, reflection) {
  const normalized = normalizeReflection(reflection);
  const all = loadAll(projectDir);
  const idx = all.findIndex((row) => row?.id === normalized.id);
  let created = true;
  if (idx === -1) {
    all.push(normalized);
  } else {
    created = false;
    const existing = all[idx];
    all[idx] = {
      ...existing,
      ...normalized,
      created_at: existing.created_at || normalized.created_at,
      access_count: Math.max(existing.access_count || 0, normalized.access_count || 0)
    };
  }
  persistAll(projectDir, all);
  return { ok: true, reflectionId: normalized.id, created };
}

/**
 * Pair reflection -> lesson. Idempotent.
 * Returns { ok: false, reason: 'not_found' } when reflection doesn't exist.
 */
export function linkToLesson(projectDir, reflectionId, lessonId, nowIso = isoNow()) {
  if (!reflectionId || !lessonId) {
    return { ok: false, reason: 'missing_id' };
  }
  const all = loadAll(projectDir);
  const idx = all.findIndex((row) => row?.id === reflectionId);
  if (idx === -1) return { ok: false, reason: 'not_found' };
  const current = all[idx];
  if (current.linked_lesson === lessonId) {
    return { ok: true, reflectionId, lessonId, changed: false };
  }
  all[idx] = {
    ...current,
    linked_lesson: lessonId,
    updated_at: nowIso
  };
  persistAll(projectDir, all);
  return { ok: true, reflectionId, lessonId, changed: true };
}

export function listReflections(projectDir, filter = {}) {
  const rows = loadAll(projectDir);
  return rows.filter((row) => {
    if (!row) return false;
    if (filter.linkedLesson && row.linked_lesson !== filter.linkedLesson) return false;
    if (filter.relatedTask && row.related_task !== filter.relatedTask) return false;
    if (filter.status && row.status !== filter.status) return false;
    return true;
  });
}

export function appendReflectionRow(projectDir, reflection) {
  const normalized = normalizeReflection(reflection);
  const file = reflectionsPath(projectDir);
  ensureDir(path.dirname(file));
  appendJsonl(file, normalized);
  return { ok: true, reflectionId: normalized.id };
}
