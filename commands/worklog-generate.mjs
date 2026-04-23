#!/usr/bin/env node

/**
 * worklog-generate — builds the 5-section Handoff Worklog for a task.
 *
 * Delegates to session-end-engine.buildHandoffWorklog. The CLI is a thin
 * shim: it reads the active task record + session metadata and prints the
 * markdown to stdout (or writes to a file when --out is provided).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  loadCurrentTaskPointer,
  loadTaskRecord,
  parseCliArgs
} from '../core/runtime-lib.mjs';
import { buildHandoffWorklog } from '../core/session-end-engine.mjs';
import { ensureDir } from '../core/utils.mjs';

function parseWorklogArgs(argv) {
  const args = parseCliArgs(argv);
  args.out = '';
  args.oneLiner = '';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') { args.out = argv[i + 1] || ''; i += 1; continue; }
    if (argv[i] === '--one-liner') { args.oneLiner = argv[i + 1] || ''; i += 1; continue; }
  }
  return args;
}

export function generateWorklog(projectDir, { taskId = '', oneLiner = '' } = {}) {
  const loaded = taskId
    ? loadTaskRecord(projectDir, taskId)
    : (loadCurrentTaskPointer(projectDir)?.taskId
        ? loadTaskRecord(projectDir, loadCurrentTaskPointer(projectDir).taskId)
        : null);
  if (!loaded?.task) {
    return { ok: false, reason: 'task_not_found' };
  }

  const task = loaded.task;
  const changedFiles = (task.files || []).map((f) => ({ path: f, why: '' }));
  const handoff = buildHandoffWorklog({
    task,
    changedFiles,
    verifications: task.verifications || [],
    matchedScopes: task.matchedScopes || [],
    preserveHooks: [],
    readOnlyPaths: [],
    openACs: [],
    decisions: [],
    oneLiner: oneLiner || ''
  });

  return { ok: true, taskId: task.taskId, markdown: handoff.markdown, sections: handoff.sections };
}

async function main() {
  const args = parseWorklogArgs(process.argv.slice(2));
  const projectDir = path.resolve(args.projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const result = generateWorklog(projectDir, { taskId: args.taskId, oneLiner: args.oneLiner });

  if (!result.ok) {
    process.stderr.write(`[worklog-generate] ${result.reason}\n`);
    process.exit(1);
  }

  if (args.out) {
    ensureDir(path.dirname(path.resolve(args.out)));
    fs.writeFileSync(path.resolve(args.out), result.markdown, 'utf8');
    process.stdout.write(`${JSON.stringify({ ok: true, taskId: result.taskId, path: path.resolve(args.out) })}\n`);
  } else {
    process.stdout.write(result.markdown);
  }
}

const currentFilePath = fileURLToPath(import.meta.url);
const invokedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (currentFilePath === invokedFilePath) {
  main().catch((err) => { process.stderr.write(`[worklog-generate] ${err.message}\n`); process.exit(1); });
}
