// hit-counts.mjs — readFirst에 진입한 lesson의 카운트 누적 + 마지막 hit timestamp 기록
// PRINCIPLES §6 (3축 retrieval scoring) recency/importance 축의 데이터 소스.
// 형식: { [lessonId]: { count: number, lastHitAt: ISOString, lastTaskId: string } }

import fs from 'node:fs';
import path from 'node:path';

const HIT_COUNTS_REL = ['knowledge', 'hit-counts.json'];

function hitCountsPath(projectDir) {
  return path.join(projectDir, '.claude', 'runtime', ...HIT_COUNTS_REL);
}

function readJsonSafe(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

/**
 * readFirst entries에서 lesson id를 뽑아 hit-counts.json을 갱신한다.
 * - readFirst entry는 { path, why, mirrorPath, lessonId? } 형태
 * - lessonId 가 없는 일반 note는 스킵
 *
 * @param {string} projectDir
 * @param {Array<{lessonId?: string}>} readFirst
 * @param {{ taskId?: string, now?: Date }} [options]
 * @returns {{ incremented: string[], skipped: number }}
 */
export function bumpHitCounts(projectDir, readFirst, options = {}) {
  const lessonIds = (readFirst || [])
    .map((entry) => entry?.lessonId)
    .filter((id) => typeof id === 'string' && id.length > 0);

  if (lessonIds.length === 0) return { incremented: [], skipped: 0 };

  const file = hitCountsPath(projectDir);
  const data = readJsonSafe(file);
  const now = (options.now instanceof Date ? options.now : new Date()).toISOString();
  const taskId = options.taskId || '';

  const incremented = [];
  for (const id of lessonIds) {
    const prev = data[id];
    const prevCount = (prev && typeof prev === 'object' && typeof prev.count === 'number')
      ? prev.count
      : (typeof prev === 'number' ? prev : 0);
    data[id] = {
      count: prevCount + 1,
      lastHitAt: now,
      lastTaskId: taskId
    };
    incremented.push(id);
  }

  try {
    ensureDir(file);
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch {
    // hit-counts 갱신 실패는 task 진행을 막지 않는다. silent skip.
    return { incremented: [], skipped: lessonIds.length, error: true };
  }

  return { incremented, skipped: 0 };
}

/**
 * lesson id의 현재 hit count 조회. retrieval-scoring importance 보강에 사용.
 */
export function getHitCount(projectDir, lessonId) {
  const data = readJsonSafe(hitCountsPath(projectDir));
  const entry = data[lessonId];
  if (!entry) return { count: 0, lastHitAt: null, lastTaskId: '' };
  if (typeof entry === 'number') return { count: entry, lastHitAt: null, lastTaskId: '' };
  return {
    count: entry.count || 0,
    lastHitAt: entry.lastHitAt || null,
    lastTaskId: entry.lastTaskId || ''
  };
}

export function loadHitCounts(projectDir) {
  return readJsonSafe(hitCountsPath(projectDir));
}
