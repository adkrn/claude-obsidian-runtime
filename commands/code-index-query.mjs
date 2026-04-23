#!/usr/bin/env node

/**
 * Query the built code index for files matching a task/prompt.
 * Reads .claude/runtime/code-index/*.jsonl produced by code-index-build.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { normalizePath } from '../core/utils.mjs';
import {
  getRuntimePaths,
  parseCliArgs,
  tokenizeSearchText
} from '../core/runtime-lib.mjs';

const HIGH_FREQUENCY_KEYWORDS = new Set([
  'backend', 'frontend', 'service', 'controller', 'handler',
  'index', 'utils', 'helper', 'config', 'session', 'id',
  'src', 'app', 'page', 'component', 'model', 'route'
]);

function parseQueryArgs(argv) {
  const args = parseCliArgs(argv);
  args.scope = '';
  args.publicOnly = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--scope') { args.scope = argv[i + 1] || ''; i += 1; continue; }
    if (token === '--public-only') args.publicOnly = true;
  }
  return args;
}

function loadJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const rows = [];
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return rows;
}

function selectJsonlFiles(codeIndexRoot, { publicOnly = false, scopes = [] } = {}) {
  const allFiles = fs.readdirSync(codeIndexRoot).filter((n) => n.toLowerCase().endsWith('.jsonl'));
  if (publicOnly) return allFiles.filter((n) => n === 'public-surfaces.jsonl');
  if (scopes.length === 0) return allFiles.filter((n) => n !== 'public-surfaces.jsonl');
  const scopeFiles = new Set(scopes.map((s) => `${s}.jsonl`));
  const selected = allFiles.filter((n) => n === 'public-surfaces.jsonl' || scopeFiles.has(n));
  return selected.length > 0 ? selected : allFiles.filter((n) => n !== 'public-surfaces.jsonl');
}

export function loadIndexedRows(projectDir, { publicOnly = false, scopes = [] } = {}) {
  const { codeIndexRoot } = getRuntimePaths(projectDir);
  if (!fs.existsSync(codeIndexRoot)) return [];

  const fileNames = selectJsonlFiles(codeIndexRoot, { publicOnly, scopes });
  const rowMap = new Map();
  for (const name of fileNames) {
    const rows = loadJsonl(path.join(codeIndexRoot, name));
    for (const row of rows) {
      if (!row || typeof row.path !== 'string' || row.path.length === 0) continue;
      if (!rowMap.has(row.path)) rowMap.set(row.path, row);
    }
  }
  return Array.from(rowMap.values());
}

const DEFAULT_ALIAS_RULES = [
  { token: '옵시디언', expand: ['obsidian', 'vault', 'workflow'] },
  { token: '클로드', expand: ['claude', 'workflow'] },
  { token: '구조', expand: ['architecture', 'workflow'] },
  { token: '코드', expand: ['code', 'index'] },
  { token: '위치', expand: ['path', 'index'] },
  { token: '최적화', expand: ['optimization', 'index'] },
  { token: '계획', expand: ['plan', 'planning'] },
  { token: '교훈', expand: ['lesson', 'lessons'] },
  { token: '트러블슈팅', expand: ['troubleshooting'] },
  { token: '실패', expand: ['failure', 'error'] },
  { token: '백엔드', expand: ['backend', 'server', 'api'] },
  { token: '프론트엔드', expand: ['frontend', 'ui', 'next'] },
  { token: '로그인', expand: ['login', 'auth'] },
  { token: '인증', expand: ['auth', 'authentication'] },
  { token: '공유', expand: ['share', 'sharing'] },
  { token: '결과', expand: ['result', 'results'] },
  { token: '대화', expand: ['conversation', 'chat'] },
  { token: '평가', expand: ['evaluation', 'assess', 'score'] }
];

export function expandQueryTokens(query, extraRules = []) {
  const baseTokens = tokenizeSearchText(query);
  const extraTokens = [];
  const joined = String(query || '').toLowerCase();
  const rules = [...DEFAULT_ALIAS_RULES, ...extraRules];
  for (const rule of rules) {
    if (joined.includes(rule.token)) extraTokens.push(...rule.expand);
  }
  return Array.from(new Set([...baseTokens, ...extraTokens]));
}

function scoreRow(row, queryText, queryTokens, publicOnly) {
  const normalizedPath = normalizePath(row.path).toLowerCase();
  const basename = path.basename(normalizedPath);
  const basenameNoExt = path.basename(normalizedPath, path.extname(normalizedPath));
  const symbols = Array.isArray(row.symbols) ? row.symbols : [];
  const keywords = Array.isArray(row.keywords) ? row.keywords : [];
  const reasons = [];
  let score = 0;

  if (queryText.includes(basename)) { score += 20; reasons.push(`basename:${basename}`); }
  else if (queryText.includes(basenameNoExt.toLowerCase())) { score += 16; reasons.push(`file:${basenameNoExt}`); }

  const exactSymbolMatches = symbols.filter((s) => queryText.includes(String(s).toLowerCase()));
  if (exactSymbolMatches.length > 0) {
    score += exactSymbolMatches.length * 12;
    reasons.push(`symbol:${exactSymbolMatches.slice(0, 2).join(',')}`);
  }

  const keywordMatches = keywords.filter((t) => queryTokens.includes(t));
  if (keywordMatches.length > 0) {
    const specificMatches = keywordMatches.filter((t) => !HIGH_FREQUENCY_KEYWORDS.has(t));
    const genericMatches = keywordMatches.filter((t) => HIGH_FREQUENCY_KEYWORDS.has(t));
    score += Math.min(15, specificMatches.length * 3 + genericMatches.length * 1);
    reasons.push(`keywords:${keywordMatches.slice(0, 4).join(',')}`);
  }

  if (row.surfaceType && queryTokens.includes(String(row.surfaceType).toLowerCase())) {
    score += 5; reasons.push(`surface:${row.surfaceType}`);
  }
  if (row.domain && queryTokens.includes(String(row.domain).toLowerCase())) {
    score += 4; reasons.push(`domain:${row.domain}`);
  }
  if (row.scope && queryTokens.includes(String(row.scope).toLowerCase())) {
    score += 4; reasons.push(`scope:${row.scope}`);
  }
  if (publicOnly && row.isPublicSurface) score += 2;

  return { ...row, score, reasons };
}

export function queryCodeIndex(projectDir, { query, limit = 6, scope = '', scopes = [], publicOnly = false } = {}) {
  const rows = loadIndexedRows(projectDir, { publicOnly, scopes });
  if (rows.length === 0) {
    return { generatedAt: new Date().toISOString(), query, scope, publicOnly, totalIndexedRows: 0, results: [] };
  }
  const queryText = String(query || '').trim().toLowerCase();
  const queryTokens = expandQueryTokens(query);

  const filteredRows = rows.filter((row) => !scope || String(row.scope || '') === scope);
  const results = filteredRows
    .map((row) => scoreRow(row, queryText, queryTokens, publicOnly))
    .filter((row) => row.score >= 6)
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.path.localeCompare(b.path)))
    .slice(0, limit)
    .map((row) => ({
      path: row.path,
      scope: row.scope,
      domain: row.domain,
      domainLabel: row.domainLabel,
      surfaceType: row.surfaceType,
      surfaceName: row.surfaceName,
      symbols: (row.symbols || []).slice(0, 6),
      relatedDocs: row.relatedDocs || [],
      why: row.reasons.slice(0, 3).join(' / '),
      score: row.score
    }));

  return {
    generatedAt: new Date().toISOString(),
    query, scope, publicOnly,
    totalIndexedRows: filteredRows.length,
    results
  };
}

async function main() {
  const args = parseQueryArgs(process.argv.slice(2));
  if (!args.task) {
    process.stderr.write('Missing --task argument\n');
    process.exit(1);
  }
  const projectDir = path.resolve(args.projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const result = queryCodeIndex(projectDir, {
    query: args.task,
    scope: args.scope,
    publicOnly: args.publicOnly,
    limit: args.limit || 6
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const currentFilePath = fileURLToPath(import.meta.url);
const invokedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (currentFilePath === invokedFilePath) {
  main().catch((err) => { process.stderr.write(`[code-index-query] ${err.message}\n`); process.exit(1); });
}
