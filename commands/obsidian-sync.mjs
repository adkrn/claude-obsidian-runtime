#!/usr/bin/env node

/**
 * Sync Obsidian vault into project context mirror.
 *
 * Usage:
 *   claude-obsidian-runtime sync [--project-dir <path>]
 *
 * Uses the project's obsidian_paths.json to determine vault root,
 * managedRoots, and mirror exclusion rules.
 */

import path from 'path';
import { loadObsidianConfig } from '../core/obsidian-config.mjs';
import { syncManagedRoots } from '../core/obsidian-sync.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project-dir' && argv[i + 1]) { args.projectDir = argv[i + 1]; i++; }
  }
  args.projectDir = path.resolve(args.projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadObsidianConfig(args.projectDir);

  if (!config.vaultAvailable) {
    console.error(`[sync] Vault not found at: ${config.vaultRoot}`);
    console.error(`[sync] Set OBSIDIAN_VAULT_ROOT env var or edit obsidian_paths.json.`);
    process.exit(1);
  }

  const result = syncManagedRoots(args.projectDir, config);
  console.log(JSON.stringify(result, null, 2));

  if (!result.ok) process.exit(1);
}

main();
