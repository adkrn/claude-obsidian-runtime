// pointer-gc.mjs — orphan current-task-<sessionId>.json 정리
// 기준:
//   - mtime 이 maxIdleDays 일 이상 묵음
//   - 그동안 events 에서 해당 sessionId 의 활동 흔적 없음
//   - 가리키는 task record 가 이미 closed 상태
// 동작: 삭제 X. archive/orphan-pointers/<filename>-<unixms> 로 이동.
// PRINCIPLES §7-quater "자동 삭제 X" 원칙 준수.

import fs from 'node:fs';
import path from 'node:path';

const POINTER_REGEX = /^current-task-([0-9a-fA-F-]{8,})\.json$/;

function runtimeDir(projectDir) {
  return path.join(projectDir, '.claude', 'runtime');
}

function listPointers(rDir) {
  let entries;
  try { entries = fs.readdirSync(rDir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((n) => POINTER_REGEX.test(n));
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function parseSessionId(filename) {
  const m = filename.match(POINTER_REGEX);
  return m ? m[1] : '';
}

/**
 * 최근 N일치 events 파일에서 발견된 session_id 들을 모은다.
 */
function loadRecentSessionIds(rDir, windowDays) {
  const eventsDir = path.join(rDir, 'events');
  const cutoffMs = Date.now() - windowDays * 86400000;
  let files;
  try { files = fs.readdirSync(eventsDir); } catch { return new Set(); }
  const ids = new Set();
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const full = path.join(eventsDir, f);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.mtimeMs < cutoffMs) continue;
    let raw;
    try { raw = fs.readFileSync(full, 'utf8'); } catch { continue; }
    for (const ln of raw.split('\n')) {
      if (!ln) continue;
      try {
        const ev = JSON.parse(ln);
        const sid = ev?.detail?.sessionId || ev?.sessionId || ev?.session_id;
        if (sid && typeof sid === 'string') ids.add(sid);
      } catch {}
    }
  }
  return ids;
}

function isTaskClosed(rDir, pointer) {
  if (!pointer?.taskId) return true;
  const taskFile = path.join(rDir, 'tasks', `${pointer.taskId}.json`);
  const rec = readJsonSafe(taskFile);
  if (!rec) return true;  // task record 자체가 없으면 orphan
  return rec.status === 'closed' || rec.status === 'done';
}

/**
 * Orphan pointer GC.
 *
 * @param {string} projectDir
 * @param {object} options
 * @param {string} [options.activeSessionId] — 현재 세션 (보호 대상, 절대 건드리지 않음)
 * @param {number} [options.maxIdleDays] — 이 일수 이상 묵은 것만 후보 (default 7)
 * @param {number} [options.activitySearchDays] — events 활동 검색 윈도우 (default 14)
 * @param {Date} [options.now]
 * @returns {{ archived: string[], kept: string[], skipped: string[] }}
 */
export function gcOrphanPointers(projectDir, options = {}) {
  const rDir = runtimeDir(projectDir);
  if (!fs.existsSync(rDir)) return { archived: [], kept: [], skipped: [] };

  const activeSessionId = options.activeSessionId || '';
  const maxIdleDays = Number.isFinite(options.maxIdleDays) ? options.maxIdleDays : 7;
  const activitySearchDays = Number.isFinite(options.activitySearchDays) ? options.activitySearchDays : 14;
  const now = (options.now instanceof Date ? options.now : new Date()).getTime();
  const cutoffMs = now - maxIdleDays * 86400000;

  const pointers = listPointers(rDir);
  if (pointers.length === 0) return { archived: [], kept: [], skipped: [] };

  const recentSessions = loadRecentSessionIds(rDir, activitySearchDays);

  const archived = [], kept = [], skipped = [];
  const archiveDir = path.join(rDir, 'archive', 'orphan-pointers');

  for (const f of pointers) {
    const full = path.join(rDir, f);
    const sid = parseSessionId(f);

    if (sid && sid === activeSessionId) {
      kept.push(f);  // 현재 세션 - 절대 건드리지 않음
      continue;
    }

    let stat;
    try { stat = fs.statSync(full); } catch { skipped.push(f); continue; }

    if (stat.mtimeMs >= cutoffMs) {
      kept.push(f);  // 너무 최근 — 유예
      continue;
    }

    if (sid && recentSessions.has(sid)) {
      kept.push(f);  // 최근 활동 있던 세션 — 보호
      continue;
    }

    const pointer = readJsonSafe(full);
    if (!isTaskClosed(rDir, pointer)) {
      kept.push(f);  // task 아직 열림 — 보호 (task-close가 닫아줄 때까지)
      continue;
    }

    // archive 로 이동
    try {
      fs.mkdirSync(archiveDir, { recursive: true });
      const dest = path.join(archiveDir, `${f}.${stat.mtimeMs}`);
      fs.renameSync(full, dest);
      archived.push(f);
    } catch {
      skipped.push(f);
    }
  }

  return { archived, kept, skipped };
}
