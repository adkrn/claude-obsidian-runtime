#!/usr/bin/env node

/**
 * Build .claude/runtime/knowledge/{lessons,troubleshooting,decisions}.jsonl
 * by scanning the Obsidian vault's 06/07/08 folders.
 *
 * Uses the local project's obsidian config to locate the context root
 * and cross-references the built code index to compute architectureRef.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadObsidianConfig } from '../core/obsidian-config.mjs';
import {
  limitText,
  listFilesRecursive,
  normalizePath,
  safeReadFile
} from '../core/utils.mjs';
import {
  ensureRuntimeLayout,
  getRuntimePaths,
  parseCliArgs,
  tokenizeSearchText,
  uniqueStrings,
  writeJsonlFile
} from '../core/runtime-lib.mjs';
import { loadIndexedRows } from './code-index-query.mjs';

const KNOWLEDGE_SPECS = [
  { kind: 'troubleshooting', root: '06_Troubleshooting', output: 'troubleshooting.jsonl' },
  { kind: 'decision',        root: '07_Decisions',       output: 'decisions.jsonl' },
  { kind: 'lesson',          root: '08_Lessons',         output: 'lessons.jsonl' }
];

function stripFrontmatter(value) {
  const text = String(value || '');
  if (!text.startsWith('---')) return text;
  const parts = text.split(/\r?\n---\r?\n/);
  if (parts.length < 2) return text;
  return parts.slice(1).join('\n---\n');
}

function parseFrontmatter(value) {
  const text = String(value || '');
  if (!text.startsWith('---')) return {};
  const endIndex = text.indexOf('\n---\n');
  if (endIndex === -1) return {};
  const block = text.slice(4, endIndex);
  const result = {};
  let currentKey = '';
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const listMatch = line.match(/^\s*-\s+(.+)$/);
    if (listMatch && currentKey) {
      result[currentKey] = Array.isArray(result[currentKey]) ? result[currentKey] : [];
      result[currentKey].push(listMatch[1].trim());
      continue;
    }
    const keyMatch = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!keyMatch) continue;
    currentKey = keyMatch[1];
    const rawValue = keyMatch[2].trim();
    if (!rawValue) { result[currentKey] = []; continue; }
    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      result[currentKey] = rawValue.slice(1, -1).split(',').map((i) => i.trim()).filter(Boolean);
      continue;
    }
    result[currentKey] = rawValue;
  }
  return result;
}

function isSeedableDoc(relativePath) {
  const normalized = normalizePath(relativePath);
  const baseName = path.basename(normalized, '.md').toLowerCase();
  if (normalized.includes('/Drafts/')) return false;
  if (baseName === '00_index' || baseName === '_index') return false;
  if (baseName.includes('index')) return false;
  return true;
}

function inferScopeFromKnowledgePath(kind, relativePath, frontmatter, body) {
  const normalized = normalizePath(relativePath);
  const segments = normalized.split('/');
  if (kind !== 'decision' && segments.length >= 2) return segments[1].toLowerCase();

  const tagText = Array.isArray(frontmatter.tags) ? frontmatter.tags.join(' ') : String(frontmatter.tags || '');
  const combined = `${frontmatter.title || ''} ${tagText} ${body}`;
  const lowered = combined.toLowerCase();
  if (/workflow|hook|runtime|obsidian|claude/.test(lowered)) return 'workflow';
  if (/prompt/.test(lowered)) return 'prompt';
  if (/frontend/.test(lowered)) return 'frontend';
  if (/backend/.test(lowered)) return 'backend';
  return 'repo';
}

function extractSummary(body) {
  const lines = stripFrontmatter(body)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !l.startsWith('#'))
    .filter((l) => !l.startsWith('|'))
    .filter((l) => !l.startsWith('```'));
  const summary = lines.find((l) => l.length >= 20) || lines[0] || '';
  return limitText(summary.replace(/^[-*]\s+/, ''), 180);
}

function extractRelatedFiles(frontmatter, body) {
  const relatedFromFrontmatter = Array.isArray(frontmatter.related_code) ? frontmatter.related_code : [];
  const bodyMatches = String(body || '').match(/(?:backend|frontend|frontend_admin|scripts|\.claude)\/[A-Za-z0-9_./-]+/g) || [];
  return uniqueStrings([
    ...relatedFromFrontmatter.map((i) => normalizePath(String(i))),
    ...bodyMatches.map((i) => normalizePath(String(i).replace(/[),.;]+$/, '')))
  ]).slice(0, 16);
}

function extractRules(kind, body) {
  const lines = stripFrontmatter(body)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const bullets = lines.filter((l) => /^[-*]\s+/.test(l)).map((l) => l.replace(/^[-*]\s+/, '').trim());
  if (kind === 'lesson' || kind === 'troubleshooting') return bullets.slice(0, 6);
  return bullets.slice(0, 4);
}

function buildSeedRow(kind, contextRoot, filePath, frontmatter, body, codeRowByPath = new Map()) {
  const sourceDoc = normalizePath(path.relative(contextRoot, filePath));
  const summary = frontmatter.summary ? limitText(String(frontmatter.summary), 180) : extractSummary(body);
  const relatedFiles = extractRelatedFiles(frontmatter, body);
  const scope = inferScopeFromKnowledgePath(kind, sourceDoc, frontmatter, body);
  const title = frontmatter.title || path.basename(sourceDoc, '.md').replace(/_/g, ' ');
  const rules = extractRules(kind, body);
  const checks = kind === 'troubleshooting' ? rules : [];
  const tokens = uniqueStrings([
    ...tokenizeSearchText(title),
    ...tokenizeSearchText(summary),
    ...tokenizeSearchText(Array.isArray(frontmatter.tags) ? frontmatter.tags.join(' ') : String(frontmatter.tags || '')),
    ...relatedFiles.flatMap((e) => tokenizeSearchText(e))
  ]).slice(0, 32);
  const architectureRef = uniqueStrings(
    relatedFiles.map((rf) => codeRowByPath.get(normalizePath(rf))?.architectureDoc).filter(Boolean)
  ).slice(0, 3);

  return {
    id: `seed:${sourceDoc}`,
    kind, scope, title, summary,
    rules: kind === 'lesson' || kind === 'decision' ? rules : [],
    checks, relatedFiles, architectureRef,
    sourceTaskId: 'seed', sourceDoc, storage: 'mirror',
    path: normalizePath(filePath),
    duplicateOf: '',
    updatedAt: String(frontmatter.updated || frontmatter.date || new Date(fs.statSync(filePath).mtimeMs).toISOString()),
    tokens
  };
}

function loadSeedDocs(contextRoot, spec, codeRowByPath = new Map()) {
  const sourceRoot = path.join(contextRoot, spec.root);
  if (!fs.existsSync(sourceRoot)) return [];
  return listFilesRecursive(sourceRoot, (fp) => fp.toLowerCase().endsWith('.md'))
    .map((fp) => ({ filePath: fp, relativePath: normalizePath(path.relative(sourceRoot, fp)) }))
    .filter((e) => isSeedableDoc(e.relativePath))
    .map((e) => {
      const content = safeReadFile(e.filePath);
      if (!content.trim()) return null;
      const frontmatter = parseFrontmatter(content);
      return buildSeedRow(spec.kind, contextRoot, e.filePath, frontmatter, content, codeRowByPath);
    })
    .filter(Boolean);
}

function pruneStaleRows(rows, projectDir) {
  const hitCountsPath = path.join(getRuntimePaths(projectDir).knowledgeRoot, 'hit-counts.json');
  let hitCounts = {};
  try { hitCounts = JSON.parse(safeReadFile(hitCountsPath) || '{}'); } catch { /* empty */ }
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const kept = rows.filter((row) => {
    if (String(row.id || '').startsWith('seed:')) return true;
    if (String(row.sourceDoc || '').includes('/Promoted/')) return true;
    if ((hitCounts[row.id]?.count || 0) > 0) return true;
    if (now - new Date(row.updatedAt || 0).getTime() <= THIRTY_DAYS) return true;
    if (Array.isArray(row.relatedFiles) && row.relatedFiles.length > 0) return true;
    return false;
  });
  if (kept.length < rows.length * 0.5) return rows;
  return kept;
}

function mergeSeedRows(existingRows, seedRows) {
  return [
    ...existingRows.filter((row) => !String(row.id || '').startsWith('seed:')),
    ...seedRows
  ].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

export function buildKnowledgeIndex(projectDir) {
  ensureRuntimeLayout(projectDir);
  const obsidianConfig = loadObsidianConfig(projectDir);
  const runtimePaths = getRuntimePaths(projectDir);
  const results = [];

  let codeRowByPath = new Map();
  try {
    const codeRows = loadIndexedRows(projectDir, {});
    codeRowByPath = new Map(codeRows.map((r) => [normalizePath(r.path), r]));
  } catch { /* code index unavailable */ }

  for (const spec of KNOWLEDGE_SPECS) {
    const seedRows = loadSeedDocs(obsidianConfig.contextRoot, spec, codeRowByPath);
    const outputPath = path.join(runtimePaths.knowledgeRoot, spec.output);
    const existingRows = fs.existsSync(outputPath)
      ? safeReadFile(outputPath).split(/\r?\n/).filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean)
      : [];
    const prunedExisting = spec.kind === 'lesson' ? pruneStaleRows(existingRows, projectDir) : existingRows;
    const mergedRows = mergeSeedRows(prunedExisting, seedRows);
    writeJsonlFile(outputPath, mergedRows);
    results.push({
      kind: spec.kind,
      output: normalizePath(outputPath),
      seededCount: seedRows.length,
      totalCount: mergedRows.length
    });
  }

  return { generatedAt: new Date().toISOString(), results };
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const projectDir = path.resolve(args.projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const result = buildKnowledgeIndex(projectDir);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const currentFilePath = fileURLToPath(import.meta.url);
const invokedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (currentFilePath === invokedFilePath) {
  main().catch((err) => { process.stderr.write(`[knowledge-index-build] ${err.message}\n`); process.exit(1); });
}
