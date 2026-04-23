/**
 * L3 Procedural memory store.
 *
 * Backs `09_Templates/Procedures/Drafts/<scope>_<pattern>.md` and the
 * retrieval index `.claude/runtime/knowledge/procedures.jsonl`.
 *
 * Triggered when same `surfacePattern` signature repeats >= 3 times within
 * 30 days (Memp / Design-A §3-E). Distillation is a learning-curate concern;
 * this module owns the storage contract only.
 */

import path from 'path';
import {
  appendJsonl,
  getRuntimePaths,
  loadJsonl,
  writeJsonlFile
} from '../runtime-lib.mjs';
import { ensureDir } from '../utils.mjs';

const PROCEDURES_JSONL = 'procedures.jsonl';

function isoNow() {
  return new Date().toISOString();
}

function proceduresPath(projectDir) {
  const { knowledgeRoot } = getRuntimePaths(projectDir);
  return path.join(knowledgeRoot, PROCEDURES_JSONL);
}

function loadAll(projectDir) {
  return loadJsonl(proceduresPath(projectDir));
}

function persistAll(projectDir, rows) {
  writeJsonlFile(proceduresPath(projectDir), rows);
}

function normalizeProcedure(procedure) {
  const now = isoNow();
  if (!procedure || !procedure.id) {
    throw new Error('procedural-store: procedure.id is required');
  }
  return {
    id: String(procedure.id),
    kind: 'procedure',
    title: String(procedure.title || '').trim(),
    summary: String(procedure.summary || '').trim(),
    sourceDoc: procedure.sourceDoc || '',
    scope: procedure.scope || 'repo',
    pattern_signature: procedure.pattern_signature || '',
    distilled_from_tasks: Array.isArray(procedure.distilled_from_tasks) ? procedure.distilled_from_tasks : [],
    confidence_after_n_uses: Number.isFinite(procedure.confidence_after_n_uses) ? procedure.confidence_after_n_uses : 0,
    access_count: Number.isFinite(procedure.access_count) ? procedure.access_count : 0,
    last_accessed_at: procedure.last_accessed_at || now,
    tokens: Array.isArray(procedure.tokens) ? procedure.tokens : [],
    importance: Number.isFinite(procedure.importance) ? procedure.importance : 6,
    status: procedure.status || 'draft',
    created_at: procedure.created_at || now,
    updated_at: procedure.updated_at || now
  };
}

/**
 * @param {string} projectDir
 * @param {object} [filter]
 *   - scope?: string
 *   - pattern?: string  // exact match against pattern_signature
 *   - status?: string
 * @returns {object[]}
 */
export function listProcedures(projectDir, filter = {}) {
  const rows = loadAll(projectDir);
  return rows.filter((row) => {
    if (!row) return false;
    if (filter.scope && row.scope !== filter.scope) return false;
    if (filter.pattern && row.pattern_signature !== filter.pattern) return false;
    if (filter.status && row.status !== filter.status) return false;
    return true;
  });
}

export function recordProcedureUse(projectDir, procedureId, nowIso = isoNow()) {
  if (!procedureId) return { ok: false, reason: 'missing_id' };
  const all = loadAll(projectDir);
  const idx = all.findIndex((row) => row?.id === procedureId);
  if (idx === -1) return { ok: false, reason: 'not_found' };
  const current = all[idx];
  all[idx] = {
    ...current,
    access_count: (Number.isFinite(current.access_count) ? current.access_count : 0) + 1,
    last_accessed_at: nowIso
  };
  persistAll(projectDir, all);
  return { ok: true, procedureId, access_count: all[idx].access_count };
}

export function upsertProcedure(projectDir, procedure) {
  const normalized = normalizeProcedure(procedure);
  const all = loadAll(projectDir);
  const idx = all.findIndex((row) => row?.id === normalized.id);
  if (idx === -1) {
    all.push(normalized);
  } else {
    const existing = all[idx];
    all[idx] = {
      ...existing,
      ...normalized,
      created_at: existing.created_at || normalized.created_at,
      access_count: Math.max(existing.access_count || 0, normalized.access_count || 0)
    };
  }
  persistAll(projectDir, all);
  return { ok: true, procedureId: normalized.id };
}

export function appendProcedureRow(projectDir, procedure) {
  const normalized = normalizeProcedure(procedure);
  const file = proceduresPath(projectDir);
  ensureDir(path.dirname(file));
  appendJsonl(file, normalized);
  return { ok: true, procedureId: normalized.id };
}
