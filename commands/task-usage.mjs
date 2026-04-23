#!/usr/bin/env node

/**
 * Calculate token usage by parsing Claude session transcripts.
 * Aggregates per-session and per-task token counts (input/output/cache).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { normalizePath } from '../core/utils.mjs';
import { loadTaskRecord, parseCliArgs } from '../core/runtime-lib.mjs';

function toNumber(value) {
  const parsed = Number.parseInt(String(value ?? '0'), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function createEmptyUsageSummary() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalTokens: 0,
    assistantMessageCount: 0,
    mainAssistantMessageCount: 0,
    subagentAssistantMessageCount: 0,
    sessionCount: 0,
    transcriptCount: 0,
    missingSessions: [],
    sessions: []
  };
}

function normalizeUsage(usage = {}) {
  const inputTokens = toNumber(usage.input_tokens);
  const outputTokens = toNumber(usage.output_tokens);
  const cacheCreationInputTokens = toNumber(usage.cache_creation_input_tokens);
  const cacheReadInputTokens = toNumber(usage.cache_read_input_tokens);

  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    totalTokens: inputTokens + outputTokens + cacheCreationInputTokens + cacheReadInputTokens
  };
}

function addUsageTotals(target, usage, options = {}) {
  target.inputTokens += usage.inputTokens || 0;
  target.outputTokens += usage.outputTokens || 0;
  target.cacheCreationInputTokens += usage.cacheCreationInputTokens || 0;
  target.cacheReadInputTokens += usage.cacheReadInputTokens || 0;
  target.totalTokens += usage.totalTokens || 0;
  target.assistantMessageCount += options.assistantMessageCount || 0;
  target.mainAssistantMessageCount += options.mainAssistantMessageCount || 0;
  target.subagentAssistantMessageCount += options.subagentAssistantMessageCount || 0;
  return target;
}

function maxIso(left = '', right = '') {
  if (!left) return right || '';
  if (!right) return left;
  return left >= right ? left : right;
}

function isWithinRange(timestamp = '', startedAt = '', endedAt = '') {
  const normalizedTs = String(timestamp || '').trim();
  if (!normalizedTs) return false;
  if (startedAt && normalizedTs < startedAt) return false;
  if (endedAt && normalizedTs > endedAt) return false;
  return true;
}

function buildUsageRecordKey(entry, filePath, lineIndex) {
  return String(
    entry.requestId ||
    entry.message?.id ||
    entry.uuid ||
    `${normalizePath(filePath)}:${lineIndex}`
  );
}

function collectTranscriptUsageRecords(transcriptPath, range = {}) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];

  const lines = fs.readFileSync(transcriptPath, 'utf8').split(/\r?\n/);
  const latestByRequest = new Map();

  lines.forEach((line, index) => {
    if (!line.trim()) return;

    let entry;
    try { entry = JSON.parse(line); } catch { return; }

    if (entry?.type !== 'assistant' || !entry.message?.usage) return;
    if (!isWithinRange(entry.timestamp, range.startedAt, range.endedAt)) return;

    const record = {
      key: buildUsageRecordKey(entry, transcriptPath, index),
      timestamp: String(entry.timestamp || '').trim(),
      lineIndex: index,
      isSidechain: Boolean(entry.isSidechain),
      usage: normalizeUsage(entry.message.usage)
    };
    const previous = latestByRequest.get(record.key);

    if (!previous || previous.lineIndex <= record.lineIndex) {
      latestByRequest.set(record.key, record);
    }
  });

  return Array.from(latestByRequest.values())
    .sort((left, right) => {
      if (left.timestamp !== right.timestamp) {
        return left.timestamp.localeCompare(right.timestamp);
      }
      return left.lineIndex - right.lineIndex;
    });
}

function summarizeUsageRecords(records, kind = 'main') {
  const summary = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalTokens: 0,
    assistantMessageCount: records.length,
    mainAssistantMessageCount: kind === 'main' ? records.length : 0,
    subagentAssistantMessageCount: kind === 'subagent' ? records.length : 0
  };

  records.forEach((record) => {
    addUsageTotals(summary, record.usage);
  });

  return summary;
}

function getClaudeProjectsRoot() {
  return path.join(os.homedir(), '.claude', 'projects');
}

function findSessionTranscriptPath(sessionId, preferredPath = '') {
  const normalizedPreferredPath = preferredPath ? path.resolve(preferredPath) : '';
  if (normalizedPreferredPath && fs.existsSync(normalizedPreferredPath)) {
    return normalizedPreferredPath;
  }

  if (!sessionId) return '';

  const projectsRoot = getClaudeProjectsRoot();
  if (!fs.existsSync(projectsRoot)) return '';

  const projectDirs = fs.readdirSync(projectsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory());

  for (const projectDirEntry of projectDirs) {
    const candidate = path.join(projectsRoot, projectDirEntry.name, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }

  return '';
}

function listSubagentTranscriptPaths(mainTranscriptPath) {
  if (!mainTranscriptPath) return [];

  const transcriptStem = path.basename(mainTranscriptPath, path.extname(mainTranscriptPath));
  const subagentRoot = path.join(path.dirname(mainTranscriptPath), transcriptStem, 'subagents');
  if (!fs.existsSync(subagentRoot)) return [];

  return fs.readdirSync(subagentRoot)
    .filter((entry) => entry.toLowerCase().endsWith('.jsonl'))
    .map((entry) => path.join(subagentRoot, entry))
    .sort((left, right) => left.localeCompare(right));
}

function buildSessionWindows(task, options = {}) {
  const sessionIds = Array.isArray(task?.sessionIds) ? task.sessionIds : [];
  const fallbackStartedAt = task?.createdAt || '';
  const fallbackEndedAt = options.closedAt || task?.closedAt || task?.updatedAt || '';
  const windowsBySessionId = new Map();

  for (const sessionId of sessionIds) {
    if (windowsBySessionId.has(sessionId)) continue;

    windowsBySessionId.set(sessionId, {
      sessionId,
      startedAt: fallbackStartedAt,
      endedAt: fallbackEndedAt,
      lastSeenAt: '',
      transcriptPath: ''
    });
  }

  if (options.sessionId && !windowsBySessionId.has(options.sessionId)) {
    windowsBySessionId.set(options.sessionId, {
      sessionId: options.sessionId,
      startedAt: fallbackStartedAt,
      endedAt: options.closedAt || fallbackEndedAt,
      lastSeenAt: '',
      transcriptPath: options.transcriptPath || ''
    });
  }

  if (options.sessionId && windowsBySessionId.has(options.sessionId)) {
    const current = windowsBySessionId.get(options.sessionId);
    windowsBySessionId.set(options.sessionId, {
      ...current,
      endedAt: maxIso(current.endedAt, options.closedAt || fallbackEndedAt)
    });
  }

  return Array.from(windowsBySessionId.values())
    .filter((entry) => entry.sessionId)
    .sort((left, right) => {
      const leftKey = left.startedAt || left.sessionId;
      const rightKey = right.startedAt || right.sessionId;
      return leftKey.localeCompare(rightKey);
    });
}

export function calculateTaskUsage(projectDir, options = {}) {
  const loaded = options.task
    ? { task: options.task }
    : loadTaskRecord(projectDir, options.taskId || '');
  const task = loaded?.task;

  if (!task) {
    return {
      ok: false,
      reason: 'task_not_found',
      usage: createEmptyUsageSummary()
    };
  }

  const windows = buildSessionWindows(task, {
    sessionId: options.sessionId || '',
    transcriptPath: options.transcriptPath || '',
    closedAt: options.closedAt || ''
  });
  const aggregate = createEmptyUsageSummary();
  aggregate.sessionCount = windows.length;

  for (const window of windows) {
    const transcriptPath = findSessionTranscriptPath(window.sessionId, window.transcriptPath);
    if (!transcriptPath) {
      aggregate.missingSessions.push(window.sessionId);
      aggregate.sessions.push({
        sessionId: window.sessionId,
        startedAt: window.startedAt || '',
        endedAt: window.endedAt || '',
        transcriptPath: '',
        subagentTranscriptCount: 0,
        assistantMessageCount: 0,
        totalTokens: 0
      });
      continue;
    }

    const range = {
      startedAt: window.startedAt || task.createdAt || '',
      endedAt: window.endedAt || options.closedAt || task.closedAt || task.updatedAt || ''
    };
    const mainRecords = collectTranscriptUsageRecords(transcriptPath, range);
    const mainSummary = summarizeUsageRecords(mainRecords, 'main');
    const subagentTranscriptPaths = listSubagentTranscriptPaths(transcriptPath);
    const sessionSummary = { ...mainSummary };

    for (const subagentTranscriptPath of subagentTranscriptPaths) {
      const subagentRecords = collectTranscriptUsageRecords(subagentTranscriptPath, range);
      const subagentSummary = summarizeUsageRecords(subagentRecords, 'subagent');
      addUsageTotals(sessionSummary, subagentSummary, {
        assistantMessageCount: 0,
        mainAssistantMessageCount: 0,
        subagentAssistantMessageCount: 0
      });
      sessionSummary.assistantMessageCount += subagentSummary.assistantMessageCount;
      sessionSummary.subagentAssistantMessageCount += subagentSummary.subagentAssistantMessageCount;
    }

    addUsageTotals(aggregate, sessionSummary, {
      assistantMessageCount: sessionSummary.assistantMessageCount,
      mainAssistantMessageCount: sessionSummary.mainAssistantMessageCount,
      subagentAssistantMessageCount: sessionSummary.subagentAssistantMessageCount
    });
    aggregate.transcriptCount += 1 + subagentTranscriptPaths.length;
    aggregate.sessions.push({
      sessionId: window.sessionId,
      startedAt: range.startedAt,
      endedAt: range.endedAt,
      transcriptPath: normalizePath(transcriptPath),
      subagentTranscriptCount: subagentTranscriptPaths.length,
      assistantMessageCount: sessionSummary.assistantMessageCount,
      totalTokens: sessionSummary.totalTokens
    });
  }

  return {
    ok: true,
    taskId: task.taskId,
    usage: aggregate
  };
}

// ── CLI Entrypoint ──────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const invokedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : '';

if (__filename === invokedFilePath) {
  const args = parseCliArgs(process.argv.slice(2));
  const projectDir = path.resolve(args.projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const result = calculateTaskUsage(projectDir, {
    taskId: args.taskId,
    sessionId: args.sessionId
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
