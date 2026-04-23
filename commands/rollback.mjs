#!/usr/bin/env node

/**
 * Rollback runtime from Step 0.5 backup.
 *
 * Usage:
 *   claude-obsidian-runtime rollback [--project-dir <path>] [--timestamp 20260420-1651] [--dry-run]
 *
 * Restores:
 *   .claude/hooks/           from .claude/hooks.backup-<timestamp>/
 *   scripts/runtime/         from scripts/runtime.backup-<timestamp>/  (Talkup)
 *   .claude/runtime/scripts/ from .claude/runtime/scripts.backup-<timestamp>/  (talkSim)
 *   .claude/settings.json    from .claude/settings.json.backup-<timestamp>
 *
 * Current state moved to .claude/.rolled-back-<now>/ (never deleted).
 */

import fs from 'fs';
import path from 'path';

function parseArgs(argv) {
  const args = { dryRun: false, timestamp: '20260420-1651' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project-dir' && argv[i + 1]) { args.projectDir = argv[i + 1]; i++; }
    else if (argv[i] === '--timestamp' && argv[i + 1]) { args.timestamp = argv[i + 1]; i++; }
    else if (argv[i] === '--dry-run') { args.dryRun = true; }
  }
  args.projectDir = path.resolve(args.projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  return args;
}

function findRestorePlan(projectDir, timestamp) {
  const plan = [];

  const hooksBackup = path.join(projectDir, '.claude', `hooks.backup-${timestamp}`);
  if (fs.existsSync(hooksBackup)) {
    plan.push({
      label: 'hooks',
      from: hooksBackup,
      to: path.join(projectDir, '.claude', 'hooks'),
      type: 'dir'
    });
  }

  // Talkup layout
  const scriptsBackupTalkup = path.join(projectDir, 'scripts', `runtime.backup-${timestamp}`);
  if (fs.existsSync(scriptsBackupTalkup)) {
    plan.push({
      label: 'scripts/runtime (Talkup)',
      from: scriptsBackupTalkup,
      to: path.join(projectDir, 'scripts', 'runtime'),
      type: 'dir'
    });
  }

  // talkSim layout
  const scriptsBackupTalkSim = path.join(projectDir, '.claude', 'runtime', `scripts.backup-${timestamp}`);
  if (fs.existsSync(scriptsBackupTalkSim)) {
    plan.push({
      label: '.claude/runtime/scripts (talkSim)',
      from: scriptsBackupTalkSim,
      to: path.join(projectDir, '.claude', 'runtime', 'scripts'),
      type: 'dir'
    });
  }

  const settingsBackup = path.join(projectDir, '.claude', `settings.json.backup-${timestamp}`);
  if (fs.existsSync(settingsBackup)) {
    plan.push({
      label: 'settings.json',
      from: settingsBackup,
      to: path.join(projectDir, '.claude', 'settings.json'),
      type: 'file'
    });
  }

  return plan;
}

function copyRecursive(src, dst) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dst, entry));
    }
  } else {
    fs.copyFileSync(src, dst);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[rollback] Project: ${args.projectDir}`);
  console.log(`[rollback] Timestamp: ${args.timestamp}`);
  console.log(`[rollback] Dry run: ${args.dryRun}`);

  const plan = findRestorePlan(args.projectDir, args.timestamp);
  if (plan.length === 0) {
    console.error(`[rollback] ERROR: no backup found for timestamp ${args.timestamp}`);
    process.exit(1);
  }

  console.log('');
  console.log('[rollback] Restore plan:');
  for (const step of plan) {
    console.log(`  ${step.label.padEnd(36)}: ${step.from}`);
    console.log(`  ${' '.repeat(36)}   -> ${step.to}`);
  }

  if (args.dryRun) {
    console.log('');
    console.log('[rollback] DRY RUN - no changes made');
    return;
  }

  const now = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 15);
  const rolledDir = path.join(args.projectDir, '.claude', `.rolled-back-${now}`);
  fs.mkdirSync(rolledDir, { recursive: true });

  for (const step of plan) {
    if (fs.existsSync(step.to)) {
      const dst = path.join(rolledDir, path.basename(step.to));
      fs.renameSync(step.to, dst);
    }
    copyRecursive(step.from, step.to);
    console.log(`[rollback] restored: ${step.label}`);
  }

  console.log('');
  console.log(`[rollback] Done. Previous state saved to: ${rolledDir}`);
  console.log(`[rollback] To verify:`);
  console.log(`  git diff runtime-pre-npm-migration -- .claude/hooks scripts/runtime .claude/settings.json`);
}

main();
