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
 *
 * Frontmatter safeguard (DESIGN_MANUS_4B):
 *   - captureCheckpoint: SHA-256 of pre-evolution lesson byte (§4-A).
 *   - verifyFrontmatter11Fields: HANDOFF D-4 11-field parser/type/empty check (§5).
 *   - rollbackLesson: atomic byte-level restore via temp + rename (§6-B).
 *   - applyEvolutionWithSafeguard: wrapper that orchestrates capture → caller
 *     write → verify → rollback on FAIL (§7-A). E §8 reflection draft
 *     synthesis is the caller's responsibility — this module never re-implements
 *     buildReflectionDraft.
 */

import crypto from 'crypto';
import fs from 'fs';
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
 *
 * §7-B (DESIGN_MANUS_4B): when `lessonPathResolver` is provided, each in-place
 * mutation is wrapped by `applyEvolutionWithSafeguard` and the safeguard
 * results are returned alongside the existing `evolved` shape. Without the
 * resolver this function preserves the legacy contract (in-memory only).
 *
 * @param {object} newLesson
 * @param {object[]} allLessons
 * @param {object} [options]
 *   - threshold? : number
 *   - topN?      : number
 *   - nowIso?    : string
 *   - lessonPathResolver? : (lessonId) => string  // §7-B SSOT
 *   - persistLesson?      : (lesson)   => void    // §7-B caller's md write fn
 *   - onSafeguardEvent?   : (eventType, payload) => void  // WARN/FAIL hook
 *   - buildReflectionDraft? : (task) => object|null       // E §8 SSOT
 *   - writeReflectionDraft? : (draft, taskForDraft) => string|null  // returns relativePath
 * @returns {{ updated: Array<{lessonId, proposal}>, safeguardResults: object[] }
 *   | Array<{lessonId, proposal}>}
 *   Legacy callers (no resolver) keep the array shape; new callers receive
 *   `{ updated, safeguardResults }` so they can react to FAIL/WARN.
 */
export function evolveAgainst(newLesson, allLessons, options = {}) {
  const threshold = Number.isFinite(options.threshold) ? options.threshold : DEFAULT_SIMILARITY_THRESHOLD;
  const topN = Number.isFinite(options.topN) ? options.topN : DEFAULT_TOP_NEIGHBORS;
  const nowIso = options.nowIso || new Date().toISOString();
  const resolver = typeof options.lessonPathResolver === 'function'
    ? options.lessonPathResolver
    : null;
  const persistLesson = typeof options.persistLesson === 'function'
    ? options.persistLesson
    : null;
  const onEvent = typeof options.onSafeguardEvent === 'function'
    ? options.onSafeguardEvent
    : null;
  const buildDraft = typeof options.buildReflectionDraft === 'function'
    ? options.buildReflectionDraft
    : null;
  const writeDraft = typeof options.writeReflectionDraft === 'function'
    ? options.writeReflectionDraft
    : null;

  const neighbors = findNeighbors(newLesson, allLessons, threshold, topN);
  const updated = [];
  const safeguardResults = [];

  for (const { lesson } of neighbors) {
    const proposal = proposeEvolution(newLesson, lesson, nowIso);
    if (!proposal) continue;

    // Legacy path: no resolver → original in-place mutation only.
    if (!resolver) {
      applyEvolution(lesson, proposal);
      updated.push({ lessonId: getId(lesson), proposal });
      continue;
    }

    // §7-B path: wrap with safeguard. Caller (persistLesson) must write the
    // mutated lesson to disk synchronously between apply and verify.
    const lessonId = getId(lesson);
    const lessonPath = resolver(lessonId) || '';
    const guardResult = applyEvolutionWithSafeguard(lesson, proposal, lessonPath, {
      persistLesson,
      onEvent,
      buildReflectionDraft: buildDraft,
      writeReflectionDraft: writeDraft
    });
    safeguardResults.push(guardResult);
    if (guardResult.evolved) {
      updated.push({ lessonId, proposal });
    }
  }

  if (!resolver) return updated;
  return { updated, safeguardResults };
}

// ── DESIGN_MANUS_4B Frontmatter Safeguard ─────────────────────────

const REQUIRED_LESSON_FIELDS = Object.freeze([
  'id',
  'type',
  'scope',
  'title',
  'summary',
  'trigger_keywords',
  'applicable_when',
  'confidence',
  'importance',
  'related_task',
  'related_files'
]);

const CONFIDENCE_VALUES = Object.freeze(['high', 'medium', 'low']);

function sha256Full(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * §4-A — capture pre-evolution byte snapshot of a lesson md file.
 * Throws when the file is missing (caller must abort evolution).
 *
 * @param {string} lessonPath  absolute or vault-relative; caller resolves first
 * @param {string} lessonId
 * @returns {{ lessonId, lessonPath, originalBytes: Buffer, originalHash: string, checkpointAt: string }}
 */
export function captureCheckpoint(lessonPath, lessonId) {
  if (!lessonPath) {
    throw new Error('captureCheckpoint: lessonPath is required');
  }
  const originalBytes = fs.readFileSync(lessonPath);
  return {
    lessonId: String(lessonId || ''),
    lessonPath,
    originalBytes,
    originalHash: sha256Full(originalBytes),
    checkpointAt: new Date().toISOString()
  };
}

/**
 * §5-B — minimal YAML frontmatter parser sufficient for lesson md files.
 *
 * Only supports the subset emitted by lesson templates:
 *   - top-level scalars: `key: value`
 *   - quoted strings: `key: "value"` or `'value'`
 *   - flow arrays:    `key: [a, b]`
 *   - block arrays:
 *       key:
 *         - a
 *         - b
 *   - nested object (1 level deep, used by applicable_when):
 *       applicable_when:
 *         scope_id: repo
 *         path_glob:
 *           - foo
 *
 * Returns null when the doc has no `---` ... `---` block. Throws on a
 * malformed block (unterminated `---` or unparseable line).
 */
function parseFrontmatter(content) {
  const text = String(content || '');
  if (!text.startsWith('---')) return null;
  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== '---') return null;

  let endLine = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      endLine = i;
      break;
    }
  }
  if (endLine === -1) {
    throw new Error('frontmatter: unterminated --- block');
  }

  const frontLines = lines.slice(1, endLine);
  return parseYamlSubset(frontLines);
}

function parseYamlSubset(lines) {
  const out = {};
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    if (!raw || !raw.trim() || raw.trim().startsWith('#')) {
      i += 1;
      continue;
    }
    const indent = raw.length - raw.trimStart().length;
    if (indent !== 0) {
      // top-level only — orphan indented line indicates malformed block
      throw new Error(`frontmatter: unexpected indented top-level line: ${raw}`);
    }
    const colonIdx = raw.indexOf(':');
    if (colonIdx === -1) {
      throw new Error(`frontmatter: missing ':' on line: ${raw}`);
    }
    const key = raw.slice(0, colonIdx).trim();
    const rest = raw.slice(colonIdx + 1).trim();

    if (rest === '') {
      // could be block array OR nested object — peek ahead.
      const blockResult = parseBlockChild(lines, i + 1);
      out[key] = blockResult.value;
      i = blockResult.nextLine;
      continue;
    }

    out[key] = parseScalarOrFlow(rest);
    i += 1;
  }
  return out;
}

function parseBlockChild(lines, startLine) {
  // empty key body — accumulate either array (`- ...`) or object (`k: v`)
  let i = startLine;
  const childArray = [];
  const childObject = {};
  let mode = null; // 'array' | 'object' | null

  while (i < lines.length) {
    const raw = lines[i];
    if (!raw || !raw.trim() || raw.trim().startsWith('#')) {
      i += 1;
      continue;
    }
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) break;

    const trimmed = raw.trim();
    if (trimmed.startsWith('- ') || trimmed === '-') {
      if (mode === 'object') {
        throw new Error(`frontmatter: mixed array/object child at line: ${raw}`);
      }
      mode = 'array';
      childArray.push(parseScalarOrFlow(trimmed.slice(1).trim()));
      i += 1;
      continue;
    }

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) {
      throw new Error(`frontmatter: missing ':' on indented line: ${raw}`);
    }
    if (mode === 'array') {
      throw new Error(`frontmatter: mixed array/object child at line: ${raw}`);
    }
    mode = 'object';
    const childKey = trimmed.slice(0, colonIdx).trim();
    const childRest = trimmed.slice(colonIdx + 1).trim();
    if (childRest === '') {
      // nested-nested: only flat array support. Accumulate until indent drops.
      const nested = parseDeeperArray(lines, i + 1, indent);
      childObject[childKey] = nested.value;
      i = nested.nextLine;
      continue;
    }
    childObject[childKey] = parseScalarOrFlow(childRest);
    i += 1;
  }

  if (mode === 'array') return { value: childArray, nextLine: i };
  if (mode === 'object') return { value: childObject, nextLine: i };
  return { value: '', nextLine: i };
}

function parseDeeperArray(lines, startLine, parentIndent) {
  const arr = [];
  let i = startLine;
  while (i < lines.length) {
    const raw = lines[i];
    if (!raw || !raw.trim() || raw.trim().startsWith('#')) {
      i += 1;
      continue;
    }
    const indent = raw.length - raw.trimStart().length;
    if (indent <= parentIndent) break;
    const trimmed = raw.trim();
    if (!trimmed.startsWith('-')) {
      throw new Error(`frontmatter: deep nested non-array unsupported: ${raw}`);
    }
    arr.push(parseScalarOrFlow(trimmed.slice(1).trim()));
    i += 1;
  }
  return { value: arr, nextLine: i };
}

function parseScalarOrFlow(raw) {
  if (raw === '' || raw === null || raw === undefined) return '';
  // flow array: [a, b, c]
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((s) => parseScalarOrFlow(s.trim()));
  }
  // quoted strings
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  // booleans / null
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null' || raw === '~') return null;
  // numbers
  if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return Number.parseFloat(raw);
  return raw;
}

/**
 * §5-B/§5-C — verify HANDOFF D-4 11 lesson fields after evolution write.
 *
 * @param {string} content  full lesson md (frontmatter + body)
 * @returns {{ valid, missingFields, typeErrors, emptyFields }}
 *   - missingFields: undefined/null fields → FAIL
 *   - typeErrors:    type mismatches      → FAIL
 *   - emptyFields:   ""/[] (CD-M5 WARN)   → does not flip valid
 *   - parser throw:  missingFields=['<parse_error>'], valid=false
 */
export function verifyFrontmatter11Fields(content) {
  let frontmatter;
  try {
    frontmatter = parseFrontmatter(content);
  } catch {
    return {
      valid: false,
      missingFields: ['<parse_error>'],
      typeErrors: [],
      emptyFields: []
    };
  }
  if (!frontmatter || typeof frontmatter !== 'object') {
    return {
      valid: false,
      missingFields: ['<parse_error>'],
      typeErrors: [],
      emptyFields: []
    };
  }

  const missingFields = [];
  const typeErrors = [];
  const emptyFields = [];

  for (const name of REQUIRED_LESSON_FIELDS) {
    const value = frontmatter[name];
    if (value === undefined || value === null) {
      missingFields.push(name);
      continue;
    }
    const typeOk = checkFieldType(name, value, typeErrors);
    if (!typeOk) continue;
    if (isEmptyValue(name, value)) {
      emptyFields.push(name);
    }
  }

  return {
    valid: missingFields.length === 0 && typeErrors.length === 0,
    missingFields,
    typeErrors,
    emptyFields
  };
}

function checkFieldType(name, value, typeErrors) {
  const stringFields = new Set(['id', 'type', 'scope', 'title', 'summary', 'related_task']);
  const arrayFields = new Set(['trigger_keywords', 'related_files']);

  if (stringFields.has(name)) {
    if (typeof value !== 'string') {
      typeErrors.push(`${name}: expected string, got ${typeof value}`);
      return false;
    }
    return true;
  }
  if (arrayFields.has(name)) {
    if (!Array.isArray(value)) {
      typeErrors.push(`${name}: expected array, got ${typeof value}`);
      return false;
    }
    return true;
  }
  if (name === 'confidence') {
    if (typeof value !== 'string' || !CONFIDENCE_VALUES.includes(value)) {
      typeErrors.push(`${name}: expected one of ${CONFIDENCE_VALUES.join('|')}, got ${typeof value === 'string' ? value : typeof value}`);
      return false;
    }
    return true;
  }
  if (name === 'importance') {
    if (!Number.isFinite(value) || value < 1 || value > 10) {
      typeErrors.push(`${name}: expected number 1..10, got ${typeof value}`);
      return false;
    }
    return true;
  }
  if (name === 'applicable_when') {
    // string OR plain object — empty-string handled at empty-value step
    if (typeof value === 'string') return true;
    if (typeof value === 'object' && !Array.isArray(value)) return true;
    typeErrors.push(`${name}: expected string|object, got ${Array.isArray(value) ? 'array' : typeof value}`);
    return false;
  }
  return true;
}

function isEmptyValue(name, value) {
  if (typeof value === 'string') return value === '';
  if (Array.isArray(value)) return value.length === 0;
  if (name === 'applicable_when' && typeof value === 'object') {
    return value === null || Object.keys(value).length === 0;
  }
  return false;
}

/**
 * §6-B — atomic byte-level rollback. temp file + rename pattern.
 *
 * @param {object} checkpoint  result of captureCheckpoint
 * @param {string} reason      'verify_fail' | 'write_throw' | 'parser_throw'
 * @returns {{ ok, restoredHash, expectedHash, hashMatch, reason }}
 */
export function rollbackLesson(checkpoint, reason) {
  if (!checkpoint || !checkpoint.lessonPath || !checkpoint.originalBytes) {
    return {
      ok: false,
      restoredHash: '',
      expectedHash: checkpoint?.originalHash || '',
      hashMatch: false,
      reason: 'invalid_checkpoint'
    };
  }
  const tempPath = `${checkpoint.lessonPath}.rollback-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, checkpoint.originalBytes);
    fs.renameSync(tempPath, checkpoint.lessonPath);
  } catch (err) {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* ignore */ }
    return {
      ok: false,
      restoredHash: '',
      expectedHash: checkpoint.originalHash,
      hashMatch: false,
      reason: `rollback_write_failed: ${err.message}`
    };
  }

  let restoredBytes;
  try {
    restoredBytes = fs.readFileSync(checkpoint.lessonPath);
  } catch (err) {
    return {
      ok: false,
      restoredHash: '',
      expectedHash: checkpoint.originalHash,
      hashMatch: false,
      reason: `rollback_verify_read_failed: ${err.message}`
    };
  }
  const restoredHash = sha256Full(restoredBytes);
  return {
    ok: restoredHash === checkpoint.originalHash,
    restoredHash,
    expectedHash: checkpoint.originalHash,
    hashMatch: restoredHash === checkpoint.originalHash,
    reason: String(reason || '')
  };
}

/**
 * §7-A — wrapper around applyEvolution with byte-level safeguard.
 *
 * Order of operations:
 *   1. captureCheckpoint(lessonPath)
 *   2. applyEvolution(neighbor, proposal)               (in-memory mutation)
 *   3. opts.persistLesson(neighbor)                     (caller writes md)
 *   4. read lesson file → verifyFrontmatter11Fields
 *   5. valid → emit WARN if emptyFields.length > 0
 *      invalid → rollbackLesson + buildReflectionDraft (E §8 SSOT)
 *
 * @param {object} neighbor
 * @param {object} proposal
 * @param {string} lessonPath
 * @param {object} [opts]
 *   - persistLesson(lesson): void                       — caller writes md
 *   - onEvent(eventType, payload): void                 — WARN/FAIL hook
 *   - buildReflectionDraft(taskInput): object|null      — E §8 SSOT
 *   - writeReflectionDraft(draft, taskInput): string|null — returns relativePath
 * @returns {{
 *   ok, lessonId, evolved, verifyResult, rollbackResult, reflectionDraftPath
 * }}
 */
export function applyEvolutionWithSafeguard(neighbor, proposal, lessonPath, opts = {}) {
  const lessonId = getId(neighbor);
  const result = {
    ok: false,
    lessonId,
    evolved: false,
    verifyResult: { valid: false, missingFields: [], typeErrors: [], emptyFields: [] },
    rollbackResult: null,
    reflectionDraftPath: null
  };

  if (!lessonPath) {
    result.verifyResult.missingFields = ['<no_lesson_path>'];
    return result;
  }

  let checkpoint;
  try {
    checkpoint = captureCheckpoint(lessonPath, lessonId);
  } catch (err) {
    result.verifyResult.missingFields = [`<checkpoint_failed:${err.message}>`];
    return result;
  }

  applyEvolution(neighbor, proposal);

  let writeError = null;
  if (typeof opts.persistLesson === 'function') {
    try {
      opts.persistLesson(neighbor);
    } catch (err) {
      writeError = err;
    }
  }

  if (writeError) {
    const rollback = rollbackLesson(checkpoint, 'write_throw');
    result.rollbackResult = rollback;
    result.reflectionDraftPath = invokeReflectionDraft(opts, {
      lessonId,
      reason: 'write_throw',
      verifyResult: { ...result.verifyResult, missingFields: [`<write_throw:${writeError.message}>`] },
      checkpoint
    });
    if (typeof opts.onEvent === 'function') {
      opts.onEvent('frontmatter_fail', {
        lessonId,
        reason: 'write_throw',
        message: writeError.message,
        rollback
      });
    }
    return result;
  }

  let content;
  try {
    content = fs.readFileSync(lessonPath, 'utf8');
  } catch (err) {
    const rollback = rollbackLesson(checkpoint, 'parser_throw');
    result.rollbackResult = rollback;
    result.verifyResult = {
      valid: false,
      missingFields: [`<read_failed:${err.message}>`],
      typeErrors: [],
      emptyFields: []
    };
    result.reflectionDraftPath = invokeReflectionDraft(opts, {
      lessonId,
      reason: 'parser_throw',
      verifyResult: result.verifyResult,
      checkpoint
    });
    if (typeof opts.onEvent === 'function') {
      opts.onEvent('frontmatter_fail', { lessonId, reason: 'parser_throw', rollback });
    }
    return result;
  }

  const verify = verifyFrontmatter11Fields(content);
  result.verifyResult = verify;

  if (!verify.valid) {
    const reason = verify.missingFields.includes('<parse_error>') ? 'parser_throw' : 'verify_fail';
    const rollback = rollbackLesson(checkpoint, reason);
    result.rollbackResult = rollback;
    result.reflectionDraftPath = invokeReflectionDraft(opts, {
      lessonId,
      reason,
      verifyResult: verify,
      checkpoint
    });
    if (typeof opts.onEvent === 'function') {
      opts.onEvent('frontmatter_fail', { lessonId, reason, verify, rollback });
    }
    return result;
  }

  // valid path
  result.ok = true;
  result.evolved = true;
  if (verify.emptyFields.length > 0 && typeof opts.onEvent === 'function') {
    opts.onEvent('frontmatter_warn', {
      lessonId,
      emptyFields: verify.emptyFields
    });
  }
  return result;
}

function invokeReflectionDraft(opts, { lessonId, reason, verifyResult, checkpoint }) {
  if (typeof opts.buildReflectionDraft !== 'function') return null;
  const ts = checkpoint?.checkpointAt || new Date().toISOString();
  const taskInput = {
    taskId: `evolution-rollback-${lessonId}-${ts}`,
    title: `Frontmatter rollback: ${lessonId}`,
    matchedScopes: [],
    failures: [{
      summary: `evolution-applied frontmatter corrupt — missing/invalid: ${[
        ...(verifyResult.missingFields || []),
        ...(verifyResult.typeErrors || [])
      ].join(', ')}`,
      eventType: 'verification_failed',
      type: `frontmatter-validation-${reason}`,
      ts
    }],
    verifications: [{
      command: `verifyFrontmatter11Fields(${lessonId})`,
      success: false,
      summary: `frontmatter_11fields ${reason}: ${(verifyResult.missingFields || []).join(',')}`
    }]
  };
  let draft;
  try {
    draft = opts.buildReflectionDraft(taskInput);
  } catch {
    return null;
  }
  if (!draft) return null;
  if (typeof opts.writeReflectionDraft === 'function') {
    try {
      return opts.writeReflectionDraft(draft, taskInput) || null;
    } catch {
      return null;
    }
  }
  return null;
}
