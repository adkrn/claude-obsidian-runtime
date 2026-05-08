/**
 * DESIGN_MANUS_AG — Current_Todo.md auto-managed writer.
 *
 * SSOT for the auto-managed todo file at <vaultRoot>/00_Home/Current_Todo.md.
 * Owns:
 *   - §5-A frontmatter (auto_managed/managed_by/do_not_edit)
 *   - §5-B body format (numbered pseudocode + status)
 *   - §5-C 4 status markers ([ ]/[x]/[→]/[!])
 *   - §6-A initial list generation (task-start)
 *   - §6-B PostToolUse auto-check matching
 *   - §6-C carry-over + reset (task-close)
 *   - §6-D no-active-task body
 *   - §7-A/§7-B conservative matching (path > function > class)
 *
 * Does NOT:
 *   - touch Current_Focus.md (CD-M1 enforcement, §2-2)
 *   - validate lesson 11 fields (DESIGN_MANUS_4B SSOT — separate domain)
 *   - subscribe to error events (DESIGN_MANUS_E §6 SSOT — separate matching)
 */

import fs from 'fs';
import path from 'path';
import { appendJsonl, getEventFilePath } from './runtime-lib.mjs';
import { ensureDir, normalizePath } from './utils.mjs';
import { loadObsidianConfig } from './obsidian-config.mjs';

const TODO_FILENAME = 'Current_Todo.md';

const STATUS_TO_MARKER = Object.freeze({
  pending: '[ ]',
  done: '[x]',
  in_progress: '[→]',
  blocked: '[!]'
});

const MARKER_TO_STATUS = Object.freeze({
  '[ ]': 'pending',
  '[x]': 'done',
  '[→]': 'in_progress',
  '[!]': 'blocked'
});

const FRONTMATTER_BLOCK = [
  '---',
  'auto_managed: true',
  'managed_by: claude-obsidian-runtime',
  'do_not_edit: true',
  '---'
].join('\n');

const NO_ACTIVE_BODY = [
  '# Current Todo (no active task)',
  '',
  '> 시스템 자동 영역. task-start 시 자동 갱신됩니다.',
  '> 사람 큐레이션은 [Current_Focus.md](./Current_Focus.md)에 작성하세요.'
].join('\n');

// ── Helpers ───────────────────────────────────────────────────────

function resolveVaultRoot(projectDir) {
  try {
    const cfg = loadObsidianConfig(projectDir);
    if (cfg?.vaultAvailable && cfg?.vaultRoot) return cfg.vaultRoot;
  } catch { /* ignore */ }
  return '';
}

function todoFilePath(vaultRoot) {
  return path.join(vaultRoot, '00_Home', TODO_FILENAME);
}

function atomicWrite(filePath, content) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.tmp-${Date.now()}`;
  try {
    fs.writeFileSync(tempPath, content, 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

// ── §7-A token extraction (path / function / class) ──────────────

const PATH_RE = /\b[\w.\-/]+\.[a-zA-Z]+\b/g;
const IDENT_RE = /\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g;

/**
 * §7-A — extract path/function/class tokens from arbitrary text.
 * - path: forward-slash + extension (basename treated as a separate path token)
 * - function: camelCase / snake_case (3+ chars, leading lowercase or underscore)
 * - class: PascalCase (3+ chars, second char must be lowercase to exclude
 *          ALLCAPS constants)
 * Korean-only / 1-2 char tokens are dropped (false-positive avoidance).
 */
export function extractTokens(text) {
  const source = String(text || '').replace(/\\/g, '/');
  const paths = [];
  const functions = [];
  const classes = [];

  // paths first (so identifiers inside paths don't double-count)
  const seenPaths = new Set();
  const pathMatches = source.match(PATH_RE) || [];
  for (const raw of pathMatches) {
    const norm = raw.replace(/^\.\//, '');
    if (norm.length < 4) continue;
    if (!/[a-zA-Z]/.test(norm)) continue;
    if (!seenPaths.has(norm)) {
      seenPaths.add(norm);
      paths.push(norm);
    }
    // also expose basename as a path token so `Edit core/foo.mjs`
    // matches `1. [ ] foo.mjs ...` even when description omits the folder.
    const base = norm.split('/').pop();
    if (base && base !== norm && !seenPaths.has(base)) {
      seenPaths.add(base);
      paths.push(base);
    }
  }

  // identifiers — skip tokens that look like constants (all uppercase)
  const stripped = source.replace(PATH_RE, ' ');
  const identMatches = stripped.match(IDENT_RE) || [];
  const seenFn = new Set();
  const seenCls = new Set();
  for (const ident of identMatches) {
    if (ident.length < 3) continue;
    const first = ident[0];
    if (first >= 'A' && first <= 'Z') {
      // PascalCase: ABC stays out (no lowercase chars), Foo / FooBar stay in
      if (!/[a-z]/.test(ident)) continue;
      if (!seenCls.has(ident)) {
        seenCls.add(ident);
        classes.push(ident);
      }
      continue;
    }
    if ((first >= 'a' && first <= 'z') || first === '_') {
      if (!seenFn.has(ident)) {
        seenFn.add(ident);
        functions.push(ident);
      }
    }
  }

  return { paths, functions, classes };
}

/**
 * §7-B — match a single todo item against extracted event tokens.
 * Priority order: path > function > class. First exact-match wins.
 *
 * @param {object} item   TodoItem (with description + optional matchTokens)
 * @param {object} eventTokens  result of extractTokens(...)
 * @returns {{ matched, matchType, matchedToken }}
 */
export function matchTodoItem(item, eventTokens) {
  const empty = { matched: false, matchType: null, matchedToken: null };
  if (!item || !eventTokens) return empty;
  if (item.status === 'done' || item.status === 'in_progress' || item.status === 'blocked') {
    return empty;
  }

  const descTokens = extractTokens(item.description || '');
  const seedPaths = Array.isArray(item.matchTokens) ? item.matchTokens : [];
  const itemPaths = uniqueArray([...descTokens.paths, ...seedPaths]);
  const itemFns = descTokens.functions;
  const itemCls = descTokens.classes;

  if (itemPaths.length === 0 && itemFns.length === 0 && itemCls.length === 0) {
    return empty;
  }

  for (const p of itemPaths) {
    if (eventTokens.paths.includes(p)) {
      return { matched: true, matchType: 'path', matchedToken: p };
    }
  }
  for (const fn of itemFns) {
    if (eventTokens.functions.includes(fn)) {
      return { matched: true, matchType: 'function', matchedToken: fn };
    }
  }
  for (const cls of itemCls) {
    if (eventTokens.classes.includes(cls)) {
      return { matched: true, matchType: 'class', matchedToken: cls };
    }
  }
  return empty;
}

function uniqueArray(items) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

// ── §6-A initial list generation ──────────────────────────────────

/**
 * §6-A — derive an initial todo list from task-start context.
 *
 * @param {object} taskRecord   { taskId, title, ... }
 * @param {Array<{ path, why }>} readFirst
 * @param {string[]} [matchedScopes]
 * @returns {Array<{ num, description, status, matchTokens }>}
 */
export function generateInitialTodoList(taskRecord, readFirst, _matchedScopes = []) {
  // matchedScopes reserved for future scope-aware tokenization (§7-A enhancement).
  const safeTask = taskRecord || {};
  const safeRead = Array.isArray(readFirst) ? readFirst.filter(Boolean) : [];

  if (safeRead.length === 0) {
    const titleLine = String(safeTask.title || safeTask.taskId || 'task').trim() || 'task';
    return [{
      num: 1,
      description: titleLine,
      status: 'pending',
      matchTokens: []
    }];
  }

  const items = [];
  let num = 1;
  for (const entry of safeRead) {
    const rawPath = String(entry?.path || '').trim();
    if (!rawPath) continue;
    const why = String(entry?.why || '').trim();
    const baseName = path.posix.basename(normalizePath(rawPath));
    const description = why ? `${baseName} :: ${why}` : baseName;
    items.push({
      num,
      description,
      status: 'pending',
      matchTokens: [normalizePath(rawPath)]
    });
    num += 1;
  }

  if (items.length === 0) {
    items.push({
      num: 1,
      description: String(safeTask.title || safeTask.taskId || 'task').trim() || 'task',
      status: 'pending',
      matchTokens: []
    });
  }

  return items;
}

// ── parse / serialize ─────────────────────────────────────────────

const ITEM_RE = /^(\d+)\.\s+(\[[ x→!]\])\s+(.*?)(?:\s+<!--\s+status:\s+([^,>]+)(?:,\s*(.*))?-->\s*)?$/;

/**
 * Parse Current_Todo.md → { items, task, exists } shape.
 * Tolerates the no-active-task body and missing files.
 */
export function parseTodoFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return { exists: false, items: [], task: null };
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const items = [];
  let task = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('**task**:')) {
      task = trimmed.slice('**task**:'.length).trim();
      continue;
    }
    const m = line.match(ITEM_RE);
    if (!m) continue;
    const [, numStr, marker, descRaw, statusName, metaRaw] = m;
    const desc = descRaw.trim();
    const baseStatus = MARKER_TO_STATUS[marker] || 'pending';
    const status = statusName ? statusName.trim() : baseStatus;
    const meta = parseStatusMeta(metaRaw || '');
    const tokens = extractTokens(desc);
    items.push({
      num: Number.parseInt(numStr, 10),
      description: desc,
      status,
      matchTokens: tokens.paths,
      meta
    });
  }
  return { exists: true, items, task };
}

function parseStatusMeta(raw) {
  if (!raw) return {};
  const out = {};
  const segments = raw.split(',').map((s) => s.trim()).filter(Boolean);
  for (const seg of segments) {
    const idx = seg.indexOf(':');
    if (idx === -1) continue;
    out[seg.slice(0, idx).trim()] = seg.slice(idx + 1).trim().replace(/-->$/, '').trim();
  }
  return out;
}

function serializeItem(item) {
  const marker = STATUS_TO_MARKER[item.status] || STATUS_TO_MARKER.pending;
  const metaParts = [`status: ${item.status || 'pending'}`];
  if (item.meta?.at) metaParts.push(`at: ${item.meta.at}`);
  if (item.meta?.since) metaParts.push(`since: ${item.meta.since}`);
  if (item.meta?.reason) metaParts.push(`reason: ${item.meta.reason}`);
  const metaSegment = `<!-- ${metaParts.join(', ')} -->`;
  return `${item.num}. ${marker} ${item.description}  ${metaSegment}`;
}

function serializeBody({ taskId, title, items, updatedAt }) {
  const safeItems = Array.isArray(items) ? items : [];
  const header = [
    '# Current Todo (auto-managed — do not edit manually)',
    '',
    '> 이 파일은 시스템이 자동 갱신합니다. 수동 편집은 다음 갱신에서 덮어씌워집니다.',
    '> 사람 큐레이션은 [Current_Focus.md](./Current_Focus.md)에 작성하세요.',
    '',
    `**task**: ${taskId || ''} :: ${title || ''}`,
    `**updated_at**: ${updatedAt}`,
    ''
  ].join('\n');
  const body = safeItems.length > 0
    ? safeItems.map(serializeItem).join('\n')
    : '_(no steps)_';
  return `${header}${body}\n`;
}

// ── §6-A write / §6-D reset / §6-B PostToolUse ───────────────────

/**
 * §6-A — write Current_Todo.md from initial list. Returns { ok, path? }.
 * Skips silently when vaultRoot unavailable + appends `todo_skip` event.
 */
export function writeTodoFile(projectDir, vaultRoot, todoData) {
  const root = vaultRoot || resolveVaultRoot(projectDir);
  if (!root) {
    appendTodoSkip(projectDir, todoData?.taskId, 'no_vault');
    return { ok: false, reason: 'no_vault' };
  }
  const target = todoFilePath(root);
  const updatedAt = new Date().toISOString();
  const content = `${FRONTMATTER_BLOCK}\n${serializeBody({
    taskId: todoData?.taskId || '',
    title: todoData?.title || '',
    items: todoData?.items || [],
    updatedAt
  })}`;
  try {
    atomicWrite(target, content);
  } catch {
    appendTodoSkip(projectDir, todoData?.taskId, 'write_failed');
    return { ok: false, reason: 'write_failed' };
  }
  return { ok: true, path: target };
}

/**
 * §6-D — reset to no-active-task body (frontmatter preserved).
 */
export function resetTodoFile(projectDir, vaultRoot) {
  const root = vaultRoot || resolveVaultRoot(projectDir);
  if (!root) return { ok: false, reason: 'no_vault' };
  const target = todoFilePath(root);
  const content = `${FRONTMATTER_BLOCK}\n${NO_ACTIVE_BODY}\n`;
  try {
    atomicWrite(target, content);
  } catch {
    return { ok: false, reason: 'write_failed' };
  }
  return { ok: true, path: target };
}

function appendTodoSkip(projectDir, taskId, reason) {
  if (!projectDir) return;
  try {
    appendJsonl(getEventFilePath(projectDir, new Date()), {
      ts: new Date().toISOString(),
      taskId: taskId || '',
      eventType: 'todo_skip',
      scope: 'workflow',
      summary: `todo write skipped: ${reason}`,
      detail: { reason }
    });
  } catch { /* non-critical */ }
}

/**
 * §6-B — PostToolUse hook entry. Called from post-edit.mjs whenever a
 * file_read / file_edit / file_write tool fires. Conservative match;
 * silent on no-vault or no-match.
 *
 * @param {string} projectDir
 * @param {object} event   { tool_name, tool_input: { file_path, ... } }
 * @returns {{ matched: boolean, itemNum: number|null, matchType?: string }}
 */
export function autoCheckTodoOnPostTool(projectDir, event) {
  const empty = { matched: false, itemNum: null };
  if (!event || typeof event !== 'object') return empty;
  const root = resolveVaultRoot(projectDir);
  if (!root) return empty;
  const target = todoFilePath(root);
  if (!fs.existsSync(target)) return empty;

  const parsed = parseTodoFile(target);
  if (!parsed.exists || parsed.items.length === 0) return empty;

  const filePath = event?.tool_input?.file_path || '';
  const command = event?.tool_input?.command || '';
  const toolName = event?.tool_name || '';
  const tokens = extractTokens(`${normalizePath(filePath)} ${command} ${toolName}`);

  // pending-only candidates, lowest num wins among same matchType (path > fn > class).
  const candidates = [];
  for (const item of parsed.items) {
    if (item.status !== 'pending') continue;
    const m = matchTodoItem(item, tokens);
    if (m.matched) candidates.push({ item, match: m });
  }
  if (candidates.length === 0) return empty;

  const priority = { path: 0, function: 1, class: 2 };
  candidates.sort((a, b) => {
    const dp = (priority[a.match.matchType] ?? 99) - (priority[b.match.matchType] ?? 99);
    if (dp !== 0) return dp;
    return a.item.num - b.item.num;
  });
  const winner = candidates[0];
  winner.item.status = 'done';
  winner.item.meta = { ...(winner.item.meta || {}), at: new Date().toISOString() };

  // re-serialize keeping current task / updated_at
  const updatedAt = new Date().toISOString();
  const taskParsed = parseTaskHeader(parsed.task);
  const content = `${FRONTMATTER_BLOCK}\n${serializeBody({
    taskId: taskParsed.taskId,
    title: taskParsed.title,
    items: parsed.items,
    updatedAt
  })}`;
  try {
    atomicWrite(target, content);
  } catch {
    return empty;
  }
  return { matched: true, itemNum: winner.item.num, matchType: winner.match.matchType };
}

function parseTaskHeader(raw) {
  if (!raw) return { taskId: '', title: '' };
  const idx = raw.indexOf('::');
  if (idx === -1) return { taskId: raw.trim(), title: '' };
  return {
    taskId: raw.slice(0, idx).trim(),
    title: raw.slice(idx + 2).trim()
  };
}

// ── §6-C carry-over + reset ───────────────────────────────────────

/**
 * §6-C — append unfinished items to worklog and reset Current_Todo.md.
 *
 * @param {string} projectDir
 * @param {string} vaultRoot      vault root (may be empty → skip)
 * @param {object} taskRecord     { taskId, title }
 * @param {string} worklogPath    absolute path to worklog md (may be empty → skip carry-over)
 */
export function carryOverAndReset(projectDir, vaultRoot, taskRecord, worklogPath) {
  const root = vaultRoot || resolveVaultRoot(projectDir);
  if (!root) return { ok: false, reason: 'no_vault', carried: [] };
  const target = todoFilePath(root);
  if (!fs.existsSync(target)) {
    return { ok: true, carried: [], reset: false };
  }
  const parsed = parseTodoFile(target);
  const unfinished = parsed.items.filter((i) => i.status !== 'done');

  let appended = false;
  if (unfinished.length > 0 && worklogPath && fs.existsSync(worklogPath)) {
    try {
      const existing = fs.readFileSync(worklogPath, 'utf8');
      const sectionLines = [
        '',
        `## Carried-over Todo (from ${taskRecord?.taskId || ''})`,
        ''
      ];
      for (const item of unfinished) {
        const marker = STATUS_TO_MARKER[item.status] || '[ ]';
        const suffix = renderCarrySuffix(item);
        sectionLines.push(`- ${marker} ${item.description}${suffix}`);
      }
      sectionLines.push('');
      const next = `${existing.replace(/\s+$/, '')}\n${sectionLines.join('\n')}`;
      fs.writeFileSync(worklogPath, next, 'utf8');
      appended = true;
    } catch { /* non-critical */ }
  }

  const reset = resetTodoFile(projectDir, root);
  return {
    ok: reset.ok,
    carried: unfinished,
    appended,
    reset: reset.ok
  };
}

function renderCarrySuffix(item) {
  if (item.status === 'in_progress') return '  (was in_progress)';
  if (item.status === 'blocked') {
    const reason = item.meta?.reason || 'unknown';
    return `  (blocked: ${reason})`;
  }
  return '';
}

// ── exports for tests ─────────────────────────────────────────────

export const __internals = {
  STATUS_TO_MARKER,
  MARKER_TO_STATUS,
  FRONTMATTER_BLOCK,
  NO_ACTIVE_BODY,
  todoFilePath,
  serializeBody
};
