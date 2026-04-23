/**
 * L1 Episodic memory store.
 *
 * Wraps `.claude/runtime/events/<date>.jsonl` — append-only, scope-tagged
 * structured events emitted by learning-capture.
 *
 * This module owns the *read/write* contract for events; learning-capture
 * remains the producer (Design-A §1-C: "events.jsonl 규약 유지, 래퍼만 추가").
 *
 * Filtering happens in JS (events are small; per-day files keep range scans
 * cheap enough for current scale).
 */

import fs from 'fs';
import path from 'path';
import {
  appendJsonl,
  getEventFilePath,
  getRuntimePaths,
  loadJsonl
} from '../runtime-lib.mjs';

function isoNow() {
  return new Date().toISOString();
}

function listEventFiles(eventsRoot) {
  if (!fs.existsSync(eventsRoot)) return [];
  try {
    return fs
      .readdirSync(eventsRoot)
      .filter((entry) => /\.jsonl$/i.test(entry))
      .sort();
  } catch {
    return [];
  }
}

function matchesFilter(event, filter) {
  if (!event || typeof event !== 'object') return false;
  if (filter.scope && event.scope !== filter.scope) return false;
  if (filter.eventType) {
    const types = Array.isArray(filter.eventType) ? filter.eventType : [filter.eventType];
    if (!types.includes(event.eventType)) return false;
  }
  if (filter.taskId && event.taskId !== filter.taskId) return false;
  if (filter.sinceIso) {
    const since = Date.parse(filter.sinceIso);
    const ts = Date.parse(event.ts || '');
    if (Number.isFinite(since) && Number.isFinite(ts) && ts < since) return false;
  }
  if (filter.untilIso) {
    const until = Date.parse(filter.untilIso);
    const ts = Date.parse(event.ts || '');
    if (Number.isFinite(until) && Number.isFinite(ts) && ts > until) return false;
  }
  return true;
}

/**
 * @param {string} projectDir
 * @param {object} event - episodic event payload (Design-A §3-C)
 * @returns {{ ok: true, file: string, ts: string }}
 */
export function append(projectDir, event = {}) {
  const ts = event.ts || isoNow();
  const payload = { ts, ...event };
  if (!payload.ts) payload.ts = ts;
  const target = getEventFilePath(projectDir, new Date(payload.ts));
  appendJsonl(target, payload);
  return { ok: true, file: target, ts: payload.ts };
}

/**
 * @param {string} projectDir
 * @param {object} [filter]
 *   - scope?: string
 *   - eventType?: string | string[]
 *   - taskId?: string
 *   - sinceIso?: string
 *   - untilIso?: string
 *   - limit?: number
 * @returns {object[]}
 */
export function query(projectDir, filter = {}) {
  const { eventsRoot } = getRuntimePaths(projectDir);
  const files = listEventFiles(eventsRoot);
  if (files.length === 0) return [];

  const results = [];
  for (const file of files) {
    const rows = loadJsonl(path.join(eventsRoot, file));
    for (const row of rows) {
      if (matchesFilter(row, filter)) {
        results.push(row);
      }
    }
  }

  results.sort((left, right) => String(left.ts || '').localeCompare(String(right.ts || '')));

  const limit = Number.isInteger(filter.limit) && filter.limit > 0 ? filter.limit : 0;
  if (limit > 0 && results.length > limit) {
    return results.slice(-limit);
  }
  return results;
}
