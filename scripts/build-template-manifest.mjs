#!/usr/bin/env node

/**
 * Build templates/_manifest.json — SHA256 checksum manifest for template files.
 *
 * Driven by PATCH_Phase1 §5-A/§5-B:
 *   - Runs at package build / publish time.
 *   - Recursively scans $PACKAGE_ROOT/templates.
 *   - Emits one record per file: { relPath, sha256, size, required }.
 *   - Sorted by relPath (sort order stable for deterministic diffs).
 *   - Output path: templates/_manifest.json (relative to package root).
 *
 * `required: true` triggers C11 FAIL on missing/mismatched file. False = warn.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const TEMPLATES_DIR = path.join(PACKAGE_ROOT, 'templates');
const MANIFEST_PATH = path.join(TEMPLATES_DIR, '_manifest.json');
const SCHEMA_VERSION = '1.0.0';

/**
 * `required: true` rules (PATCH §5 policy):
 *   - hooks/*.sh                       (6 core hooks)
 *   - obsidian_paths.json              (init contract)
 *   - context_routes.json              (init contract)
 *   - runtime-manifest.json            (init contract)
 *   - vault/00_Home/*.md               (vault skeleton)
 *   - eval/golden-tasks.json           (Wave 1 C1 — eval harness seed)
 *
 * Everything else (slash command markdown, optional extras) is `required: false`.
 */
export function isRequiredTemplate(relPath) {
  const normalized = relPath.replace(/\\/g, '/');
  if (normalized === '_manifest.json') return false;
  if (/^hooks\/.+\.sh$/.test(normalized)) return true;
  if (normalized === 'obsidian_paths.json') return true;
  if (normalized === 'context_routes.json') return true;
  if (normalized === 'runtime-manifest.json') return true;
  if (/^vault\/00_Home\/[^/]+\.md$/.test(normalized)) return true;
  if (normalized === 'eval/golden-tasks.json') return true;
  if (normalized === 'agents/_lead.md') return true;
  return false;
}

export function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function walkFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

function toRelPath(absPath, rootDir) {
  return path.relative(rootDir, absPath).replace(/\\/g, '/');
}

function loadPackageVersion(pkgRoot) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')
    ).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function computeRootFingerprint(files) {
  const sorted = [...files].sort((a, b) => a.relPath.localeCompare(b.relPath));
  const hash = crypto.createHash('sha256');
  for (const f of sorted) hash.update(f.sha256);
  return hash.digest('hex');
}

/**
 * Build manifest payload in memory (pure; tests call directly).
 */
export function buildManifest({
  templatesDir = TEMPLATES_DIR,
  packageRoot = PACKAGE_ROOT,
  now = new Date()
} = {}) {
  if (!fs.existsSync(templatesDir)) {
    throw new Error(`templates directory missing: ${templatesDir}`);
  }

  const allFiles = walkFiles(templatesDir);
  const files = [];
  for (const abs of allFiles) {
    const relPath = toRelPath(abs, templatesDir);
    if (relPath === '_manifest.json') continue; // never include self
    const stat = fs.statSync(abs);
    files.push({
      relPath,
      sha256: sha256File(abs),
      size: stat.size,
      required: isRequiredTemplate(relPath)
    });
  }
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));

  return {
    schemaVersion: SCHEMA_VERSION,
    packageVersion: loadPackageVersion(packageRoot),
    generatedAt: now.toISOString(),
    generator: 'scripts/build-template-manifest.mjs',
    files,
    rootFingerprint: computeRootFingerprint(files)
  };
}

export function writeManifest({
  templatesDir = TEMPLATES_DIR,
  manifestPath = MANIFEST_PATH,
  packageRoot = PACKAGE_ROOT,
  now = new Date()
} = {}) {
  const manifest = buildManifest({ templatesDir, packageRoot, now });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return manifest;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (__filename === invokedPath) {
  try {
    const manifest = writeManifest();
    const required = manifest.files.filter((f) => f.required).length;
    process.stdout.write(
      `[build-template-manifest] wrote ${manifest.files.length} file(s) ` +
        `(${required} required) to ${MANIFEST_PATH}\n`
    );
  } catch (err) {
    process.stderr.write(`[build-template-manifest] ${err.message}\n`);
    process.exit(1);
  }
}
