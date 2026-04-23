/**
 * Shared session-end utilities for Obsidian-Claude runtime.
 *
 * Provides reusable pipeline helpers:
 *   - parseSessionEndArgs: CLI argument parsing with --close, --session-id, etc.
 *   - rotateStaleEventLogs: clean up old event log files
 *   - timedStep: wrap pipeline step with timing and error capture
 *   - isOverBudget: check if pipeline has exceeded time budget
 *   - Event dedup: tryAcquireEventLock, hasEventInLog, cleanStaleEventLocks
 */

import fs from 'fs';
import path from 'path';
import {
  getRuntimePaths,
  parseCliArgs,
  removeFile
} from './runtime-lib.mjs';

// ── CLI Argument Parsing ────────────────────────────────────────

export function parseSessionEndArgs(argv) {
  const base = parseCliArgs(argv);
  const args = {
    ...base,
    close: false,
    publish: true,
    hookEventName: 'SessionEnd',
    sessionId: '',
    transcriptPath: '',
    skipArchivePlan: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--close') {
      args.close = true;
      continue;
    }
    if (token === '--no-publish') {
      args.publish = false;
      continue;
    }
    if (token === '--hook-event') {
      args.hookEventName = argv[index + 1] || 'SessionEnd';
      index += 1;
      continue;
    }
    if (token === '--session-id') {
      args.sessionId = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (token === '--transcript-path') {
      args.transcriptPath = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (token === '--skip-archive-plan') {
      args.skipArchivePlan = true;
    }
  }

  return args;
}

// ── Event Log Rotation ──────────────────────────────────────────

const EVENT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export function rotateStaleEventLogs(projectDir) {
  const eventsRoot = getRuntimePaths(projectDir).eventsRoot;
  const now = Date.now();
  const removed = [];

  try {
    const entries = fs.readdirSync(eventsRoot).filter(
      (name) => name.endsWith('.jsonl')
    );

    for (const entry of entries) {
      const filePath = path.join(eventsRoot, entry);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > EVENT_TTL_MS) {
          removeFile(filePath);
          removed.push(entry);
        }
      } catch {
        // skip unreadable files
      }
    }
  } catch {
    // skip if dir unreadable
  }

  return removed;
}

// ── Pipeline Timing ─────────────────────────────────────────────

export function timedStep(name, fn, timing) {
  const start = Date.now();
  try {
    const result = fn();
    timing[name] = Date.now() - start;
    return { ok: true, result };
  } catch (error) {
    timing[name] = Date.now() - start;
    return { ok: false, error: String(error?.message || error), result: null };
  }
}

export function isOverBudget(startMs, thresholdMs = 20_000) {
  return Date.now() - startMs > thresholdMs;
}

// ── Event Dedup ─────────────────────────────────────────────────

export function getSessionEndMarkerPath(projectDir, taskId, eventType) {
  const { eventsRoot } = getRuntimePaths(projectDir);
  return path.join(eventsRoot, `.dedup-${taskId}-${eventType}.lock`);
}

export function tryAcquireEventLock(markerPath, dedupWindowMs) {
  try {
    const stat = fs.statSync(markerPath);
    if (Date.now() - stat.mtimeMs < dedupWindowMs) {
      return false;
    }
    fs.rmSync(markerPath, { force: true });
  } catch { /* file doesn't exist */ }
  try {
    fs.writeFileSync(markerPath, JSON.stringify({ ts: new Date().toISOString() }), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

export function hasEventInLog(eventFilePath, taskId, eventType) {
  try {
    if (!fs.existsSync(eventFilePath)) return false;
    const content = fs.readFileSync(eventFilePath, 'utf-8');
    const needle1 = `"taskId":"${taskId}"`;
    const needle2 = `"eventType":"${eventType}"`;
    return content.split('\n').some((line) => line.includes(needle1) && line.includes(needle2));
  } catch { return false; }
}

export function cleanStaleEventLocks(projectDir) {
  const { eventsRoot } = getRuntimePaths(projectDir);
  const LOCK_TTL_MS = 3600_000;
  try {
    for (const name of fs.readdirSync(eventsRoot)) {
      if (!name.startsWith('.dedup-') || !name.endsWith('.lock')) continue;
      try {
        const stat = fs.statSync(path.join(eventsRoot, name));
        if (Date.now() - stat.mtimeMs > LOCK_TTL_MS) {
          fs.rmSync(path.join(eventsRoot, name), { force: true });
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
}
