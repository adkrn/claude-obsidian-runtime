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
    skipArchivePlan: false,
    // DESIGN_MANUS_4A §6 — task-close verify gate.
    //   verify === null  → option not specified; behaves as ON (§4-A default).
    //   verify === true  → explicit --verify (same as default).
    //   verify === false → --no-verify (skip).
    // Last-token-wins (§6-B) is implemented by parsing in argv order.
    verify: null,
    verifyChecks: null
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
      continue;
    }
    if (token === '--verify') {
      args.verify = true;
      continue;
    }
    if (token === '--no-verify') {
      args.verify = false;
      continue;
    }
    if (token === '--verify-checks') {
      const raw = argv[index + 1] || '';
      args.verifyChecks = raw
        .split(',')
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean);
      index += 1;
      continue;
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

// ── Handoff Worklog (Design-A §3-B) ─────────────────────────────
//
// 5 fixed sections, in this exact order:
//   1. 이번 세션에서 한 일
//   2. 남은 일 (다음 세션 먼저 할 것)
//   3. 건드리면 안 되는 것
//   4. 핵심 가정 (깨지면 재설계)
//   5. 한 줄 메모
//
// Ordering is load-bearing — downstream tooling reads by section index.

export const HANDOFF_SECTION_HEADERS = Object.freeze([
  '## 이번 세션에서 한 일',
  '## 남은 일 (다음 세션 먼저 할 것)',
  '## 건드리면 안 되는 것',
  '## 핵심 가정 (깨지면 재설계)',
  '## 한 줄 메모'
]);

function formatList(items, emptyLabel = '없음') {
  const filtered = Array.isArray(items) ? items.filter((i) => String(i || '').trim()) : [];
  if (filtered.length === 0) return `- ${emptyLabel}`;
  return filtered.map((i) => `- ${i}`).join('\n');
}

/**
 * buildHandoffWorklog — pure. Produces a markdown Worklog with the five
 * Handoff sections in fixed order.
 *
 * @param {object} input
 *   - task:            closed task record (required for title/taskId)
 *   - changedFiles:    [{path, why}] from session/task changes
 *   - commits:         [{sha, subject}] optional
 *   - verifications:   [{command, success, summary}] — session-scoped
 *   - openACs:         [string]  "남은 일"
 *   - preserveHooks:   [string]  from manifest
 *   - readOnlyPaths:   [string]  project-local readonly list
 *   - matchedScopes:   [string]  task.matchedScopes
 *   - decisions:       [string]  key decisions this session
 *   - oneLiner:        string    최종 한 줄 메모
 * @returns {{ markdown: string, sections: object }}
 */
export function buildHandoffWorklog(input = {}) {
  const task = input.task || {};
  const title = String(task.title || task.prompt || task.taskId || 'Session Worklog').trim();

  const changed = (input.changedFiles || []).map((f) => {
    if (typeof f === 'string') return f;
    const why = String(f?.why || '').trim();
    return why ? `${f.path} — ${why}` : String(f?.path || '');
  });
  const commitLines = (input.commits || []).map((c) => `commit: ${c.sha || ''} ${c.subject || ''}`.trim());
  const verifyLines = (input.verifications || []).map((v) =>
    `verification: ${v.success ? 'pass' : 'fail'} \`${v.command || ''}\``
  );

  const section1 = formatList(
    [...changed, ...commitLines, ...verifyLines],
    '변경 사항 없음'
  );
  const section2 = formatList(
    (input.openACs || []).map((ac) => `[ ] ${ac}`),
    '남은 AC 없음'
  );
  const section3Lines = [];
  if (Array.isArray(input.preserveHooks) && input.preserveHooks.length > 0) {
    section3Lines.push(`preserveHooks: ${input.preserveHooks.join(', ')}`);
  }
  if (Array.isArray(input.readOnlyPaths) && input.readOnlyPaths.length > 0) {
    section3Lines.push(`readOnly 경로: ${input.readOnlyPaths.join(', ')}`);
  }
  const section3 = formatList(section3Lines, '특이사항 없음');

  const section4Lines = [];
  if (Array.isArray(input.matchedScopes) && input.matchedScopes.length > 0) {
    section4Lines.push(`matched scopes: ${input.matchedScopes.join(', ')}`);
  }
  if (Array.isArray(input.decisions) && input.decisions.length > 0) {
    section4Lines.push(`decisions: ${input.decisions.join('; ')}`);
  }
  const section4 = formatList(section4Lines, '기록 없음');

  const oneLiner = String(input.oneLiner || `next session entry: ${title}`).trim();
  const section5 = `"${oneLiner.replace(/"/g, '\\"')}"`;

  const markdown = [
    `# Worklog — ${title}`,
    '',
    HANDOFF_SECTION_HEADERS[0],
    section1,
    '',
    HANDOFF_SECTION_HEADERS[1],
    section2,
    '',
    HANDOFF_SECTION_HEADERS[2],
    section3,
    '',
    HANDOFF_SECTION_HEADERS[3],
    section4,
    '',
    HANDOFF_SECTION_HEADERS[4],
    section5,
    ''
  ].join('\n');

  return {
    markdown,
    sections: {
      '이번 세션에서 한 일': section1,
      '남은 일': section2,
      '건드리면 안 되는 것': section3,
      '핵심 가정': section4,
      '한 줄 메모': section5
    }
  };
}

// ── Session-end hook pipeline (Design-A §4-B) ──────────────────
//
// Fixed order, each step gated on manifest.memoryLayers flag when applicable:
//   1. capture events    (always)
//   2. lesson draft      (evolutionEnabled → upsertLesson + evolve)
//   3. reflection draft  (reflectionsEnabled)
//   4. troubleshooting   (failures.length >= 1, no flag)
//   5. architecture-detect (always, if provided)
//   6. worklog (Handoff)  (always)
//   7. procedural distill (proceduralEnabled, batch — last)
//
// Each hook is isolated with timedStep so one failure never blocks the rest.

const DEFAULT_MEMORY_LAYERS = {
  reflectionsEnabled: true,
  proceduralEnabled: true,
  evolutionEnabled: true
};

/**
 * runSessionEndHooks — orchestrates the seven session-end hooks in the
 * required order and records per-hook timing + skip reasons.
 *
 * @param {object} ctx
 *   - projectDir
 *   - manifest:          { memoryLayers?: {...} }
 *   - task:              task record
 *   - events:            task events (for buildLessonDraft)
 *   - taskHistory:       recent closed tasks (for distillProceduralMemory)
 *   - handoffInput:      params forwarded to buildHandoffWorklog
 *   - hooks:             injected callbacks (pure: test-friendly, prod: real I/O)
 *       - captureEvents?(projectDir, task)              -> {events}
 *       - buildLessonDraft?(task, events)               -> lesson
 *       - upsertLesson?(projectDir, lesson)             -> {ok, lessonId, evolved}
 *       - buildReflectionDraft?(task)                   -> reflection | null
 *       - upsertReflection?(projectDir, reflection)     -> {ok, reflectionId}
 *       - buildTroubleshootingDraft?(task, failures)    -> trouble | null
 *       - writeTroubleshooting?(projectDir, trouble)    -> {ok, path}
 *       - architectureDetect?(projectDir, task)         -> {ok}
 *       - writeWorklog?(projectDir, handoffMd, task)    -> {ok, path}
 *       - distillProceduralMemory?(history)             -> {candidates}
 *       - upsertProcedure?(projectDir, procedure)       -> {ok, procedureId}
 * @returns {{ order, timings, results, errors }}
 */
export function runSessionEndHooks(ctx = {}) {
  const projectDir = ctx.projectDir;
  const task = ctx.task || {};
  const memoryLayers = { ...DEFAULT_MEMORY_LAYERS, ...(ctx.manifest?.memoryLayers || {}) };
  const hooks = ctx.hooks || {};
  const order = [];
  const timings = {};
  const results = {};
  const errors = {};

  const step = (name, fn) => {
    order.push(name);
    const outcome = timedStep(name, fn, timings);
    if (outcome.ok) {
      results[name] = outcome.result;
    } else {
      errors[name] = outcome.error;
    }
    return outcome;
  };

  // 1. capture events (always)
  let events = Array.isArray(ctx.events) ? ctx.events : [];
  if (hooks.captureEvents) {
    const r = step('capture_events', () => hooks.captureEvents(projectDir, task));
    if (r.ok && Array.isArray(r.result?.events)) events = r.result.events;
  }

  // 2. lesson draft + evolve (gated)
  let lessonDraft = null;
  if (memoryLayers.evolutionEnabled !== false && hooks.buildLessonDraft) {
    const r = step('lesson_draft', () => hooks.buildLessonDraft(task, events));
    if (r.ok) lessonDraft = r.result;
    if (lessonDraft && hooks.upsertLesson) {
      step('lesson_upsert', () => hooks.upsertLesson(projectDir, lessonDraft));
    }
  } else {
    results.lesson_draft = { skipped: true, reason: 'evolutionEnabled=false' };
  }

  // 3. reflection draft (gated)
  if (memoryLayers.reflectionsEnabled !== false && hooks.buildReflectionDraft) {
    const r = step('reflection_draft', () => hooks.buildReflectionDraft(task));
    if (r.ok && r.result && hooks.upsertReflection) {
      step('reflection_upsert', () => hooks.upsertReflection(projectDir, r.result));
    }
  } else {
    results.reflection_draft = { skipped: true, reason: 'reflectionsEnabled=false' };
  }

  // 4. troubleshooting (conditional on failures)
  const failures = Array.isArray(task.failures) ? task.failures : [];
  if (failures.length >= 1 && hooks.buildTroubleshootingDraft) {
    const r = step('troubleshooting_draft', () => hooks.buildTroubleshootingDraft(task, failures));
    if (r.ok && r.result && hooks.writeTroubleshooting) {
      step('troubleshooting_write', () => hooks.writeTroubleshooting(projectDir, r.result));
    }
  } else {
    results.troubleshooting_draft = { skipped: true, reason: 'no_failures' };
  }

  // 5. architecture-detect (always if provided)
  if (hooks.architectureDetect) {
    step('architecture_detect', () => hooks.architectureDetect(projectDir, task));
  }

  // 6. worklog (Handoff 5섹션)
  if (hooks.writeWorklog) {
    const handoff = buildHandoffWorklog({ task, ...ctx.handoffInput });
    step('worklog', () => hooks.writeWorklog(projectDir, handoff.markdown, task));
    results.handoff = handoff;
  }

  // 7. procedural distillation (gated, last — may be batched)
  if (memoryLayers.proceduralEnabled !== false && hooks.distillProceduralMemory) {
    const history = Array.isArray(ctx.taskHistory) ? ctx.taskHistory : [];
    const r = step('procedural_distill', () => hooks.distillProceduralMemory(history));
    if (r.ok && Array.isArray(r.result?.candidates) && hooks.upsertProcedure) {
      for (const candidate of r.result.candidates) {
        step(`procedural_upsert:${candidate.pattern_signature || candidate.id}`,
          () => hooks.upsertProcedure(projectDir, candidate));
      }
    }
  } else {
    results.procedural_distill = { skipped: true, reason: 'proceduralEnabled=false' };
  }

  return { order, timings, results, errors };
}
