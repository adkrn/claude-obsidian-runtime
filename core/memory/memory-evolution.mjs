/**
 * A-Mem style memory evolution (Xu 2025, NeurIPS).
 *
 * Pure rule-based evolution — no LLM call (Design-A §Z-3-A A-2).
 *
 * Algorithm:
 *   1) For a new lesson L_new, compute jaccard similarity vs each existing lesson.
 *   2) Keep neighbors with similarity >= threshold (default 0.7), top-3.
 *   3) Propose evolution = append `evolved_at` entry to neighbor frontmatter
 *      (rule-based fallback; LLM gating is deferred).
 *   4) `applyEvolution` mutates the neighbor in-place — git diff preserves history.
 *
 * Side effect surface is intentionally limited: this module only proposes /
 * applies evolution to in-memory lesson records. The caller (semantic-store)
 * is responsible for persisting the updated record back to disk.
 */

import { jaccardSimilarity } from './retrieval-scoring.mjs';

export const DEFAULT_SIMILARITY_THRESHOLD = 0.7;
export const DEFAULT_TOP_NEIGHBORS = 3;

function getTokens(record) {
  if (!record || typeof record !== 'object') return [];
  return Array.isArray(record.tokens) ? record.tokens : [];
}

function getId(record) {
  if (!record || typeof record !== 'object') return '';
  return String(record.id || '');
}

/**
 * @param {object} newLesson  - { id, tokens: string[] }
 * @param {object[]} allLessons
 * @param {number} [threshold=0.7]
 * @param {number} [topN=3]
 * @returns {Array<{ lesson: object, similarity: number }>}
 */
export function findNeighbors(newLesson, allLessons, threshold = DEFAULT_SIMILARITY_THRESHOLD, topN = DEFAULT_TOP_NEIGHBORS) {
  if (!newLesson || typeof newLesson !== 'object') return [];
  const newTokens = getTokens(newLesson);
  const newId = getId(newLesson);
  if (!Array.isArray(allLessons) || allLessons.length === 0) return [];
  if (newTokens.length === 0) return [];

  const candidates = [];
  for (const candidate of allLessons) {
    if (!candidate || typeof candidate !== 'object') continue;
    if (newId && getId(candidate) === newId) continue;
    const similarity = jaccardSimilarity(newTokens, getTokens(candidate));
    if (similarity >= threshold) {
      candidates.push({ lesson: candidate, similarity });
    }
  }

  candidates.sort((left, right) => right.similarity - left.similarity);
  return candidates.slice(0, topN);
}

/**
 * Build an evolution proposal — append-only frontmatter mutation.
 *
 * Returns null when proposal is rejected (e.g. duplicate evolution from same
 * source). Caller can always inspect `proposal.changes` to see what would
 * change before applying.
 */
export function proposeEvolution(newLesson, neighbor, nowIso = new Date().toISOString()) {
  if (!neighbor || typeof neighbor !== 'object') return null;
  const newId = getId(newLesson);
  if (!newId) return null;

  const existing = Array.isArray(neighbor.evolved_at) ? neighbor.evolved_at : [];
  const alreadyRecorded = existing.some((entry) => entry?.from_lesson === newId);
  if (alreadyRecorded) {
    return null;
  }

  const entry = { at: nowIso, from_lesson: newId };
  return {
    neighborId: getId(neighbor),
    fromLessonId: newId,
    changes: { evolved_at_append: entry },
    appliedAt: nowIso
  };
}

/**
 * Mutate the neighbor record in place — caller persists result.
 *
 * Append-only: never rewrites historical evolved_at entries, never renames
 * the file (Design-A §Z-3-A A-2 / O-7: in-place write only).
 */
export function applyEvolution(neighbor, proposal) {
  if (!neighbor || typeof neighbor !== 'object') return neighbor;
  if (!proposal || typeof proposal !== 'object') return neighbor;
  const append = proposal.changes?.evolved_at_append;
  if (!append) return neighbor;

  const existing = Array.isArray(neighbor.evolved_at) ? neighbor.evolved_at : [];
  neighbor.evolved_at = [...existing, append];
  neighbor.updated_at = proposal.appliedAt || new Date().toISOString();
  return neighbor;
}

/**
 * Convenience helper — find neighbors, propose, apply.
 * Returns the list of (mutated) neighbor records that actually changed.
 */
export function evolveAgainst(newLesson, allLessons, options = {}) {
  const threshold = Number.isFinite(options.threshold) ? options.threshold : DEFAULT_SIMILARITY_THRESHOLD;
  const topN = Number.isFinite(options.topN) ? options.topN : DEFAULT_TOP_NEIGHBORS;
  const nowIso = options.nowIso || new Date().toISOString();

  const neighbors = findNeighbors(newLesson, allLessons, threshold, topN);
  const updated = [];
  for (const { lesson } of neighbors) {
    const proposal = proposeEvolution(newLesson, lesson, nowIso);
    if (!proposal) continue;
    applyEvolution(lesson, proposal);
    updated.push({ lessonId: getId(lesson), proposal });
  }
  return updated;
}
