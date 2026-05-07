#!/usr/bin/env node

/**
 * task-start CLI — starts a runtime task (or previews it with --dry-run).
 *
 * Contract (PATCH_Phase1 §3-A/B/C):
 *   Output JSON (last stdout line) contains the 9 mandatory fields:
 *     taskId, readFirst, codeHits, knowledgeHits, guardrails,
 *     matchedScopes, matchedGroups, currentTaskPath, lastContextPath
 *
 *   --dry-run skips all side effects:
 *     - .claude/runtime/current-task.json
 *     - .claude/runtime/tasks/<taskId>.json
 *     - .claude/runtime/events/*.jsonl
 *     - .claude/runtime/retrieval/last-context.json
 *     - obsidian-sync
 */

import path from 'path';
import { fileURLToPath } from 'url';
import {
  parseCliArgs,
  tokenizeSearchText,
  toTaskPointer,
  writeSessionTaskPointer
} from '../core/runtime-lib.mjs';
import { createAndStartTask } from '../core/task-start-engine.mjs';
import {
  loadContextRoutes,
  selectContextNotes,
  resolveKnowledgeHits,
  buildGuardrails,
  buildReadFirst
} from '../core/context-resolver.mjs';

function defaultSyncVault() {
  // Lightweight no-op sync: task-start should never block on vault mirroring.
  // The real mirror refresh is owned by commands/obsidian-sync.mjs, invoked
  // explicitly from session hooks.
  return { ok: true, skipped: true, message: 'sync deferred to obsidian-sync hook' };
}

function defaultResolveContext({ projectDir, task, limit = 6 }) {
  const routes = loadContextRoutes(projectDir);
  const contextRoot = path.join(projectDir, 'document', 'obsidian_context');
  const { matchedGroups, notes } = selectContextNotes({
    routes,
    prompt: task,
    contextRoot
  });

  const promptTokens = tokenizeSearchText(task);
  const matchedScopes = Array.from(
    new Set(matchedGroups.flatMap((group) => group.scopes || []))
  );

  const codeHits = [];
  const knowledgeHits = resolveKnowledgeHits(projectDir, {
    promptTokens,
    matchedScopes,
    codeHits,
    limit
  });

  const baseReadFirst = notes.map((note) => ({
    path: note.path,
    why: note.why || '',
    mirrorPath: note.mirrorPath || ''
  }));
  const readFirst = buildReadFirst(baseReadFirst, knowledgeHits, contextRoot);

  const guardrails = buildGuardrails(promptTokens, matchedGroups, matchedScopes);

  return {
    matchedScopes,
    matchedGroups: matchedGroups.map((group) => ({
      id: group.id,
      label: group.label || group.id,
      score: group.score || 0
    })),
    readFirst,
    knowledgeHits,
    codeHits,
    guardrails
  };
}

function printHelp() {
  process.stdout.write([
    'Usage: task-start --task <prompt> [--project-dir <path>] [--session-id <id>] [--dry-run]',
    '',
    'Options:',
    '  --task <prompt>         Task text (required)',
    '  --project-dir <path>    Project root (default: $CLAUDE_PROJECT_DIR or cwd)',
    '  --session-id <id>       Session identifier (optional)',
    '  --task-id <id>          Explicit task id (default: generated from prompt + timestamp)',
    '  --limit <n>             Max knowledge hits (default: 6)',
    '  --dry-run               Compute context without writing files or syncing',
    '  --help                  Show this help',
    ''
  ].join('\n'));
}

export function runTaskStart(argv) {
  const args = parseCliArgs(argv);

  if (!args.projectDir) {
    args.projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  }
  args.projectDir = path.resolve(args.projectDir);

  if (!args.sessionId) {
    args.sessionId = process.env.SESSION_ID || '';
  }

  return createAndStartTask(args, {
    syncVault: defaultSyncVault,
    resolveContext: defaultResolveContext,
    defaultScope: 'repo',
    afterWrite: ({ projectDir, sessionId, taskRecord, taskFilePath, runtimePaths }) => {
      // Bind the new task to this session so SessionStart on a different
      // session can't accidentally claim or close it via the global pointer.
      if (!sessionId) return;
      writeSessionTaskPointer(
        projectDir,
        sessionId,
        toTaskPointer(taskRecord, taskFilePath, runtimePaths.lastContextPath)
      );
    }
  });
}

// ── CLI Entrypoint ──────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const invokedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : '';

if (__filename === invokedFilePath) {
  const rawArgs = process.argv.slice(2);

  if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  if (!rawArgs.some((token) => token === '--task')) {
    process.stderr.write('[task-start] --task <prompt> is required\n');
    process.exit(2);
  }

  try {
    const result = runTaskStart(rawArgs);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (err) {
    process.stderr.write(`[task-start] ${err.message}\n`);
    process.exit(1);
  }
}
