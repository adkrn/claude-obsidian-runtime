/**
 * DESIGN_MANUS_AG §9 — Current_Todo.md auto-managed AC tests (9 cases).
 *
 * AC-1 task-start → Current_Todo.md 생성 + frontmatter 정합
 * AC-2 PostToolUse + 매칭 path → [ ] → [x]
 * AC-3 PostToolUse + 매칭 안 됨 → 변경 없음
 * AC-4 task-close → 미완 carry-over + 초기화
 * AC-5 task 미존재 시 빈 상태 유지
 * AC-6 Current_Focus.md byte-level 변경 0건 (CD-M1)
 * AC-7 동시 매칭 시 우선순위 (path > function)
 * AC-8 done 항목 재매칭 X (idempotent)
 * AC-9 in_progress / blocked 자동 매칭 X
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import {
  autoCheckTodoOnPostTool,
  carryOverAndReset,
  extractTokens,
  generateInitialTodoList,
  matchTodoItem,
  parseTodoFile,
  resetTodoFile,
  writeTodoFile,
  __internals
} from '../todo-writer.mjs';

function tempProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `manus-ag-${crypto.randomBytes(4).toString('hex')}-`));
  fs.mkdirSync(path.join(root, '.claude', 'runtime', 'events'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude', 'runtime', 'tasks'), { recursive: true });
  // vaultRoot is a sibling dir; we pass it explicitly via writeTodoFile/etc.
  const vaultRoot = path.join(root, 'vault');
  fs.mkdirSync(path.join(vaultRoot, '00_Home'), { recursive: true });
  // seed Current_Focus.md (CD-M1 reference) — same content as production template.
  const focusOriginal = [
    '# Current Focus',
    '',
    '## Active Priorities',
    '',
    '- (현재 우선순위를 여기 추가)',
    '',
    '## Open Questions',
    '',
    '- (미해결 질문을 여기 추가)',
    '',
    '## Update Rule',
    '',
    '- 하루 종료 전 이 노트를 3줄 이내로 갱신',
    '- 우선순위가 바뀌면 첫 번째 섹션만 수정',
    ''
  ].join('\n');
  fs.writeFileSync(path.join(vaultRoot, '00_Home', 'Current_Focus.md'), focusOriginal);
  return {
    projectDir: root,
    vaultRoot,
    focusPath: path.join(vaultRoot, '00_Home', 'Current_Focus.md'),
    focusOriginal,
    cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } }
  };
}

function readFocusBytes(focusPath) {
  return fs.readFileSync(focusPath);
}

function bufferEqual(a, b) {
  if (a.length !== b.length) return false;
  return a.equals(b);
}

// ── AC-1 ─────────────────────────────────────────────────────────

test('AC-1: writeTodoFile produces frontmatter + numbered items + meta', (t) => {
  const fx = tempProject();
  t.after(() => fx.cleanup());

  const taskRecord = { taskId: 'T-001', title: 'implement applyEvolution safeguard' };
  const readFirst = [
    { path: 'core/memory/memory-evolution.mjs', why: 'evolution algorithm' },
    { path: 'core/memory/semantic-store.mjs', why: 'normalizer' }
  ];
  const items = generateInitialTodoList(taskRecord, readFirst, []);
  const result = writeTodoFile(fx.projectDir, fx.vaultRoot, {
    taskId: taskRecord.taskId,
    title: taskRecord.title,
    items
  });
  assert.equal(result.ok, true);
  const content = fs.readFileSync(result.path, 'utf8');
  assert.ok(content.startsWith('---\nauto_managed: true\nmanaged_by: claude-obsidian-runtime\ndo_not_edit: true\n---\n'));
  assert.ok(content.includes('# Current Todo (auto-managed — do not edit manually)'));
  assert.ok(content.includes('1. [ ] memory-evolution.mjs :: evolution algorithm'));
  assert.ok(content.includes('2. [ ] semantic-store.mjs :: normalizer'));
  assert.ok(content.includes('**task**: T-001 :: implement applyEvolution safeguard'));
  assert.ok(content.includes('**updated_at**:'));
});

// ── AC-2 ─────────────────────────────────────────────────────────

test('AC-2: autoCheckTodoOnPostTool flips first matching pending → done', (t) => {
  const fx = tempProject();
  t.after(() => fx.cleanup());

  process.env.OBSIDIAN_VAULT_ROOT = fx.vaultRoot;
  t.after(() => { delete process.env.OBSIDIAN_VAULT_ROOT; });

  const items = generateInitialTodoList(
    { taskId: 'T-002', title: 'edit memory' },
    [
      { path: 'core/memory/memory-evolution.mjs', why: 'algorithm' },
      { path: 'core/memory/semantic-store.mjs', why: 'normalizer' }
    ],
    []
  );
  writeTodoFile(fx.projectDir, fx.vaultRoot, { taskId: 'T-002', title: 'edit memory', items });

  const result = autoCheckTodoOnPostTool(fx.projectDir, {
    tool_name: 'Edit',
    tool_input: { file_path: 'core/memory/memory-evolution.mjs' }
  });
  assert.equal(result.matched, true);
  assert.equal(result.itemNum, 1);
  assert.equal(result.matchType, 'path');

  const target = path.join(fx.vaultRoot, '00_Home', 'Current_Todo.md');
  const content = fs.readFileSync(target, 'utf8');
  assert.ok(content.includes('1. [x] memory-evolution.mjs'));
  assert.ok(content.includes('status: done'));
  assert.ok(/at:\s*\d{4}-\d{2}-\d{2}T/.test(content));
  // 2nd item untouched
  assert.ok(content.includes('2. [ ] semantic-store.mjs'));
});

// ── AC-3 ─────────────────────────────────────────────────────────

test('AC-3: unrelated tool event does not mutate todo body', (t) => {
  const fx = tempProject();
  t.after(() => fx.cleanup());
  process.env.OBSIDIAN_VAULT_ROOT = fx.vaultRoot;
  t.after(() => { delete process.env.OBSIDIAN_VAULT_ROOT; });

  const items = generateInitialTodoList(
    { taskId: 'T-003', title: 't' },
    [{ path: 'core/memory/memory-evolution.mjs', why: '' }],
    []
  );
  writeTodoFile(fx.projectDir, fx.vaultRoot, { taskId: 'T-003', title: 't', items });
  const target = path.join(fx.vaultRoot, '00_Home', 'Current_Todo.md');
  const before = fs.readFileSync(target);

  const result = autoCheckTodoOnPostTool(fx.projectDir, {
    tool_name: 'Edit',
    tool_input: { file_path: 'docs/UNRELATED.md' }
  });
  assert.equal(result.matched, false);
  const after = fs.readFileSync(target);
  assert.ok(bufferEqual(before, after));
});

// ── AC-4 ─────────────────────────────────────────────────────────

test('AC-4: carryOverAndReset appends unfinished items to worklog + resets todo body', (t) => {
  const fx = tempProject();
  t.after(() => fx.cleanup());
  process.env.OBSIDIAN_VAULT_ROOT = fx.vaultRoot;
  t.after(() => { delete process.env.OBSIDIAN_VAULT_ROOT; });

  const items = generateInitialTodoList(
    { taskId: 'T-004', title: 't4' },
    [
      { path: 'core/memory/memory-evolution.mjs', why: 'a' },
      { path: 'core/memory/semantic-store.mjs', why: 'b' }
    ],
    []
  );
  writeTodoFile(fx.projectDir, fx.vaultRoot, { taskId: 'T-004', title: 't4', items });

  // mark item 1 done
  autoCheckTodoOnPostTool(fx.projectDir, {
    tool_name: 'Edit',
    tool_input: { file_path: 'core/memory/memory-evolution.mjs' }
  });

  // create a worklog file
  const worklogPath = path.join(fx.projectDir, 'worklog.md');
  fs.writeFileSync(worklogPath, '# Worklog T-004\n\n## Summary\n\n- did the thing\n');

  const carry = carryOverAndReset(fx.projectDir, fx.vaultRoot, { taskId: 'T-004', title: 't4' }, worklogPath);
  assert.equal(carry.ok, true);
  assert.equal(carry.appended, true);
  assert.equal(carry.carried.length, 1);
  assert.equal(carry.carried[0].description, 'semantic-store.mjs :: b');

  const worklog = fs.readFileSync(worklogPath, 'utf8');
  assert.ok(worklog.includes('## Carried-over Todo (from T-004)'));
  assert.ok(worklog.includes('- [ ] semantic-store.mjs :: b'));

  const target = path.join(fx.vaultRoot, '00_Home', 'Current_Todo.md');
  const todoAfter = fs.readFileSync(target, 'utf8');
  assert.ok(todoAfter.includes('# Current Todo (no active task)'));
  assert.ok(todoAfter.startsWith('---\nauto_managed: true\n'));
});

// ── AC-5 ─────────────────────────────────────────────────────────

test('AC-5: resetTodoFile produces no-active-task body with frontmatter', (t) => {
  const fx = tempProject();
  t.after(() => fx.cleanup());

  const r = resetTodoFile(fx.projectDir, fx.vaultRoot);
  assert.equal(r.ok, true);
  const content = fs.readFileSync(r.path, 'utf8');
  assert.equal(content, `${__internals.FRONTMATTER_BLOCK}\n${__internals.NO_ACTIVE_BODY}\n`);
});

// ── AC-6 ─────────────────────────────────────────────────────────

test('AC-6: full AC-1..AC-5 sequence does not touch Current_Focus.md (CD-M1)', (t) => {
  const fx = tempProject();
  t.after(() => fx.cleanup());
  process.env.OBSIDIAN_VAULT_ROOT = fx.vaultRoot;
  t.after(() => { delete process.env.OBSIDIAN_VAULT_ROOT; });

  const focusBefore = readFocusBytes(fx.focusPath);
  const focusBeforeMtime = fs.statSync(fx.focusPath).mtimeMs;

  // AC-1 write
  const items = generateInitialTodoList(
    { taskId: 'T-006', title: 'CD-M1' },
    [{ path: 'core/memory/memory-evolution.mjs', why: '' }],
    []
  );
  writeTodoFile(fx.projectDir, fx.vaultRoot, { taskId: 'T-006', title: 'CD-M1', items });

  // AC-2 match
  autoCheckTodoOnPostTool(fx.projectDir, {
    tool_name: 'Edit',
    tool_input: { file_path: 'core/memory/memory-evolution.mjs' }
  });

  // AC-3 no match
  autoCheckTodoOnPostTool(fx.projectDir, {
    tool_name: 'Edit',
    tool_input: { file_path: 'docs/UNRELATED.md' }
  });

  // AC-4 carry-over
  const worklogPath = path.join(fx.projectDir, 'worklog.md');
  fs.writeFileSync(worklogPath, '# Worklog T-006\n');
  carryOverAndReset(fx.projectDir, fx.vaultRoot, { taskId: 'T-006' }, worklogPath);

  // AC-5 reset
  resetTodoFile(fx.projectDir, fx.vaultRoot);

  const focusAfter = readFocusBytes(fx.focusPath);
  const focusAfterMtime = fs.statSync(fx.focusPath).mtimeMs;
  assert.ok(bufferEqual(focusBefore, focusAfter), 'Current_Focus.md byte-level untouched');
  assert.equal(focusBeforeMtime, focusAfterMtime, 'Current_Focus.md mtime untouched');
  assert.equal(fs.readFileSync(fx.focusPath, 'utf8'), fx.focusOriginal);
});

// ── AC-7 ─────────────────────────────────────────────────────────

test('AC-7: simultaneous match selects path over function (priority order)', (t) => {
  const fx = tempProject();
  t.after(() => fx.cleanup());
  process.env.OBSIDIAN_VAULT_ROOT = fx.vaultRoot;
  t.after(() => { delete process.env.OBSIDIAN_VAULT_ROOT; });

  // both items reference applyEvolution; item 1 also names the file path.
  const items = [
    {
      num: 1,
      description: 'applyEvolution function in memory-evolution.mjs',
      status: 'pending',
      matchTokens: ['core/memory/memory-evolution.mjs']
    },
    { num: 2, description: 'applyEvolution helper', status: 'pending', matchTokens: [] }
  ];
  writeTodoFile(fx.projectDir, fx.vaultRoot, { taskId: 'T-007', title: 'priority', items });

  const result = autoCheckTodoOnPostTool(fx.projectDir, {
    tool_name: 'Edit',
    tool_input: { file_path: 'core/memory/memory-evolution.mjs' }
  });
  assert.equal(result.matched, true);
  assert.equal(result.itemNum, 1);
  assert.equal(result.matchType, 'path');

  const target = path.join(fx.vaultRoot, '00_Home', 'Current_Todo.md');
  const content = fs.readFileSync(target, 'utf8');
  assert.ok(content.includes('1. [x] applyEvolution function in memory-evolution.mjs'));
  assert.ok(content.includes('2. [ ] applyEvolution helper'));
});

// ── AC-8 ─────────────────────────────────────────────────────────

test('AC-8: done items are immune to re-matching (idempotent)', (t) => {
  const fx = tempProject();
  t.after(() => fx.cleanup());
  process.env.OBSIDIAN_VAULT_ROOT = fx.vaultRoot;
  t.after(() => { delete process.env.OBSIDIAN_VAULT_ROOT; });

  const items = generateInitialTodoList(
    { taskId: 'T-008', title: 'idempotent' },
    [{ path: 'core/memory/memory-evolution.mjs', why: '' }],
    []
  );
  writeTodoFile(fx.projectDir, fx.vaultRoot, { taskId: 'T-008', title: 'idempotent', items });

  autoCheckTodoOnPostTool(fx.projectDir, {
    tool_name: 'Edit',
    tool_input: { file_path: 'core/memory/memory-evolution.mjs' }
  });

  const target = path.join(fx.vaultRoot, '00_Home', 'Current_Todo.md');
  const after1 = fs.readFileSync(target);

  // re-fire same event — body should not change because item is now `done`.
  const repeat = autoCheckTodoOnPostTool(fx.projectDir, {
    tool_name: 'Edit',
    tool_input: { file_path: 'core/memory/memory-evolution.mjs' }
  });
  assert.equal(repeat.matched, false);
  const after2 = fs.readFileSync(target);
  assert.ok(bufferEqual(after1, after2));
});

// ── AC-9 ─────────────────────────────────────────────────────────

test('AC-9: in_progress / blocked items are skipped by auto-match (human signal protected)', () => {
  const inProgressItem = {
    num: 1,
    description: 'core/memory/memory-evolution.mjs :: x',
    status: 'in_progress',
    matchTokens: ['core/memory/memory-evolution.mjs']
  };
  const blockedItem = {
    num: 2,
    description: 'core/memory/semantic-store.mjs :: y',
    status: 'blocked',
    matchTokens: ['core/memory/semantic-store.mjs']
  };
  const tokens = extractTokens('core/memory/memory-evolution.mjs core/memory/semantic-store.mjs');
  assert.equal(matchTodoItem(inProgressItem, tokens).matched, false);
  assert.equal(matchTodoItem(blockedItem, tokens).matched, false);
});

// ── helpers ──────────────────────────────────────────────────────

test('extractTokens picks paths, camelCase functions, PascalCase classes; drops constants', () => {
  const t = extractTokens('Edit core/memory/memory-evolution.mjs applyEvolution EvolutionCheckpoint MAX_TRIES');
  assert.ok(t.paths.includes('core/memory/memory-evolution.mjs'));
  assert.ok(t.paths.includes('memory-evolution.mjs'));
  assert.ok(t.functions.includes('applyEvolution'));
  assert.ok(t.classes.includes('EvolutionCheckpoint'));
  assert.ok(!t.classes.includes('MAX_TRIES'));
});

test('parseTodoFile returns exists=false for missing path', (t) => {
  const fx = tempProject();
  t.after(() => fx.cleanup());
  const parsed = parseTodoFile(path.join(fx.vaultRoot, '00_Home', 'Current_Todo.md'));
  assert.equal(parsed.exists, false);
  assert.deepEqual(parsed.items, []);
});
