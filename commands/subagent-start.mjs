#!/usr/bin/env node

/**
 * SubagentStart hook handler.
 * Emits a compact context block describing the active task so spawned
 * subagents stay within the task scope.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { readStdinJson } from '../core/utils.mjs';
import {
  loadCurrentTaskPointer,
  loadTaskRecord,
  parseCliArgs
} from '../core/runtime-lib.mjs';

function detectSubagentName(input) {
  return input.subagent_name || input.subagentName || input.agent_name || input.agentName || '';
}

function buildAdditionalContext(input, task) {
  const lines = ['[Runtime Subagent Context]'];

  const subagentName = detectSubagentName(input);
  if (subagentName) lines.push(`- subagent: ${subagentName}`);

  lines.push(`- task_id: ${task.taskId}`);
  lines.push(`- current_task: ${task.title || task.prompt || task.taskId}`);

  if (Array.isArray(task.matchedScopes) && task.matchedScopes.length > 0) {
    lines.push(`- scopes: ${task.matchedScopes.join(', ')}`);
  }
  if (Array.isArray(task.codeHits) && task.codeHits.length > 0) {
    lines.push('- code_hits:');
    task.codeHits.slice(0, 3).forEach((item) => {
      lines.push(`  - ${item.path} :: ${item.why}`);
    });
  }
  if (Array.isArray(task.readFirst) && task.readFirst.length > 0) {
    lines.push('- read_first:');
    task.readFirst.slice(0, 3).forEach((item) => {
      lines.push(`  - ${item.path} :: ${item.why}`);
    });
  }
  if (Array.isArray(task.knowledgeHits) && task.knowledgeHits.length > 0) {
    lines.push(`- knowledge: ${task.knowledgeHits[0].kind} :: ${task.knowledgeHits[0].title}`);
  }
  if (Array.isArray(task.verifications) && task.verifications.length > 0) {
    const last = task.verifications[task.verifications.length - 1];
    lines.push(`- last_verify: ${last.success ? 'PASS' : 'FAIL'} ${last.command}`);
  }
  lines.push('- rule: Stay within listed files and task scope.');
  return lines.join('\n');
}

export function buildRuntimeSubagentContext(projectDir, input = {}) {
  const pointer = loadCurrentTaskPointer(projectDir);
  if (!pointer?.taskId) return null;
  const loaded = loadTaskRecord(projectDir, pointer.taskId);
  if (!loaded?.task) return null;

  return {
    hookSpecificOutput: {
      hookEventName: 'SubagentStart',
      additionalContext: buildAdditionalContext(input, loaded.task)
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

  const result = buildRuntimeSubagentContext(projectDir, input);
  if (result) process.stdout.write(JSON.stringify(result));
}

const currentFilePath = fileURLToPath(import.meta.url);
const invokedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (currentFilePath === invokedFilePath) {
  main().catch(() => process.exit(0));
}
