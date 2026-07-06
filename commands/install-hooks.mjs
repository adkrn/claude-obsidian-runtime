#!/usr/bin/env node

/**
 * Hook installer for Obsidian-Claude runtime.
 *
 * Two modes (auto-detected):
 *   1. Template copy mode (Wave 3 B3 contract): copies templates/hooks/*.sh
 *      verbatim into <projectDir>/.claude/hooks/, preserving project-local hooks.
 *      Activated when --from-manifest, --preserve, --dry-run, or --force is set,
 *      OR when no runtime-manifest.json exists in the project.
 *   2. Manifest mode (legacy/Wave 0): generates shell wrappers from
 *      .claude/runtime-manifest.json + patches settings.json + writes version.
 *      Activated when runtime-manifest.json exists and none of the mode flags set.
 *
 * CLI (template copy mode):
 *   --project-dir <path>      target project directory (required)
 *   --preserve <a,b,c>        hook file names to preserve (never overwrite)
 *   --from-manifest           read preserveHooks from runtime-manifest.json
 *   --force                   overwrite existing core hooks
 *   --dry-run                 plan only, no file copy
 *   --help                    show usage
 *
 * Template copy stdout (on success):
 *   {"installed":["..."], "preserved":["..."], "skipped":[{"name":"...","reason":"..."}]}
 *
 * Exit codes:
 *   0 normal
 *   2 argument error
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseCliArgs } from '../core/runtime-lib.mjs';
import { ensureDir, loadJson } from '../core/utils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '..');

// ── Core hook definitions (manifest mode) ──────────────────────────

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

// ── Shell wrapper templates (manifest mode) ────────────────────────

function generateLegacyShellWrapper(scriptRelativePath, args = '', background = false) {
  const bgSuffix = background ? ' &' : '';
  const argsStr = args ? ` \\\n  ${args}` : '';
  return `#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
node "$SCRIPT_DIR/${scriptRelativePath}"${argsStr}${bgSuffix}
`;
}

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

// ── Settings.json patcher (manifest mode) ──────────────────────────

function buildCoreSettingsHooks(manifest) {
  const hooks = {};

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
    const existing = hooks[event].find((e) =>
      e.hooks?.[0]?.command?.includes(def.shellName)
    );
    if (!existing) hooks[event].push(entry);
  }

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
        return coreShellName && cmd.includes(path.basename(coreShellName.split('/').pop()));
      });
      if (!alreadyExists) {
        merged[event].push(entry);
      }
    }
  }

  return merged;
}

// ── Manifest-mode installer ────────────────────────────────────────

async function installFromManifest(projectDir, options = {}) {
  const manifestPath = path.join(projectDir, '.claude', 'runtime-manifest.json');
  const manifest = loadJson(manifestPath, null);

  if (!manifest) {
    console.error(`[install-hooks] runtime-manifest.json not found at ${manifestPath}`);
    console.error('[install-hooks] Create .claude/runtime-manifest.json first or pass --from-templates style flags.');
    process.exit(1);
  }

  const hooksDir = path.join(projectDir, '.claude', 'hooks');
  const settingsPath = path.join(projectDir, '.claude', 'settings.json');
  const versionPath = path.join(projectDir, '.claude', 'runtime', 'runtime-version.json');
  const scriptsRelPath = manifest.scriptsRelativePath || '../runtime/scripts';
  const legacyScriptsRelPath = manifest.legacyScriptsRelativePath || null;
  const useRuntimeHome = manifest.useRuntimeHome ?? (manifest.runtimeVersion && manifest.runtimeVersion.startsWith('3'));

  const preserveList = new Set([
    ...DEFAULT_PRESERVE_LIST,
    ...(manifest.preserveHooks || []),
    ...(options.preserve || [])
  ]);

  const mode = options.mode || 'merge';

  ensureDir(hooksDir);

  const results = {
    shellScripts: [],
    preserved: [],
    settingsPatched: false,
    versionWritten: false
  };

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

  if (fs.existsSync(hooksDir)) {
    for (const file of fs.readdirSync(hooksDir)) {
      if (preserveList.has(file) && !results.preserved.includes(file) && !results.shellScripts.includes(file)) {
        results.preserved.push(file);
      }
    }
  }

  const existingSettings = loadJson(settingsPath, { hooks: {} });
  const coreHooks = buildCoreSettingsHooks(manifest);
  const mergedHooks = mergeHooks(existingSettings.hooks || {}, coreHooks);
  const updatedSettings = { ...existingSettings, hooks: mergedHooks };
  fs.writeFileSync(settingsPath, JSON.stringify(updatedSettings, null, 2) + '\n');
  results.settingsPatched = true;

  const sharedPkg = loadJson(path.join(PACKAGE_ROOT, 'package.json'), { version: 'unknown' });
  const versionInfo = {
    installedVersion: sharedPkg.version,
    installedAt: new Date().toISOString(),
    sharedPackagePath: PACKAGE_ROOT,
    manifestVersion: manifest.runtimeVersion || '1.0.0'
  };
  ensureDir(path.dirname(versionPath));
  fs.writeFileSync(versionPath, JSON.stringify(versionInfo, null, 2) + '\n');
  results.versionWritten = true;

  // Refresh engine-managed slash-command instructions (task-close.md, ...).
  // preserveList doubles as the command opt-out (same manifest.preserveHooks list).
  const cmdSync = syncCommandTemplates(projectDir, PACKAGE_ROOT, { preserve: [...preserveList] });
  results.commandsCopied = cmdSync.copied;
  results.commandsBackedUp = cmdSync.backedUp;

  return results;
}

// ── Template-copy installer (Wave 3 B3 contract) ───────────────────

/**
 * Lists core hook files under templates/hooks/ (read-only).
 * @returns {string[]} basenames
 */
function listTemplateCoreHooks() {
  const dir = path.join(PACKAGE_ROOT, 'templates', 'hooks');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.sh')).sort();
}

/**
 * Sync engine slash-command instruction files (templates/commands/*.md) into a
 * project's .claude/commands/. These are ENGINE-MANAGED instructions (task-close,
 * task-start, ...), not user content — improving them in the package is useless
 * unless they reach project copies. Prior to this, only init-project copied them
 * once and no upgrade path refreshed them, so every project drifted (e.g. the
 * trigger_keywords guidance never landed → decision/architecture/troubleshooting
 * rows shipped with empty search signals).
 *
 * Safety: a changed copy is backed up to `<file>.bak` before overwrite (won't
 * clobber an existing .bak). Identical copies are skipped (idempotent). A file
 * listed in `options.preserve` is left untouched (user opt-out).
 *
 * @param {string} projectDir
 * @param {string} [packageRoot]  defaults to this package's root
 * @param {{ preserve?: string[] }} [options]
 * @returns {{ copied: string[], backedUp: string[], preserved: string[] }}
 */
export function syncCommandTemplates(projectDir, packageRoot = PACKAGE_ROOT, options = {}) {
  const srcDir = path.join(packageRoot, 'templates', 'commands');
  const result = { copied: [], backedUp: [], preserved: [] };
  if (!fs.existsSync(srcDir)) return result;

  const preserve = new Set(options.preserve || []);
  const dstDir = path.join(projectDir, '.claude', 'commands');
  ensureDir(dstDir);

  for (const name of fs.readdirSync(srcDir).filter((f) => f.endsWith('.md')).sort()) {
    if (preserve.has(name)) {
      result.preserved.push(name);
      continue;
    }
    const src = path.join(srcDir, name);
    const dst = path.join(dstDir, name);
    const next = fs.readFileSync(src, 'utf8');

    if (fs.existsSync(dst)) {
      const current = fs.readFileSync(dst, 'utf8');
      if (current === next) continue; // already up to date — no rewrite, no backup
      const bak = `${dst}.bak`;
      if (!fs.existsSync(bak)) fs.copyFileSync(dst, bak);
      result.backedUp.push(name);
    }
    fs.writeFileSync(dst, next, 'utf8');
    result.copied.push(name);
  }
  return result;
}

/**
 * Reads manifest.preserveHooks from project runtime-manifest.json (raw fs).
 * @param {string} projectDir
 * @returns {string[]}
 */
function readManifestPreserveList(projectDir) {
  const manifestPath = path.join(projectDir, '.claude', 'runtime-manifest.json');
  if (!fs.existsSync(manifestPath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return Array.isArray(data.preserveHooks) ? data.preserveHooks : [];
  } catch {
    return [];
  }
}

/**
 * Template copy installer.
 * @param {string} projectDir
 * @param {object} options
 * @param {string[]} [options.preserve]    extra preserve list (merged with manifest list if --from-manifest)
 * @param {boolean} [options.fromManifest] merge with manifest.preserveHooks
 * @param {boolean} [options.force]        overwrite existing core hooks
 * @param {boolean} [options.dryRun]       plan only; no writes
 * @returns {{installed:string[], preserved:string[], skipped:{name:string,reason:string}[]}}
 */
function installFromTemplates(projectDir, options = {}) {
  const installed = [];
  const preserved = [];
  const skipped = [];

  const coreHooks = listTemplateCoreHooks();
  const templateDir = path.join(PACKAGE_ROOT, 'templates', 'hooks');

  const preserveSet = new Set(options.preserve || []);
  if (options.fromManifest) {
    for (const name of readManifestPreserveList(projectDir)) preserveSet.add(name);
  }

  const hooksDir = path.join(projectDir, '.claude', 'hooks');
  if (!options.dryRun) ensureDir(hooksDir);

  for (const name of coreHooks) {
    const dst = path.join(hooksDir, name);
    const exists = fs.existsSync(dst);

    if (exists && preserveSet.has(name)) {
      preserved.push(name);
      continue;
    }
    if (exists && !options.force) {
      skipped.push({ name, reason: 'exists, use --force to overwrite' });
      continue;
    }

    if (!options.dryRun) {
      const src = path.join(templateDir, name);
      fs.copyFileSync(src, dst);
      try { fs.chmodSync(dst, 0o755); } catch {
        // chmod may fail on Windows; ignore silently
      }
    }
    installed.push(name);
  }

  // Also report user-extended preserveHooks that already live in hooksDir
  if (fs.existsSync(hooksDir)) {
    for (const f of fs.readdirSync(hooksDir)) {
      if (preserveSet.has(f) && !preserved.includes(f) && !coreHooks.includes(f)) {
        preserved.push(f);
      }
    }
  }

  // Refresh engine-managed slash-command instructions alongside hooks.
  const commandSync = options.dryRun
    ? { copied: [], backedUp: [], preserved: [] }
    : syncCommandTemplates(projectDir, PACKAGE_ROOT, { preserve: [...preserveSet] });

  return { installed, preserved, skipped, commandsCopied: commandSync.copied, commandsBackedUp: commandSync.backedUp };
}

// ── CLI ────────────────────────────────────────────────────────────

const HELP_TEXT = `Usage: install-hooks --project-dir <path> [options]

Options:
  --project-dir <path>    Target project directory (required)
  --preserve <a,b,c>      Comma-separated hook names to preserve (never overwrite)
  --from-manifest         Read preserveHooks from <projectDir>/.claude/runtime-manifest.json
  --force                 Overwrite existing core hook files
  --dry-run               Print plan only; do not copy files
  --help                  Show this message

Modes:
  - Template copy mode (default when any above flag is used OR no runtime-manifest.json):
      Copies templates/hooks/*.sh into <projectDir>/.claude/hooks/.
      Prints JSON {"installed":[...], "preserved":[...], "skipped":[...]}.
  - Manifest mode (legacy): activated when runtime-manifest.json exists
      and no template-copy flag is set. Writes shell wrappers +
      patches .claude/settings.json + writes runtime-version.json.

Exit codes:
  0   success (skips are OK)
  2   argument error
`;

function parseInstallArgs(argv) {
  const args = parseCliArgs(argv);
  args.mode = 'merge';
  args.preserve = [];
  args.fromManifest = false;
  args.force = false;
  args.dryRun = false;
  args.help = false;
  args.explicitTemplateFlag = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode' && argv[i + 1]) { args.mode = argv[i + 1]; i++; }
    else if (a === '--preserve' && argv[i + 1]) {
      args.preserve = argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean);
      args.explicitTemplateFlag = true;
      i++;
    } else if (a === '--from-manifest') { args.fromManifest = true; args.explicitTemplateFlag = true; }
    else if (a === '--force') { args.force = true; args.explicitTemplateFlag = true; }
    else if (a === '--dry-run') { args.dryRun = true; args.explicitTemplateFlag = true; }
    else if (a === '--help' || a === '-h') { args.help = true; }
  }
  return args;
}

function shouldUseTemplateMode(args, projectDir) {
  if (args.explicitTemplateFlag) return true;
  const manifestPath = path.join(projectDir, '.claude', 'runtime-manifest.json');
  return !fs.existsSync(manifestPath);
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseInstallArgs(argv);

  if (args.help) {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
  }

  const rawProjectDir = args.projectDir || process.env.CLAUDE_PROJECT_DIR;
  if (!rawProjectDir) {
    process.stderr.write('[install-hooks] --project-dir is required\n');
    process.stderr.write(HELP_TEXT);
    process.exit(2);
  }
  const projectDir = path.resolve(rawProjectDir);

  if (shouldUseTemplateMode(args, projectDir)) {
    const result = installFromTemplates(projectDir, {
      preserve: args.preserve,
      fromManifest: args.fromManifest,
      force: args.force,
      dryRun: args.dryRun
    });
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
  }

  // Legacy manifest mode
  const result = await installFromManifest(projectDir, { mode: args.mode, preserve: args.preserve });
  console.log(`[install-hooks] Installed ${result.shellScripts.length} shell scripts: ${result.shellScripts.join(', ')}`);
  if (result.preserved.length > 0) {
    console.log(`[install-hooks] Preserved ${result.preserved.length} project-specific hooks: ${result.preserved.join(', ')}`);
  }
  console.log(`[install-hooks] settings.json patched: ${result.settingsPatched}`);
  console.log(`[install-hooks] runtime-version.json written: ${result.versionWritten}`);
}

// Exported for tests
export { installFromTemplates, listTemplateCoreHooks, readManifestPreserveList, DEFAULT_PRESERVE_LIST };

const invokedDirectly = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}` || process.argv[1] === __filename;
  } catch {
    return true;
  }
})();

if (invokedDirectly) {
  await main();
}
