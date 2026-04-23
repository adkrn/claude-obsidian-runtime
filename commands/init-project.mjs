#!/usr/bin/env node

/**
 * Initialize a new project for Obsidian-Claude runtime integration (v3.0.0).
 *
 * Usage:
 *   claude-obsidian-runtime init --project-id <id> --project-dir <path> [--vault-root <path>]
 *   (if --project-dir omitted, uses cwd)
 *
 * Does:
 *   1. Create Obsidian vault folders (00_Home, 04_Architecture, ... 10_Worklogs)
 *   2. Copy vault templates (Index, Current_Focus, Reading_Order) with {{PROJECT_ID}} substitution
 *   3. Copy obsidian_paths.json, context_routes.json, runtime-manifest.json templates
 *   4. Create .claude/runtime/ subdirectories
 *   5. Copy .claude/commands/*.md slash command templates
 *   6. Invoke install-hooks to register hooks and patch settings.json
 *
 * Idempotent: existing files are not overwritten.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const TEMPLATES_DIR = path.join(PACKAGE_ROOT, 'templates');

const DEFAULT_VAULT_FOLDERS = [
  '00_Home',
  '04_Architecture',
  '04_Architecture/Drafts',
  '04_Architecture/Generated',
  '06_Troubleshooting',
  '06_Troubleshooting/Drafts',
  '07_Decisions',
  '07_Decisions/Drafts',
  '08_Lessons',
  '08_Lessons/Drafts',
  '09_Templates',
  '10_Worklogs',
  '10_Worklogs/Auto'
];

const RUNTIME_SUBDIRS = ['tasks', 'events', 'retrieval', 'code-index', 'knowledge', 'architecture'];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project-id' && argv[i + 1]) { args.projectId = argv[i + 1]; i++; }
    else if (argv[i] === '--project-dir' && argv[i + 1]) { args.projectDir = argv[i + 1]; i++; }
    else if (argv[i] === '--vault-root' && argv[i + 1]) { args.vaultRoot = argv[i + 1]; i++; }
    else if (argv[i] === '--skip-hooks') { args.skipHooks = true; }
  }
  return args;
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function substitute(content, vars) {
  return Object.entries(vars).reduce(
    (acc, [k, v]) => acc.replaceAll(`{{${k}}}`, v),
    content
  );
}

function writeFileIfMissing(target, content) {
  if (fs.existsSync(target)) return false;
  ensureDir(path.dirname(target));
  fs.writeFileSync(target, content, 'utf8');
  return true;
}

function copyTemplate(templateRel, targetPath, vars) {
  const src = path.join(TEMPLATES_DIR, templateRel);
  if (!fs.existsSync(src)) {
    console.error(`[init] Template not found: ${templateRel}`);
    return false;
  }
  const raw = fs.readFileSync(src, 'utf8');
  const content = substitute(raw, vars);
  return writeFileIfMissing(targetPath, content);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.projectId) {
    console.error('Usage: claude-obsidian-runtime init --project-id <id> [--project-dir <path>] [--vault-root <path>] [--skip-hooks]');
    process.exit(1);
  }

  const projectDir = path.resolve(args.projectDir || process.cwd());
  const obsidianHome = process.platform === 'win32' ? 'C:\\Obsidian' : path.join(os.homedir(), 'Obsidian');
  const vaultRoot = path.resolve(args.vaultRoot || path.join(obsidianHome, args.projectId));
  const vars = {
    PROJECT_ID: args.projectId,
    VAULT_ROOT: vaultRoot.replace(/\\/g, '/')
  };

  console.log(`claude-obsidian-runtime init`);
  console.log(`  Project ID:   ${args.projectId}`);
  console.log(`  Project dir:  ${projectDir}`);
  console.log(`  Vault root:   ${vaultRoot}`);
  console.log('');

  const report = { created: [], skipped: [] };

  // 1. Create vault folders
  for (const folder of DEFAULT_VAULT_FOLDERS) {
    ensureDir(path.join(vaultRoot, ...folder.split('/')));
  }
  console.log(`  [vault] Created ${DEFAULT_VAULT_FOLDERS.length} folders`);

  // 2. Copy vault templates
  const vaultFiles = [
    { template: 'vault/00_Home/_Index.md', target: path.join(vaultRoot, '00_Home', `${args.projectId}_Index.md`) },
    { template: 'vault/00_Home/Current_Focus.md', target: path.join(vaultRoot, '00_Home', 'Current_Focus.md') },
    { template: 'vault/00_Home/Reading_Order.md', target: path.join(vaultRoot, '00_Home', 'Reading_Order.md') }
  ];
  for (const { template, target } of vaultFiles) {
    const created = copyTemplate(template, target, vars);
    (created ? report.created : report.skipped).push(target);
  }

  // 3. Copy _meta/ configs
  const metaDir = path.join(projectDir, 'document', 'obsidian_context', '_meta');
  ensureDir(metaDir);
  const metaFiles = [
    { template: 'obsidian_paths.json', target: path.join(metaDir, 'obsidian_paths.json') },
    { template: 'context_routes.json', target: path.join(metaDir, 'context_routes.json') }
  ];
  for (const { template, target } of metaFiles) {
    const created = copyTemplate(template, target, vars);
    (created ? report.created : report.skipped).push(target);
  }

  // 4. Create .claude/runtime/ subdirs
  const runtimeDir = path.join(projectDir, '.claude', 'runtime');
  for (const subdir of RUNTIME_SUBDIRS) {
    ensureDir(path.join(runtimeDir, subdir));
  }
  console.log(`  [runtime] Created ${RUNTIME_SUBDIRS.length} subdirs`);

  // 5. Copy runtime-manifest.json
  const manifestTarget = path.join(projectDir, '.claude', 'runtime-manifest.json');
  const manifestCreated = copyTemplate('runtime-manifest.json', manifestTarget, vars);
  (manifestCreated ? report.created : report.skipped).push(manifestTarget);

  // 6. Copy slash command templates
  const commandsDir = path.join(projectDir, '.claude', 'commands');
  ensureDir(commandsDir);
  const commandTemplates = fs.readdirSync(path.join(TEMPLATES_DIR, 'commands')).filter((f) => f.endsWith('.md'));
  for (const cmd of commandTemplates) {
    const target = path.join(commandsDir, cmd);
    const created = copyTemplate(`commands/${cmd}`, target, vars);
    (created ? report.created : report.skipped).push(target);
  }
  console.log(`  [commands] ${commandTemplates.length} slash command template(s)`);

  // 7. Invoke install-hooks
  if (!args.skipHooks) {
    console.log('');
    console.log('  [hooks] Running install-hooks...');
    process.argv = [process.argv[0], 'install-hooks', '--project-dir', projectDir];
    try {
      await import(pathToFileURL(path.join(PACKAGE_ROOT, 'commands', 'install-hooks.mjs')).href);
    } catch (err) {
      console.error(`  [hooks] FAILED: ${err.message}`);
    }
  } else {
    console.log('  [hooks] Skipped (--skip-hooks)');
  }

  console.log('');
  console.log(`Initialized project: ${args.projectId}`);
  console.log(`  Created: ${report.created.length} file(s)`);
  console.log(`  Skipped (already exist): ${report.skipped.length} file(s)`);
  console.log('');
  console.log('Next steps:');
  console.log(`  1. export CLAUDE_RUNTIME_HOME="${PACKAGE_ROOT.replace(/\\/g, '/')}"`);
  console.log(`  2. Edit ${manifestTarget} to set projectTag, defaultScope, surfacePatterns`);
  console.log(`  3. Edit ${path.join(metaDir, 'obsidian_paths.json')} to add indexTargets, scanRoots`);
  console.log(`  4. Run: claude-obsidian-runtime sync`);
  console.log(`  5. Run: claude-obsidian-runtime doctor --full`);
}

main().catch((err) => {
  console.error('[init] Error:', err.message);
  process.exit(1);
});

export { main as initProject };
