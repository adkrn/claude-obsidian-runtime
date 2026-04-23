#!/usr/bin/env node

/**
 * Hook installer for Obsidian-Claude runtime.
 *
 * Usage:
 *   node install-hooks.mjs --project-dir C:/JSProj/talkSim
 *
 * Reads `.claude/runtime-manifest.json` from the project,
 * generates .sh thin wrappers in `.claude/hooks/`,
 * and patches `.claude/settings.json` with core hook entries.
 *
 * Idempotent: running twice produces the same result.
 * Project-specific hooks in settings.json are preserved.
 */

import fs from 'fs';
import path from 'path';
import { parseCliArgs } from '../core/runtime-lib.mjs';
import { ensureDir, loadJson } from '../core/utils.mjs';

// ── Core hook definitions ──────────────────────────────────────────

const CORE_HOOKS = {
  SessionStart: {
    script: 'session-start.mjs',
    shellName: 'runtime-session-start.sh',
    timeout: 10,
    args: ''
  },
  UserPromptSubmit: {
    script: 'prompt-context.mjs',
    shellName: 'runtime-prompt-context.sh',
    timeout: 10,
    args: ''
  },
  SubagentStart: {
    script: 'subagent-start.mjs',
    shellName: 'runtime-subagent-start.sh',
    timeout: 10,
    args: ''
  },
  Stop: {
    script: 'stop.mjs',
    shellName: 'runtime-stop.sh',
    timeout: 10,
    args: '--session-id "${CLAUDE_SESSION_ID:-}"'
  },
  SubagentStop: {
    script: 'stop.mjs',
    shellName: 'runtime-stop.sh',
    timeout: 10,
    args: '--session-id "${CLAUDE_SESSION_ID:-}"'
  },
  SessionEnd: {
    script: 'session-end.mjs',
    shellName: 'runtime-session-end.sh',
    timeout: 30,
    args: '--session-id "${CLAUDE_SESSION_ID:-}"'
  }
};

const POST_TOOL_USE_CORE = {
  matchers: ['Edit', 'Write', 'Bash'],
  script: 'post-edit.mjs',
  shellName: 'runtime-post-edit.sh',
  timeout: 10,
  args: '--session-id "${CLAUDE_SESSION_ID:-}"',
  background: true
};

// ── Shell wrapper templates ────────────────────────────────────────

/**
 * Legacy shell wrapper: relative path based (project's scripts/ directory).
 * Kept for v2.x manifests where `scriptsRelativePath` is set.
 */
function generateLegacyShellWrapper(scriptRelativePath, args = '', background = false) {
  const bgSuffix = background ? ' &' : '';
  const argsStr = args ? ` \\\n  ${args}` : '';
  return `#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
node "$SCRIPT_DIR/${scriptRelativePath}"${argsStr}${bgSuffix}
`;
}

/**
 * v3.0.0 shell wrapper: uses $CLAUDE_RUNTIME_HOME with legacy fallback.
 * Legacy fallback active for 2 weeks post-migration, then can be removed.
 */
function generateShellWrapper(commandName, args = '', background = false, legacyRelPath = null) {
  const bgSuffix = background ? ' &' : '';
  const argsStr = args ? ` ${args}` : '';
  const legacyFallback = legacyRelPath
    ? `else
  # Legacy fallback (pre-v3.0.0). Will be removed after 2026-05-05.
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  node "$SCRIPT_DIR/${legacyRelPath}"${argsStr} 2>/dev/null || true${bgSuffix}
fi`
    : `else
  echo "[hook] CLAUDE_RUNTIME_HOME not set. Hook skipped." >&2
fi`;

  return `#!/bin/bash
set -euo pipefail
if [ -n "\${CLAUDE_RUNTIME_HOME:-}" ] && [ -d "\$CLAUDE_RUNTIME_HOME" ]; then
  node "\$CLAUDE_RUNTIME_HOME/commands/${commandName}"${argsStr}${bgSuffix}
${legacyFallback}
`;
}

// ── Settings.json patcher ──────────────────────────────────────────

function buildCoreSettingsHooks(manifest) {
  const hooks = {};

  // Lifecycle hooks
  for (const [event, def] of Object.entries(CORE_HOOKS)) {
    if (manifest.coreHooks !== 'all' && !manifest.coreHooks?.includes?.(event)) continue;

    const entry = {
      hooks: [{
        type: 'command',
        command: `bash "$CLAUDE_PROJECT_DIR"/.claude/hooks/${def.shellName}`,
        timeout: def.timeout * 1000
      }]
    };

    if (!hooks[event]) hooks[event] = [];
    // Avoid duplicate core entries
    const existing = hooks[event].find((e) =>
      e.hooks?.[0]?.command?.includes(def.shellName)
    );
    if (!existing) hooks[event].push(entry);
  }

  // PostToolUse hooks
  if (manifest.coreHooks === 'all' || manifest.coreHooks?.includes?.('PostToolUse')) {
    if (!hooks.PostToolUse) hooks.PostToolUse = [];

    for (const matcher of POST_TOOL_USE_CORE.matchers) {
      const existing = hooks.PostToolUse.find((e) =>
        e.matcher === matcher &&
        e.hooks?.some((h) => h.command?.includes(POST_TOOL_USE_CORE.shellName))
      );
      if (!existing) {
        hooks.PostToolUse.push({
          matcher,
          hooks: [{
            type: 'command',
            command: `bash "$CLAUDE_PROJECT_DIR"/.claude/hooks/${POST_TOOL_USE_CORE.shellName}`,
            timeout: POST_TOOL_USE_CORE.timeout * 1000
          }]
        });
      }
    }
  }

  return hooks;
}

function mergeHooks(existing, coreHooks) {
  const merged = { ...existing };

  for (const [event, entries] of Object.entries(coreHooks)) {
    if (!merged[event]) {
      merged[event] = entries;
      continue;
    }

    for (const entry of entries) {
      const coreShellName = entry.hooks?.[0]?.command || '';
      const alreadyExists = merged[event].some((e) => {
        const cmd = e.hooks?.[0]?.command || '';
        // Match by shell script name
        return coreShellName && cmd.includes(path.basename(coreShellName.split('/').pop()));
      });
      if (!alreadyExists) {
        merged[event].push(entry);
      }
    }
  }

  return merged;
}

// ── Main installer ─────────────────────────────────────────────────

/**
 * Default preserve list — project-specific hook shell names that install-hooks
 * must NEVER overwrite. Can be extended per-project via --preserve or manifest.preserveHooks.
 */
const DEFAULT_PRESERVE_LIST = [
  'error-detector.sh',
  'error-agent-enforcer.sh',
  'migration-detector.sh',
  'agent-approval-enforcer.sh',
  'commit-reminder.sh',
  'architect-reminder.sh',
  'code-simplifier-detector.sh',
  'troubleshooting-loader.sh'
];

async function installHooks(projectDir, options = {}) {
  const manifestPath = path.join(projectDir, '.claude', 'runtime-manifest.json');
  const manifest = loadJson(manifestPath, null);

  if (!manifest) {
    console.error(`[install-hooks] runtime-manifest.json not found at ${manifestPath}`);
    console.error('[install-hooks] Create .claude/runtime-manifest.json first. Example:');
    console.error(JSON.stringify({
      runtimeVersion: '3.0.0',
      coreHooks: 'all',
      useRuntimeHome: true,
      legacyScriptsRelativePath: '../../scripts/runtime',
      projectHooks: {}
    }, null, 2));
    process.exit(1);
  }

  const hooksDir = path.join(projectDir, '.claude', 'hooks');
  const settingsPath = path.join(projectDir, '.claude', 'settings.json');
  const versionPath = path.join(projectDir, '.claude', 'runtime', 'runtime-version.json');
  const scriptsRelPath = manifest.scriptsRelativePath || '../runtime/scripts';
  const legacyScriptsRelPath = manifest.legacyScriptsRelativePath || null;
  const useRuntimeHome = manifest.useRuntimeHome ?? (manifest.runtimeVersion && manifest.runtimeVersion.startsWith('3'));

  // Merge preserve list: default + manifest + CLI
  const preserveList = new Set([
    ...DEFAULT_PRESERVE_LIST,
    ...(manifest.preserveHooks || []),
    ...(options.preserve || [])
  ]);

  const mode = options.mode || 'merge'; // merge | overwrite

  ensureDir(hooksDir);

  const results = {
    shellScripts: [],
    preserved: [],
    settingsPatched: false,
    versionWritten: false
  };

  // 1. Generate shell wrappers for core hooks
  const shellsToGenerate = new Map();

  for (const def of Object.values(CORE_HOOKS)) {
    if (manifest.coreHooks !== 'all' && !manifest.coreHooks?.includes?.(def.shellName)) continue;
    shellsToGenerate.set(def.shellName, {
      script: def.script,
      scriptPath: `${scriptsRelPath}/${def.script}`,
      legacyScriptPath: legacyScriptsRelPath ? `${legacyScriptsRelPath}/${def.script === 'session-start.mjs' ? 'runtime-session-start.mjs' : def.script === 'session-end.mjs' ? 'runtime-session-end.mjs' : def.script === 'prompt-context.mjs' ? 'runtime-prompt-context.mjs' : def.script === 'subagent-start.mjs' ? 'runtime-subagent-start.mjs' : def.script === 'stop.mjs' ? 'runtime-stop.mjs' : def.script === 'post-edit.mjs' ? 'runtime-post-edit.mjs' : def.script}` : null,
      args: def.args,
      background: false
    });
  }

  // PostToolUse shell
  if (manifest.coreHooks === 'all' || manifest.coreHooks?.includes?.('PostToolUse')) {
    shellsToGenerate.set(POST_TOOL_USE_CORE.shellName, {
      script: POST_TOOL_USE_CORE.script,
      scriptPath: `${scriptsRelPath}/${POST_TOOL_USE_CORE.script}`,
      legacyScriptPath: legacyScriptsRelPath ? `${legacyScriptsRelPath}/runtime-post-edit.mjs` : null,
      args: POST_TOOL_USE_CORE.args,
      background: POST_TOOL_USE_CORE.background
    });
  }

  for (const [shellName, config] of shellsToGenerate) {
    // Preserve check: if this shell name is in preserve list AND already exists, skip
    const shellPath = path.join(hooksDir, shellName);
    if (preserveList.has(shellName) && fs.existsSync(shellPath) && mode !== 'overwrite') {
      results.preserved.push(shellName);
      continue;
    }

    const content = useRuntimeHome
      ? generateShellWrapper(config.script, config.args, config.background, config.legacyScriptPath)
      : generateLegacyShellWrapper(config.scriptPath, config.args, config.background);
    fs.writeFileSync(shellPath, content, { mode: 0o755 });
    results.shellScripts.push(shellName);
  }

  // Scan for additional preserved hooks already in hooksDir (report only)
  if (fs.existsSync(hooksDir)) {
    for (const file of fs.readdirSync(hooksDir)) {
      if (preserveList.has(file) && !results.preserved.includes(file) && !results.shellScripts.includes(file)) {
        results.preserved.push(file);
      }
    }
  }

  // 2. Patch settings.json
  const existingSettings = loadJson(settingsPath, { hooks: {} });
  const coreHooks = buildCoreSettingsHooks(manifest);
  const mergedHooks = mergeHooks(existingSettings.hooks || {}, coreHooks);
  const updatedSettings = {
    ...existingSettings,
    hooks: mergedHooks
  };
  fs.writeFileSync(settingsPath, JSON.stringify(updatedSettings, null, 2) + '\n');
  results.settingsPatched = true;

  // 3. Write version info
  const { fileURLToPath } = await import('url');
  const sharedPkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const sharedPkg = loadJson(path.join(sharedPkgPath, 'package.json'), { version: 'unknown' });
  const versionInfo = {
    installedVersion: sharedPkg.version,
    installedAt: new Date().toISOString(),
    sharedPackagePath: sharedPkgPath,
    manifestVersion: manifest.runtimeVersion || '1.0.0'
  };
  ensureDir(path.dirname(versionPath));
  fs.writeFileSync(versionPath, JSON.stringify(versionInfo, null, 2) + '\n');
  results.versionWritten = true;

  return results;
}

// ── CLI ────────────────────────────────────────────────────────────

function parseInstallArgs(argv) {
  const args = parseCliArgs(argv);
  args.mode = 'merge';
  args.preserve = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--mode' && argv[i + 1]) { args.mode = argv[i + 1]; i++; }
    else if (argv[i] === '--preserve' && argv[i + 1]) {
      args.preserve = argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean);
      i++;
    }
  }
  return args;
}

const args = parseInstallArgs(process.argv.slice(2));
const projectDir = path.resolve(args.projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd());
const result = await installHooks(projectDir, { mode: args.mode, preserve: args.preserve });
console.log(`[install-hooks] Installed ${result.shellScripts.length} shell scripts: ${result.shellScripts.join(', ')}`);
if (result.preserved.length > 0) {
  console.log(`[install-hooks] Preserved ${result.preserved.length} project-specific hooks: ${result.preserved.join(', ')}`);
}
console.log(`[install-hooks] settings.json patched: ${result.settingsPatched}`);
console.log(`[install-hooks] runtime-version.json written: ${result.versionWritten}`);
