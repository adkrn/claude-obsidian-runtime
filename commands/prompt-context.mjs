#!/usr/bin/env node

/**
 * UserPromptSubmit hook handler.
 *
 * 1. Load last-context.json (written by task-start).
 * 2. Match prompt keywords against knowledge items -> accumulate hit counts.
 * 3. Emit lightweight readFirst + guardrails as additionalContext.
 *
 * A richer variant with code-index integration lives in each project's
 * local context-resolver (promoted optionally via manifest).
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { loadJson, readStdinJson } from '../core/utils.mjs';
import {
  appendJsonl,
  getRuntimePaths,
  loadCurrentTaskPointer,
  loadJsonl,
  loadTaskRecord,
  parseCliArgs,
  tokenizeSearchText,
  writeJsonFile
} from '../core/runtime-lib.mjs';

const INTENT_TOKENS = new Set([
  'task','plan','planning','implement','implementation','fix','bug','issue','error',
  'refactor','architecture','workflow','hook','memory','runtime','obsidian','claude',
  'lesson','decision','troubleshooting',
  '작업','계획','버그','에러','아키텍처','워크플로우','훅','메모리','옵시디언','클로드',
  '프롬프트','리팩터링','교훈','결정','트러블슈팅'
]);

const RESUME_TOKENS = new Set([
  'continue','resume','next',
  '다음','이어','계속','계속해줘','이어서','진행','진행해줘'
]);

export function extractPromptText(payload = {}) {
  if (!payload || typeof payload !== 'object') return '';
  return String(payload.prompt || payload.user_prompt || payload.userPrompt || '').trim();
}

function matchKnowledge(projectDir, promptTokens) {
  const runtimePaths = getRuntimePaths(projectDir);
  const hitCountsPath = path.join(runtimePaths.knowledgeRoot, 'hit-counts.json');
  const hitCounts = loadJson(hitCountsPath, {});

  const knowledgeFiles = [
    path.join(runtimePaths.knowledgeRoot, 'lessons.jsonl'),
    path.join(runtimePaths.knowledgeRoot, 'troubleshooting.jsonl'),
    path.join(runtimePaths.knowledgeRoot, 'decisions.jsonl')
  ];
  const allRows = knowledgeFiles.flatMap((fp) => loadJsonl(fp));
  const matched = [];
  let hitsUpdated = false;

  for (const row of allRows) {
    if (!row || !row.id || row.duplicateOf) continue;
    const rowTokens = Array.isArray(row.tokens) ? row.tokens : [];
    const titleTokens = tokenizeSearchText(row.title || '');
    const allTokens = [...rowTokens, ...titleTokens];
    const matchCount = allTokens.filter((t) => promptTokens.includes(t)).length;

    if (matchCount >= 2) {
      matched.push({ id: row.id, kind: row.kind || 'knowledge', title: row.title || '', summary: row.summary || '' });
      if (!hitCounts[row.id]) hitCounts[row.id] = { count: 0, lastHitAt: '' };
      hitCounts[row.id].count += 1;
      hitCounts[row.id].lastHitAt = new Date().toISOString();
      hitsUpdated = true;
    }
  }

  if (hitsUpdated) writeJsonFile(hitCountsPath, hitCounts);
  return { matched, hitsUpdated, hitCountsPath };
}

function shouldInject({ prompt, lastContext, currentTask, matchedKnowledge }) {
  const normalized = String(prompt || '').trim();
  if (!normalized) return false;
  if (normalized.startsWith('/task-start') || normalized.startsWith('/architecture-sync')) return true;

  const tokens = tokenizeSearchText(normalized);
  const hasIntent = tokens.some((t) => INTENT_TOKENS.has(t));
  const hasResume = tokens.some((t) => RESUME_TOKENS.has(t));
  const readFirstCount = Array.isArray(lastContext.readFirst) ? lastContext.readFirst.length : 0;

  if (hasIntent && (matchedKnowledge.length > 0 || readFirstCount > 0)) return true;
  if (currentTask?.task && hasResume) return true;
  return false;
}

function buildAdditionalContext({ lastContext, currentTask, matchedKnowledge }) {
  const lines = ['[Runtime Context]'];
  if (currentTask?.task?.taskId) {
    const t = currentTask.task;
    lines.push(`- active_task: ${t.taskId} :: ${t.title || t.prompt || t.taskId}`);
  }
  if (Array.isArray(lastContext.readFirst) && lastContext.readFirst.length > 0) {
    lines.push('- read_first:');
    lastContext.readFirst.slice(0, 3).forEach((n) => {
      lines.push(`  - ${n.path || n} :: ${n.why || ''}`);
    });
  }
  if (matchedKnowledge.length > 0) {
    lines.push('- knowledge_hits:');
    matchedKnowledge.slice(0, 3).forEach((k) => {
      lines.push(`  - ${k.kind} :: ${k.title} :: ${k.summary}`);
    });
  }
  if (Array.isArray(lastContext.guardrails) && lastContext.guardrails.length > 0) {
    lines.push(`- guardrails: ${lastContext.guardrails.slice(0, 3).join('; ')}`);
  }
  lines.push('- rule: Read listed files before planning. Keep retrieval compact.');
  return lines.join('\n');
}

let lastDedupKey = '';
let lastDedupTs = 0;
function logTrigger(projectDir, { prompt, triggered, reasons, matchedKnowledge, output }) {
  const dateStamp = new Date().toISOString().slice(0, 10);
  const promptPrefix = String(prompt || '').slice(0, 50);
  const dedupKey = `${dateStamp}:${promptPrefix}`;
  const now = Date.now();
  if (lastDedupKey === dedupKey && now - lastDedupTs < 60_000) return;
  lastDedupKey = dedupKey;
  lastDedupTs = now;

  const logPath = path.join(getRuntimePaths(projectDir).eventsRoot, `prompt-triggers-${dateStamp}.jsonl`);
  appendJsonl(logPath, {
    ts: new Date().toISOString(),
    eventType: 'prompt_trigger',
    prompt: promptPrefix,
    triggered,
    reasons,
    hitKnowledgeIds: matchedKnowledge.map((k) => k.id),
    knowledgeHitCount: matchedKnowledge.length,
    outputChars: output ? output.length : 0
  });
}

export function buildRuntimePromptContext(projectDir, payload = {}) {
  const prompt = extractPromptText(payload);
  if (!prompt) return null;

  const runtimePaths = getRuntimePaths(projectDir);
  const lastContext = loadJson(runtimePaths.lastContextPath, {});
  const pointer = loadCurrentTaskPointer(projectDir);
  const currentTask = pointer?.taskId ? loadTaskRecord(projectDir, pointer.taskId) : null;
  const promptTokens = tokenizeSearchText(prompt);
  const { matched } = matchKnowledge(projectDir, promptTokens);

  if (!shouldInject({ prompt, lastContext, currentTask, matchedKnowledge: matched })) {
    logTrigger(projectDir, { prompt, triggered: false, reasons: ['no-intent-match'], matchedKnowledge: matched, output: null });
    return null;
  }

  const additionalContext = buildAdditionalContext({ lastContext, currentTask, matchedKnowledge: matched });
  logTrigger(projectDir, { prompt, triggered: true, reasons: ['intent-match'], matchedKnowledge: matched, output: additionalContext });

  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext
    }
  };
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const projectDir = path.resolve(args.projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd());

  let input;
  try {
    input = await readStdinJson({});
  } catch {
    input = {};
  }
  if (args.prompt && !input.prompt) input.prompt = args.prompt;

  const result = buildRuntimePromptContext(projectDir, input);
  if (result) process.stdout.write(JSON.stringify(result));
}

const currentFilePath = fileURLToPath(import.meta.url);
const invokedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (currentFilePath === invokedFilePath) {
  main().catch(() => process.exit(0));
}
