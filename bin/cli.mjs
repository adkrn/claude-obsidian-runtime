#!/usr/bin/env node

/**
 * claude-obsidian-runtime CLI entry point.
 *
 * Subcommands:
 *   init          Initialize a new project
 *   install-hooks Install/update hooks into a project
 *   upgrade       Upgrade hooks/templates to current package version
 *   sync          Run Obsidian vault sync
 *   doctor        Diagnose project runtime health
 *   rollback      Restore from Step 0.5 backup
 *   version       Print package version
 *
 * Usage:
 *   npx claude-obsidian-runtime <subcommand> [args]
 *   claude-runtime <subcommand> [args]
 */

import { readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '..');

const SUBCOMMANDS = {
  init: {
    module: 'commands/init-project.mjs',
    description: 'Initialize a new project with Obsidian-Claude runtime'
  },
  'install-hooks': {
    module: 'commands/install-hooks.mjs',
    description: 'Install or update hooks into an existing project'
  },
  upgrade: {
    module: 'commands/upgrade.mjs',
    description: 'Upgrade hooks/templates to match current package version'
  },
  sync: {
    module: 'commands/obsidian-sync.mjs',
    description: 'Run Obsidian vault sync for current project'
  },
  doctor: {
    module: 'commands/doctor.mjs',
    description: 'Diagnose project runtime health (use --full for deep check)'
  },
  rollback: {
    module: 'commands/rollback.mjs',
    description: 'Restore runtime from Step 0.5 backup'
  },
  version: { inline: true, description: 'Print package version' },
  help: { inline: true, description: 'Show this help' }
};

function printHelp() {
  const pkg = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  console.log(`claude-obsidian-runtime v${pkg.version}`);
  console.log('');
  console.log('Usage: claude-obsidian-runtime <subcommand> [args]');
  console.log('');
  console.log('Subcommands:');
  for (const [name, def] of Object.entries(SUBCOMMANDS)) {
    console.log(`  ${name.padEnd(16)} ${def.description}`);
  }
  console.log('');
  console.log('Environment:');
  console.log('  CLAUDE_RUNTIME_HOME  Absolute path to this package (required for hooks)');
  console.log('  CLAUDE_PROJECT_DIR   Project being operated on (auto-set by Claude Code)');
}

function printVersion() {
  const pkg = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  console.log(pkg.version);
}

async function main() {
  const args = process.argv.slice(2);
  const sub = args[0];

  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    printHelp();
    return;
  }

  if (sub === '--version' || sub === '-v' || sub === 'version') {
    printVersion();
    return;
  }

  const def = SUBCOMMANDS[sub];
  if (!def) {
    console.error(`Unknown subcommand: ${sub}`);
    console.error('Run: claude-obsidian-runtime help');
    process.exit(2);
  }

  if (def.inline) {
    // Handled above
    return;
  }

  const modulePath = path.join(PACKAGE_ROOT, def.module);
  const moduleUrl = pathToFileURL(modulePath).href;
  process.argv = [process.argv[0], modulePath, ...args.slice(1)];

  try {
    await import(moduleUrl);
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND') {
      console.error(`[cli] Subcommand '${sub}' not yet implemented (module missing: ${def.module})`);
      console.error(`[cli] This is expected during Step 1-4 of the migration plan.`);
      process.exit(3);
    }
    throw err;
  }
}

main().catch((err) => {
  console.error('[cli] Error:', err.message);
  process.exit(1);
});
