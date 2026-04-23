// Event reader for the eval frame.
// Reads events/<scope>.jsonl files within a rolling time window
// and groups them by taskId. Spec: DESIGN_C §2-F.

import fs from 'fs';
import path from 'path';

const DAY_MS = 86400 * 1000;

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readJsonlLines(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed lines silently — eval should not crash on bad data.
    }
  }
  return out;
}

function parseTs(value) {
  if (!value) return NaN;
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : NaN;
}

export function readEventsWindow(projectDir, windowDays = 30, now = Date.now()) {
  if (!projectDir || typeof projectDir !== 'string') {
    throw new TypeError('readEventsWindow: projectDir required');
  }
  const days = Number.isFinite(windowDays) && windowDays > 0 ? windowDays : 30;
  const cutoff = now - days * DAY_MS;
  const eventsRoot = path.join(projectDir, '.claude', 'runtime', 'events');
  const entries = safeReaddir(eventsRoot);
  const all = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const events = readJsonlLines(path.join(eventsRoot, entry.name));
    for (const ev of events) {
      const ts = parseTs(ev?.ts);
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      all.push(ev);
    }
  }
  all.sort((a, b) => parseTs(a.ts) - parseTs(b.ts));
  return all;
}

export function groupEventsByTask(events) {
  const map = new Map();
  if (!Array.isArray(events)) return map;
  for (const ev of events) {
    const taskId = ev?.taskId;
    if (!taskId) continue;
    const bucket = map.get(taskId);
    if (bucket) {
      bucket.push(ev);
    } else {
      map.set(taskId, [ev]);
    }
  }
  return map;
}

export function extractFileReadsForTask(taskEvents) {
  const out = new Set();
  if (!Array.isArray(taskEvents)) return out;
  for (const ev of taskEvents) {
    if (ev?.eventType !== 'file_read') continue;
    const p = ev.filePath || ev.vaultRelPath;
    if (typeof p === 'string' && p.length > 0) {
      out.add(p);
    }
  }
  return out;
}

export function extractFirstEditedFile(taskEvents) {
  if (!Array.isArray(taskEvents)) return null;
  for (const ev of taskEvents) {
    if (ev?.eventType !== 'file_modified') continue;
    const tool = ev?.toolName;
    if (tool !== 'Edit' && tool !== 'Write') continue;
    const p = ev?.filePath;
    if (typeof p === 'string' && p.length > 0) {
      return p;
    }
  }
  return null;
}
