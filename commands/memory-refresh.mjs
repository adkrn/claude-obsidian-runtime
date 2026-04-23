#!/usr/bin/env node

/**
 * Refresh code index + knowledge index (one-shot).
 * Useful after large vault / code changes.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { buildCodeIndex } from '../core/code-index-build.mjs';
import { parseCliArgs } from '../core/runtime-lib.mjs';
import { buildKnowledgeIndex } from './knowledge-index-build.mjs';

export function refreshRuntimeMemory(projectDir) {
  const codeIndex = buildCodeIndex(projectDir);
  const knowledgeIndex = buildKnowledgeIndex(projectDir);
  return { generatedAt: new Date().toISOString(), codeIndex, knowledgeIndex };
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const projectDir = path.resolve(args.projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const result = refreshRuntimeMemory(projectDir);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const currentFilePath = fileURLToPath(import.meta.url);
const invokedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (currentFilePath === invokedFilePath) {
  main().catch((err) => { process.stderr.write(`[memory-refresh] ${err.message}\n`); process.exit(1); });
}
