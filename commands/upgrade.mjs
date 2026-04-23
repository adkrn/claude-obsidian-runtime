#!/usr/bin/env node

/**
 * Upgrade hooks and templates in a project to match the current package version.
 *
 * Usage:
 *   claude-obsidian-runtime upgrade [--project-dir <path>] [--dry-run] [--force]
 *
 * Does:
 *   1. Compare installed vs current package version
 *   2. Re-run install-hooks (preserves project-specific hooks)
 *   3. Update runtime-version.json
 *
 * Does NOT:
 *   - Overwrite templates that already exist in the project (vault, commands/*.md)
 *   - Touch runtime state (tasks, events, knowledge)
 *   - Touch Obsidian vault content
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = { dryRun: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project-dir' && argv[i + 1]) { args.projectDir = argv[i + 1]; i++; }
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--force') args.force = true;
  }
  args.projectDir = path.resolve(args.projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  return args;
}

function loadJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function pkgVersion() {
  return loadJson(path.join(PACKAGE_ROOT, 'package.json'), {}).version || 'unknown';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const versionPath = path.join(args.projectDir, '.claude', 'runtime', 'runtime-version.json');
  const installed = loadJson(versionPath);
  const current = pkgVersion();

  console.log(`claude-obsidian-runtime upgrade`);
  console.log(`  Project:          ${args.projectDir}`);
  console.log(`  Current version:  ${current}`);
  console.log(`  Installed:        ${installed?.installedVersion || '(none)'}`);

  if (!installed) {
    console.log('');
    console.log(`[upgrade] No runtime-version.json found. Run 'claude-obsidian-runtime init' first for a fresh install.`);
    if (!args.force) {
      console.log('[upgrade] Aborting. Pass --force to proceed with install-hooks anyway.');
      process.exit(1);
    }
  } else if (installed.installedVersion === current && !args.force) {
    console.log('');
    console.log('[upgrade] Already up to date. Pass --force to reinstall hooks.');
    return;
  }

  if (args.dryRun) {
    console.log('');
    console.log('[upgrade] DRY RUN - would re-run install-hooks');
    return;
  }

  // Re-run install-hooks (preserves settings.json)
  process.argv = [process.argv[0], 'install-hooks', '--project-dir', args.projectDir];
  await import(pathToFileURL(path.join(PACKAGE_ROOT, 'commands', 'install-hooks.mjs')).href);

  console.log('');
  console.log(`[upgrade] Complete. Version: ${current}`);
}

main().catch((err) => {
  console.error('[upgrade] Error:', err.message);
  process.exit(1);
});
