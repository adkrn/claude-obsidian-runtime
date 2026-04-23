/**
 * doctor --full automatic rollback (§12-4, Design-B §2-4).
 *
 * Flow:
 *   1. Scan projectDir for `.claude.backup-<timestamp>/` folders.
 *   2. Diff current .claude/ against the latest backup.
 *   3. Prompt the user (TTY) to confirm rollback.
 *   4. On confirm, restore files and emit partial-restore.log on errors.
 *
 * Contract:
 *   - Automatic rollback only triggers when caller passes `sinceInit = true`.
 *   - `noInteractive = true` (from --no-rollback-on-failure or non-TTY stdin) skips the prompt.
 *   - Rollback success signals exit code 2 via the caller (vs. 1 for plain failure).
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import crypto from 'crypto';

/**
 * @typedef {Object} DiffLine
 * @property {'M'|'A'|'D'} status   modified / added (backup missing) / deleted (current missing)
 * @property {string} relativePath  path relative to projectDir
 */

/**
 * @typedef {Object} RollbackOptions
 * @property {string} projectDir
 * @property {string} backupDir    absolute path `.claude.backup-<timestamp>/`
 * @property {Array<{id:string,name:string,status:string,message:string}>} [failures]
 * @property {boolean} [noInteractive]  true => skip prompt (CI / non-TTY)
 */

const ROLLBACK_TARGETS = [
  'runtime-manifest.json',
  'settings.json',
  'hooks',
  'agents'
];

const BACKUP_DIR_PATTERN = /^\.claude\.backup-(.+)$/;

/**
 * @param {string} projectDir
 * @returns {string|null}  absolute path to most recent backup, or null
 */
export function findLatestBackup(projectDir) {
  if (typeof projectDir !== 'string' || projectDir.length === 0) return null;
  let entries;
  try {
    entries = fs.readdirSync(projectDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(BACKUP_DIR_PATTERN);
    if (!match) continue;
    const full = path.join(projectDir, entry.name);
    let mtime = 0;
    try {
      mtime = fs.statSync(full).mtimeMs;
    } catch {
      continue;
    }
    candidates.push({ full, name: entry.name, mtime, stamp: match[1] });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    if (b.mtime !== a.mtime) return b.mtime - a.mtime;
    return b.stamp.localeCompare(a.stamp);
  });
  return candidates[0].full;
}

function fileSha256(filePath) {
  try {
    const data = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(data).digest('hex');
  } catch {
    return '';
  }
}

function listFilesRecursive(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * Compare `.claude/` under projectDir against the backup.
 * Only walks ROLLBACK_TARGETS subset.
 *
 * @param {string} projectDir
 * @param {string} backupDir
 * @returns {DiffLine[]}
 */
export function diffAgainstBackup(projectDir, backupDir) {
  const liveRoot = path.join(projectDir, '.claude');
  const diff = [];

  for (const target of ROLLBACK_TARGETS) {
    const liveTarget = path.join(liveRoot, target);
    const backupTarget = path.join(backupDir, '.claude', target);

    const liveExists = fs.existsSync(liveTarget);
    const backupExists = fs.existsSync(backupTarget);

    if (!liveExists && !backupExists) continue;

    const liveIsDir = liveExists && fs.statSync(liveTarget).isDirectory();
    const backupIsDir = backupExists && fs.statSync(backupTarget).isDirectory();

    if (!liveIsDir && !backupIsDir) {
      // single file
      const liveSha = liveExists ? fileSha256(liveTarget) : '';
      const backupSha = backupExists ? fileSha256(backupTarget) : '';
      if (!backupExists && liveExists) {
        diff.push({ status: 'A', relativePath: `.claude/${target}` });
      } else if (backupExists && !liveExists) {
        diff.push({ status: 'D', relativePath: `.claude/${target}` });
      } else if (liveSha !== backupSha) {
        diff.push({ status: 'M', relativePath: `.claude/${target}` });
      }
      continue;
    }

    // Directory walk — collect unique relative paths from both sides
    const liveFiles = liveExists && liveIsDir ? listFilesRecursive(liveTarget) : [];
    const backupFiles = backupExists && backupIsDir ? listFilesRecursive(backupTarget) : [];
    const liveMap = new Map();
    for (const f of liveFiles) {
      liveMap.set(path.relative(liveTarget, f), f);
    }
    const backupMap = new Map();
    for (const f of backupFiles) {
      backupMap.set(path.relative(backupTarget, f), f);
    }
    const allKeys = new Set([...liveMap.keys(), ...backupMap.keys()]);
    for (const key of allKeys) {
      const live = liveMap.get(key);
      const backup = backupMap.get(key);
      const rel = `.claude/${target}/${key.replace(/\\/g, '/')}`;
      if (live && !backup) {
        diff.push({ status: 'A', relativePath: rel });
      } else if (!live && backup) {
        diff.push({ status: 'D', relativePath: rel });
      } else if (live && backup) {
        if (fileSha256(live) !== fileSha256(backup)) {
          diff.push({ status: 'M', relativePath: rel });
        }
      }
    }
  }

  diff.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return diff;
}

/**
 * Prompt the user on stdin to confirm rollback. Resolves without waiting if not TTY.
 *
 * @param {DiffLine[]} diff
 * @param {{stdin?: NodeJS.ReadableStream, stdout?: NodeJS.WritableStream, forceNonTty?: boolean}} [io]
 * @returns {Promise<'rollback'|'abort'>}
 */
export function promptRollback(diff, io = {}) {
  const stdin = io.stdin || process.stdin;
  const stdout = io.stdout || process.stdout;
  const isTty = io.forceNonTty ? false : Boolean(stdin && stdin.isTTY);

  if (!isTty) {
    // Non-interactive => treat as abort (caller may decide to downgrade via --no-rollback-on-failure).
    return Promise.resolve('abort');
  }

  const count = Array.isArray(diff) ? diff.length : 0;
  stdout.write(`\nRollback ${count} change(s)? [y/N]: `);

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin, output: stdout, terminal: false });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { rl.close(); } catch {}
      resolve(value);
    };
    rl.on('line', (line) => {
      const answer = String(line || '').trim().toLowerCase();
      finish(answer === 'y' || answer === 'yes' ? 'rollback' : 'abort');
    });
    rl.on('close', () => {
      // If closed without a line event reaching us, fall back to abort.
      finish('abort');
    });
  });
}

function copyFileOverwrite(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyRecursive(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(srcDir, entry.name);
    const d = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyRecursive(s, d);
    } else if (entry.isFile()) {
      copyFileOverwrite(s, d);
    }
  }
}

function writePartialRestoreLog(projectDir, errors) {
  if (!errors || errors.length === 0) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = path.join(projectDir, `.claude.partial-restore-${ts}.log`);
  const body = errors
    .map((e) => `[${e.target}] ${e.op}: ${e.message}`)
    .join('\n');
  try {
    fs.writeFileSync(logPath, `${body}\n`, 'utf8');
    return logPath;
  } catch {
    return null;
  }
}

/**
 * Restore .claude/<targets> from backupDir back onto projectDir.
 *
 * @param {RollbackOptions} opts
 * @returns {Promise<{restored:string[], partial:boolean, logPath:string|null}>}
 */
export async function performRollback(opts) {
  const { projectDir, backupDir } = opts;
  if (!projectDir || !backupDir) {
    throw new Error('performRollback requires projectDir and backupDir');
  }
  if (!fs.existsSync(backupDir)) {
    throw new Error(`Backup directory not found: ${backupDir}`);
  }

  const liveRoot = path.join(projectDir, '.claude');
  const errors = [];
  const restored = [];

  for (const target of ROLLBACK_TARGETS) {
    const backupTarget = path.join(backupDir, '.claude', target);
    const liveTarget = path.join(liveRoot, target);
    const backupExists = fs.existsSync(backupTarget);
    const liveExists = fs.existsSync(liveTarget);

    try {
      if (!backupExists && liveExists) {
        // backup missing => remove live so state matches backup
        if (fs.statSync(liveTarget).isDirectory()) {
          fs.rmSync(liveTarget, { recursive: true, force: true });
        } else {
          fs.rmSync(liveTarget, { force: true });
        }
        restored.push(target);
        continue;
      }
      if (!backupExists && !liveExists) {
        continue;
      }
      // backup exists — overwrite live
      const backupIsDir = fs.statSync(backupTarget).isDirectory();
      if (backupIsDir) {
        if (liveExists) {
          fs.rmSync(liveTarget, { recursive: true, force: true });
        }
        copyRecursive(backupTarget, liveTarget);
      } else {
        copyFileOverwrite(backupTarget, liveTarget);
      }
      restored.push(target);
    } catch (err) {
      errors.push({
        target,
        op: 'restore',
        message: err && err.message ? err.message : String(err)
      });
    }
  }

  const logPath = writePartialRestoreLog(projectDir, errors);
  return {
    restored,
    partial: errors.length > 0,
    logPath
  };
}

export const ROLLBACK_TARGET_PATHS = ROLLBACK_TARGETS;
