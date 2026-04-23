/**
 * doctor 11 independent check functions.
 *
 * Wave 1-B1 scope:
 *   C01, C02, C03, C04, C05, C06, C07, C08, C10, C11, C12 (11 checks)
 *   C09 checkTaskStartDryRun => TODO Wave 2 (depends on task-start --dry-run).
 *
 * Common contract:
 *   Every check consumes a CheckContext and returns a Check record.
 *   All checks are independent and side-effect free (read-only diagnostics).
 */

import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { validateManifest } from './manifest-schema.mjs';

/**
 * @typedef {Object} CheckContext
 * @property {string} projectDir
 * @property {string} packageRoot            CLAUDE_RUNTIME_HOME or deriving path
 * @property {object|null} [manifest]        Parsed runtime-manifest.json
 * @property {object|null} [paths]           Parsed obsidian_paths.json
 */

/**
 * @typedef {Object} Check
 * @property {string} id         c01..c12
 * @property {string} name
 * @property {'pass'|'warn'|'fail'|'pending'} status
 * @property {string} message
 * @property {{remedy?:string, data?:unknown}} [detail]
 * @property {number} [elapsedMs]
 */

/**
 * §12-5 default managed roots (9 roots).
 */
export const DEFAULT_MANAGED_ROOTS = [
  '00_Home',
  '04_Architecture',
  '06_Troubleshooting',
  '07_Decisions',
  '08_Lessons',
  '08_Reflections',
  '09_Templates',
  '09_Templates/Procedures',
  '10_Worklogs'
];

export const EXPECTED_CORE_HOOKS = [
  'runtime-session-start.sh',
  'runtime-prompt-context.sh',
  'runtime-subagent-start.sh',
  'runtime-stop.sh',
  'runtime-session-end.sh',
  'runtime-post-edit.sh'
];

const MIN_NODE_MAJOR = 20;
const MIN_GIT = [2, 40, 0];
const LAST_CONTEXT_BYTE_LIMIT = 1 * 1024 * 1024; // 1MB
const PERF_TOKEN_SKEW_THRESHOLD = 0.30; // 30% max/min deviation

function makeCheck(id, name) {
  return { id, name, status: 'pending', message: '' };
}

function now() {
  return Date.now();
}

function finishPass(check, start, message, detail) {
  check.status = 'pass';
  check.message = message || 'OK';
  if (detail) check.detail = detail;
  check.elapsedMs = now() - start;
  return check;
}

function finishWarn(check, start, message, detail) {
  check.status = 'warn';
  check.message = message;
  if (detail) check.detail = detail;
  check.elapsedMs = now() - start;
  return check;
}

function finishFail(check, start, message, detail) {
  check.status = 'fail';
  check.message = message;
  if (detail) check.detail = detail;
  check.elapsedMs = now() - start;
  return check;
}

function loadJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function fileSha256Hex(filePath) {
  try {
    const data = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(data).digest('hex');
  } catch {
    return '';
  }
}

/**
 * C01 — CLAUDE_RUNTIME_HOME env + package.json reachable.
 * @param {CheckContext} ctx
 * @returns {Check}
 */
export function checkRuntimeHome(ctx) {
  const start = now();
  const check = makeCheck('c01', 'CLAUDE_RUNTIME_HOME');
  const home = process.env.CLAUDE_RUNTIME_HOME || ctx.packageRoot;
  if (!home) {
    return finishFail(check, start, 'CLAUDE_RUNTIME_HOME not set or invalid', {
      remedy: 'export CLAUDE_RUNTIME_HOME=<absolute path>'
    });
  }
  if (!fs.existsSync(home)) {
    return finishFail(check, start, `Directory does not exist: ${home}`, {
      remedy: 'Check the path or clone claude-obsidian-runtime there.'
    });
  }
  const pkg = path.join(home, 'package.json');
  if (!fs.existsSync(pkg)) {
    return finishFail(check, start, `No package.json found in ${home}`, {
      remedy: 'Verify CLAUDE_RUNTIME_HOME points to the package root.'
    });
  }
  return finishPass(check, start, `Set to ${home}`);
}

/**
 * C02 — runtime-manifest.json 6-axis + extension schema.
 * @param {CheckContext} ctx
 * @returns {Check}
 */
export function checkManifestSchema(ctx) {
  const start = now();
  const check = makeCheck('c02', 'runtime-manifest.json (6-axis)');
  const manifestPath = path.join(ctx.projectDir, '.claude', 'runtime-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return finishFail(check, start, `Missing at ${manifestPath}`, {
      remedy: 'Run: claude-obsidian-runtime init --project-id <id>'
    });
  }
  const data = loadJsonSafe(manifestPath);
  if (data === null) {
    return finishFail(check, start, `Invalid JSON at ${manifestPath}`);
  }
  const result = validateManifest(data);
  if (!result.valid) {
    const missing = result.errors.filter((e) => e.severity === 'fail').map((e) => e.path);
    return finishFail(check, start, `Manifest schema invalid: ${missing.length} field(s) missing/malformed: ${missing.join(', ')}`, {
      remedy: `Run: claude-obsidian-runtime init --project-id ${data.projectTag || '<id>'}`,
      data: { errors: result.errors }
    });
  }
  // expose parsed manifest to subsequent checks via ctx reference
  ctx.manifest = data;
  const axisSummary = `6/6 axes valid (projectTag=${data.projectTag || '?'})`;
  return finishPass(check, start, axisSummary, { data: { manifest: data } });
}

/**
 * C03 — document/obsidian_context/_meta/obsidian_paths.json + vaultRoot reachable.
 * @param {CheckContext} ctx
 * @returns {Check}
 */
export function checkObsidianPaths(ctx) {
  const start = now();
  const check = makeCheck('c03', 'obsidian_paths.json');
  const p = path.join(ctx.projectDir, 'document', 'obsidian_context', '_meta', 'obsidian_paths.json');
  if (!fs.existsSync(p)) {
    return finishWarn(check, start, `Missing at ${p} (Obsidian mirror disabled)`, {
      remedy: 'Run: claude-obsidian-runtime init'
    });
  }
  const data = loadJsonSafe(p);
  if (data === null) {
    return finishFail(check, start, `Invalid JSON at ${p}`);
  }
  if (!data.vaultRoot) {
    return finishWarn(check, start, 'No vaultRoot declared (Obsidian mirror disabled)');
  }
  if (!path.isAbsolute(data.vaultRoot)) {
    return finishFail(check, start, `vaultRoot must be absolute: ${data.vaultRoot}`);
  }
  if (!fs.existsSync(data.vaultRoot)) {
    return finishFail(check, start, `vaultRoot not accessible: ${data.vaultRoot}`);
  }
  ctx.paths = data;
  const managedCount = Array.isArray(data.managedRoots) ? data.managedRoots.length : 0;
  return finishPass(check, start, `vaultRoot: ${data.vaultRoot}, managedRoots: ${managedCount}`);
}

function resolveManagedRootsList(ctx) {
  const fromManifest = ctx.manifest?.managedRoots;
  if (Array.isArray(fromManifest)) return fromManifest;
  const fromPaths = ctx.paths?.managedRoots;
  if (Array.isArray(fromPaths)) return fromPaths;
  return DEFAULT_MANAGED_ROOTS.slice();
}

/**
 * C04 — managedRoots folders exist under vaultRoot.
 * @param {CheckContext} ctx
 * @returns {Check}
 */
export function checkManagedRoots(ctx) {
  const start = now();
  const check = makeCheck('c04', 'managedRoots folders');
  const vaultRoot = ctx.paths?.vaultRoot;
  if (!vaultRoot) {
    return finishWarn(check, start, 'vaultRoot unavailable — skipped');
  }
  const roots = resolveManagedRootsList(ctx);
  if (roots.length === 0) {
    return finishPass(check, start, '0 managed root(s) declared (explicit empty)');
  }
  const missing = [];
  for (const root of roots) {
    const full = path.isAbsolute(root) ? root : path.join(vaultRoot, root);
    if (!fs.existsSync(full)) missing.push(root);
  }
  if (missing.length > 0) {
    return finishWarn(
      check,
      start,
      `${missing.length} managed root(s) not created yet — will be created on first write`,
      { data: { missing, total: roots.length } }
    );
  }
  return finishPass(check, start, `${roots.length} root(s) exist under vaultRoot`);
}

/**
 * C05 — hook wrappers + preserveHooks listing + bash syntax when available.
 * @param {CheckContext} ctx
 * @returns {Check}
 */
export function checkHookWrappers(ctx) {
  const start = now();
  const check = makeCheck('c05', 'hook wrappers + preserveHooks');
  const dir = path.join(ctx.projectDir, '.claude', 'hooks');
  if (!fs.existsSync(dir)) {
    return finishFail(check, start, `Hooks dir missing: ${dir}`, {
      remedy: 'Run: claude-obsidian-runtime install-hooks'
    });
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sh'));
  const missingCore = EXPECTED_CORE_HOOKS.filter((h) => !files.includes(h));
  const preserve = Array.isArray(ctx.manifest?.preserveHooks) ? ctx.manifest.preserveHooks : [];
  const missingPreserve = preserve.filter((h) => !files.includes(h));

  if (missingCore.length > 0) {
    return finishFail(check, start, `Missing core hook(s): ${missingCore.join(', ')}`, {
      remedy: 'Run: claude-obsidian-runtime install-hooks',
      data: { missingCore, missingPreserve }
    });
  }

  const failures = [];
  let bashAvailable = true;
  for (const file of files) {
    const full = path.join(dir, file);
    const result = spawnSync('bash', ['-n', full], { encoding: 'utf8' });
    if (result.error) {
      bashAvailable = false;
      break;
    }
    if (result.status !== 0) {
      failures.push({ file, stderr: String(result.stderr || '').slice(0, 200) });
    }
  }

  if (!bashAvailable) {
    return finishWarn(
      check,
      start,
      `${files.length} wrapper(s) present, bash unavailable — syntax check skipped`,
      { data: { missingPreserve } }
    );
  }
  if (failures.length > 0) {
    return finishFail(check, start, `bash syntax error in ${failures.length} wrapper(s)`, {
      data: { failures }
    });
  }
  if (missingPreserve.length > 0) {
    return finishWarn(
      check,
      start,
      `${files.length} wrapper(s) parse cleanly; missing preserveHook(s): ${missingPreserve.join(', ')}`,
      { data: { missingPreserve } }
    );
  }
  return finishPass(
    check,
    start,
    `${EXPECTED_CORE_HOOKS.length} core + ${preserve.length} preserve wrapper(s) parse cleanly`
  );
}

/**
 * C06 — .claude/agents/<projectId>-lead.md presence + frontmatter.
 * @param {CheckContext} ctx
 * @returns {Check}
 */
export function checkLeadAgent(ctx) {
  const start = now();
  const check = makeCheck('c06', '<projectId>-lead agent');
  const projectId = ctx.manifest?.projectTag;
  if (!projectId || typeof projectId !== 'string') {
    return finishWarn(check, start, 'projectTag unavailable — skipped (run C02 first)');
  }
  const p = path.join(ctx.projectDir, '.claude', 'agents', `${projectId}-lead.md`);
  if (!fs.existsSync(p)) {
    return finishFail(check, start, `Lead agent missing: .claude/agents/${projectId}-lead.md`, {
      remedy: 'claude-obsidian-runtime init --lead-only'
    });
  }
  let body = '';
  try {
    body = fs.readFileSync(p, 'utf8');
  } catch (err) {
    return finishFail(check, start, `Cannot read lead agent: ${err.message}`);
  }
  // Frontmatter: must start with --- and include `name: <projectId>-lead` and `tools:`
  const frontMatch = body.match(/^---\n([\s\S]*?)\n---/);
  if (!frontMatch) {
    return finishFail(check, start, `Lead agent has no YAML frontmatter: ${p}`);
  }
  const front = frontMatch[1];
  const nameRe = new RegExp(`^name:\\s*${projectId}-lead\\s*$`, 'm');
  if (!nameRe.test(front)) {
    return finishFail(check, start, `Lead agent frontmatter must declare name: ${projectId}-lead`);
  }
  if (!/^tools:/m.test(front)) {
    return finishFail(check, start, `Lead agent frontmatter must declare tools:`);
  }
  return finishPass(check, start, `.claude/agents/${projectId}-lead.md valid`);
}

/**
 * C07 — code-index JSONL parse.
 * @param {CheckContext} ctx
 * @returns {Check}
 */
export function checkCodeIndex(ctx) {
  const start = now();
  const check = makeCheck('c07', 'code-index/*.jsonl');
  const dir = path.join(ctx.projectDir, '.claude', 'runtime', 'code-index');
  if (!fs.existsSync(dir)) {
    return finishWarn(check, start, 'No code-index dir yet', {
      remedy: 'Run: claude-obsidian-runtime memory-refresh'
    });
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  if (files.length === 0) {
    return finishWarn(check, start, 'No index files yet', {
      remedy: 'Run: claude-obsidian-runtime memory-refresh'
    });
  }
  let total = 0;
  const malformed = [];
  for (const f of files) {
    const full = path.join(dir, f);
    let content;
    try {
      content = fs.readFileSync(full, 'utf8');
    } catch (err) {
      malformed.push({ file: f, error: err.message });
      continue;
    }
    const lines = content.split(/\r?\n/).filter(Boolean);
    for (const [idx, line] of lines.entries()) {
      try {
        JSON.parse(line);
        total += 1;
      } catch {
        malformed.push({ file: f, line: idx + 1 });
      }
    }
  }
  if (malformed.length > 0) {
    return finishFail(check, start, `${malformed.length} malformed JSONL row(s)`, {
      data: { malformed: malformed.slice(0, 10) }
    });
  }
  return finishPass(check, start, `${files.length} index file(s), ${total} total rows`);
}

/**
 * C08 — knowledge/*.jsonl (lessons/troubleshooting/decisions) parse.
 * @param {CheckContext} ctx
 * @returns {Check}
 */
export function checkKnowledgeIndex(ctx) {
  const start = now();
  const check = makeCheck('c08', 'knowledge/*.jsonl');
  const dir = path.join(ctx.projectDir, '.claude', 'runtime', 'knowledge');
  if (!fs.existsSync(dir)) {
    return finishWarn(check, start, 'No knowledge dir yet', {
      remedy: 'Run: claude-obsidian-runtime memory-refresh'
    });
  }
  const expected = ['lessons.jsonl', 'troubleshooting.jsonl', 'decisions.jsonl'];
  const report = {};
  let malformedTotal = 0;
  const missing = [];
  for (const name of expected) {
    const full = path.join(dir, name);
    if (!fs.existsSync(full)) {
      missing.push(name);
      report[name] = 'missing';
      continue;
    }
    let content;
    try {
      content = fs.readFileSync(full, 'utf8');
    } catch (err) {
      malformedTotal += 1;
      report[name] = `read error: ${err.message}`;
      continue;
    }
    const lines = content.split(/\r?\n/).filter(Boolean);
    let parsed = 0;
    let seeds = 0;
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        parsed += 1;
        if (typeof row.id === 'string' && row.id.startsWith('seed:')) seeds += 1;
      } catch {
        malformedTotal += 1;
      }
    }
    report[name] = `${parsed} rows (${seeds} seed)`;
  }
  if (malformedTotal > 0) {
    return finishFail(check, start, `${malformedTotal} malformed JSONL row(s) across knowledge files`, {
      data: { report },
      remedy: 'Run: claude-obsidian-runtime memory-refresh'
    });
  }
  if (missing.length === expected.length) {
    return finishWarn(check, start, 'No knowledge index files yet', {
      remedy: 'Run: claude-obsidian-runtime memory-refresh'
    });
  }
  if (missing.length > 0) {
    return finishWarn(check, start, `partial knowledge: ${missing.join(', ')} missing`, {
      data: { report }
    });
  }
  return finishPass(
    check,
    start,
    Object.entries(report)
      .map(([k, v]) => `${k.replace('.jsonl', '')}=${v}`)
      .join(', ')
  );
}

/* --------------------------------------------------------------------
 * C09 checkTaskStartDryRun (Wave 2 — PATCH_Phase1 §3-D)
 * Spawn contract:
 *   node ${packageRoot}/commands/task-start.mjs --dry-run
 *        --task "doctor probe" --project-dir <projectDir>
 *   SUCCESS = exit 0 + last-line JSON with 9 required fields.
 * -------------------------------------------------------------------- */

const DOCTOR_TIMEOUT_MS = Number(process.env.DOCTOR_TIMEOUT_MS || 30000);

const REQUIRED_DRY_RUN_FIELDS = [
  'taskId',
  'readFirst',
  'codeHits',
  'knowledgeHits',
  'guardrails',
  'matchedScopes',
  'matchedGroups',
  'currentTaskPath',
  'lastContextPath'
];

/**
 * C09 — task-start --dry-run JSON schema (9 required fields).
 * @param {CheckContext} ctx
 * @returns {Check}
 */
export function checkTaskStartDryRun(ctx) {
  const start = now();
  const check = makeCheck('c09', 'task-start dry-run schema');
  const taskStartPath = path.join(ctx.packageRoot, 'commands', 'task-start.mjs');
  if (!fs.existsSync(taskStartPath)) {
    return finishFail(check, start, `task-start CLI missing: ${taskStartPath}`, {
      remedy: 'Reinstall: npm install -g claude-obsidian-runtime@latest'
    });
  }

  const env = { ...process.env };
  env.CLAUDE_PROJECT_DIR = ctx.projectDir;
  env.SESSION_ID = `doctor-probe-${Date.now()}`;

  let result;
  try {
    result = spawnSync(
      process.execPath,
      [
        taskStartPath,
        '--dry-run',
        '--task',
        'doctor probe',
        '--project-dir',
        ctx.projectDir
      ],
      {
        encoding: 'utf8',
        timeout: DOCTOR_TIMEOUT_MS,
        env
      }
    );
  } catch (err) {
    return finishFail(check, start, `spawn failed: ${err.message}`);
  }

  if (result.error) {
    const msg = result.error.code === 'ETIMEDOUT'
      ? `timed out after ${DOCTOR_TIMEOUT_MS}ms`
      : `spawn error: ${result.error.message}`;
    return finishFail(check, start, msg);
  }

  if (result.status !== 0) {
    const stderrSnip = String(result.stderr || '').trim().slice(0, 200);
    return finishFail(
      check,
      start,
      `task-start exited ${result.status}${stderrSnip ? `: ${stderrSnip}` : ''}`
    );
  }

  const stdout = String(result.stdout || '').trim();
  if (!stdout) {
    return finishFail(check, start, 'task-start produced no stdout');
  }
  const lastLine = stdout.split(/\r?\n/).filter(Boolean).at(-1) || '';
  let json;
  try {
    json = JSON.parse(lastLine);
  } catch {
    return finishFail(check, start, 'task-start stdout last line is not JSON', {
      data: { lastLine: lastLine.slice(0, 200) }
    });
  }

  const missing = REQUIRED_DRY_RUN_FIELDS.filter((k) => !(k in json));
  if (missing.length > 0) {
    return finishFail(
      check,
      start,
      `${missing.length}/9 field(s) missing: ${missing.join(', ')}`,
      { data: { missing } }
    );
  }

  const elapsed = now() - start;
  return finishPass(
    check,
    start,
    `9/9 fields present, ${elapsed}ms`
  );
}

function parseSemver(text) {
  const match = String(text || '').match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] || 0)];
}

function semverLt(a, b) {
  for (let i = 0; i < 3; i++) {
    const av = a[i] || 0;
    const bv = b[i] || 0;
    if (av < bv) return true;
    if (av > bv) return false;
  }
  return false;
}

/**
 * C10 — Node / git / (optional) tmux prerequisites.
 * @param {CheckContext} _ctx
 * @returns {Check}
 */
export function checkPrerequisites(_ctx) {
  const start = now();
  const check = makeCheck('c10', 'Prerequisites (node/git/tmux)');
  const nodeVer = parseSemver(process.versions.node);
  if (!nodeVer || nodeVer[0] < MIN_NODE_MAJOR) {
    return finishFail(check, start, `Node ${process.versions.node} is older than ${MIN_NODE_MAJOR}.x`, {
      remedy: 'Install Node 20+ (https://nodejs.org)'
    });
  }
  let gitVer = null;
  try {
    const git = spawnSync('git', ['--version'], { encoding: 'utf8' });
    if (git.status === 0) gitVer = parseSemver(git.stdout || git.stderr || '');
  } catch {
    gitVer = null;
  }
  if (!gitVer) {
    return finishFail(check, start, 'git not found on PATH', {
      remedy: 'Install git 2.40+'
    });
  }
  if (semverLt(gitVer, MIN_GIT)) {
    return finishFail(
      check,
      start,
      `git ${gitVer.join('.')} is older than ${MIN_GIT.join('.')}`,
      { remedy: 'Upgrade git to 2.40+' }
    );
  }
  let tmuxVer = null;
  try {
    const tmux = spawnSync('tmux', ['-V'], { encoding: 'utf8' });
    if (tmux.status === 0) tmuxVer = parseSemver(tmux.stdout || '');
  } catch {
    tmuxVer = null;
  }
  const tmuxSummary = tmuxVer ? `${tmuxVer[0]}.${tmuxVer[1]}` : 'N/A';
  return finishPass(
    check,
    start,
    `node v${process.versions.node}, git ${gitVer.join('.')}, tmux ${tmuxSummary}`
  );
}

/**
 * C11 — template file integrity (presence + sha256 vs templates/_manifest.json).
 * @param {CheckContext} ctx
 * @returns {Check}
 */
export function checkTemplateIntegrity(ctx) {
  const start = now();
  const check = makeCheck('c11', 'Template integrity');
  const root = ctx.packageRoot;
  if (!root) {
    return finishFail(check, start, 'packageRoot unavailable');
  }
  const templatesDir = path.join(root, 'templates');
  if (!fs.existsSync(templatesDir)) {
    return finishFail(check, start, `Templates dir missing: ${templatesDir}`, {
      remedy: 'Reinstall: npm install -g claude-obsidian-runtime@latest'
    });
  }
  const manifestPath = path.join(templatesDir, '_manifest.json');
  if (!fs.existsSync(manifestPath)) {
    // PATCH_Phase1 §5-B — manifest is generated at package publish time;
    // not yet produced during Wave 1. Downgrade to warn so doctor still runs.
    return finishWarn(
      check,
      start,
      'templates/_manifest.json not present (pre-publish or legacy install)',
      { remedy: 'Wait for Wave 3 build-template-manifest.mjs or reinstall package' }
    );
  }
  const manifest = loadJsonSafe(manifestPath);
  if (!manifest || !Array.isArray(manifest.files)) {
    return finishFail(check, start, `Invalid templates/_manifest.json`, {
      remedy: 'Reinstall package'
    });
  }
  const mismatches = [];
  const missing = [];
  for (const entry of manifest.files) {
    if (!entry || typeof entry.relPath !== 'string') continue;
    const full = path.join(templatesDir, entry.relPath);
    if (!fs.existsSync(full)) {
      if (entry.required) missing.push(entry.relPath);
      continue;
    }
    const sha = fileSha256Hex(full);
    if (sha && typeof entry.sha256 === 'string' && sha !== entry.sha256) {
      mismatches.push({ relPath: entry.relPath, expected: entry.sha256, actual: sha });
    }
  }
  if (missing.length > 0 || mismatches.length > 0) {
    return finishFail(
      check,
      start,
      `template integrity broken: ${missing.length} missing, ${mismatches.length} mismatched`,
      {
        data: { missing, mismatches: mismatches.slice(0, 5) },
        remedy: 'Reinstall: npm install -g claude-obsidian-runtime@latest'
      }
    );
  }
  return finishPass(check, start, `${manifest.files.length} template file(s), checksums match`);
}

function loadRecentTaskUsage(dir, count = 3) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const full = path.join(dir, f);
      let mtime = 0;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch {
        return null;
      }
      return { full, mtime };
    })
    .filter(Boolean);
  entries.sort((a, b) => b.mtime - a.mtime);
  return entries.slice(0, count).map((e) => loadJsonSafe(e.full)).filter(Boolean);
}

function extractTokenTotal(record) {
  if (!record) return 0;
  if (typeof record.totalTokens === 'number') return record.totalTokens;
  if (record.usage && typeof record.usage.totalTokens === 'number') return record.usage.totalTokens;
  if (typeof record.tokens === 'number') return record.tokens;
  if (record.summary && typeof record.summary.totalTokens === 'number') return record.summary.totalTokens;
  return 0;
}

/**
 * C12 — Performance observability — last-context size + token skew over last 3 tasks.
 * @param {CheckContext} ctx
 * @returns {Check}
 */
export function checkPerformanceObservability(ctx) {
  const start = now();
  const check = makeCheck('c12', 'Performance observability');
  const runtimeRoot = path.join(ctx.projectDir, '.claude', 'runtime');

  const lastContextPath = path.join(runtimeRoot, 'retrieval', 'last-context.json');
  if (!fs.existsSync(lastContextPath)) {
    return finishWarn(check, start, 'last-context.json missing (no task runs yet)');
  }
  let size = 0;
  try {
    size = fs.statSync(lastContextPath).size;
  } catch (err) {
    return finishFail(check, start, `cannot stat last-context.json: ${err.message}`);
  }
  if (size > LAST_CONTEXT_BYTE_LIMIT) {
    return finishFail(
      check,
      start,
      `last-context.json is ${(size / 1024).toFixed(0)}KB (>1MB limit)`,
      { remedy: 'Run: claude-obsidian-runtime memory-refresh' }
    );
  }

  const usageDir = path.join(runtimeRoot, 'task-usage');
  const recent = loadRecentTaskUsage(usageDir, 3);
  if (recent.length < 3) {
    return finishWarn(
      check,
      start,
      `last-context ${(size / 1024).toFixed(0)}KB, need 3 task-usage records (have ${recent.length})`
    );
  }
  const totals = recent.map(extractTokenTotal).filter((n) => n > 0);
  if (totals.length < 3) {
    return finishWarn(check, start, `last-context ${(size / 1024).toFixed(0)}KB, token totals missing`);
  }
  const maxTok = Math.max(...totals);
  const minTok = Math.min(...totals);
  const skew = minTok > 0 ? (maxTok - minTok) / minTok : 0;
  if (skew >= PERF_TOKEN_SKEW_THRESHOLD) {
    return finishFail(
      check,
      start,
      `Performance drift: 3-task token skew ${(skew * 100).toFixed(0)}% (>=${PERF_TOKEN_SKEW_THRESHOLD * 100}%)`,
      { remedy: 'Run: claude-obsidian-runtime memory-refresh' }
    );
  }
  return finishPass(
    check,
    start,
    `last-context ${(size / 1024).toFixed(0)}KB, 3-task token skew ${(skew * 100).toFixed(0)}%`
  );
}

export const ALL_CHECK_IDS = [
  'c01',
  'c02',
  'c03',
  'c04',
  'c05',
  'c06',
  'c07',
  'c08',
  'c09',
  'c10',
  'c11',
  'c12'
];
