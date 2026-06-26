#!/usr/bin/env node

/**
 * clean-boilerplate-rules.mjs — one-off maintenance (NOT shipped in core).
 *
 * Removes the legacy boilerplate string
 *   "read read_first notes before writing a plan"
 * from session artifacts: the `rules` array of each lessons.jsonl row AND the
 * matching markdown list line in vault artifact docs (lessons / worklogs /
 * decisions / troubleshooting).
 *
 * Context: D-26 code-blocking stopped *new* artifacts from carrying this
 * string, but *old* data still has it. It pollutes the relevance material
 * before the lightweight-search / embedding upgrade (02_GAP_ANALYSIS G4).
 *
 * IMPORTANT — real distribution (measured 2026-06-26, NOT the 54/5-project
 * figure assumed in the gap doc, which was wrong):
 *   - jsonl: Talkup 199 + Talkup_test1 7 = 206 rows carry the line.
 *   - vault: TalkUp 08_Lessons 161, 10_Worklogs 77 + AresParSimVR 10_Worklogs 44,
 *            TalkUp 07_Decisions 2, 06_Troubleshooting 1 = 285 docs.
 *   The 5 projects the gap doc named (Pasim62/talkSim/magicDraft/productSurvey/
 *   musicGame) have ZERO occurrences. All boilerplate is in the TalkUp family.
 *
 * Policy (user-confirmed 2026-06-26):
 *   - Scope = "worklogs included" (the full 489): jsonl + vault lessons +
 *     vault worklogs + vault decisions/troubleshooting.
 *   - jsonl mixed row -> strip the one line, keep the row + all other fields.
 *   - jsonl SHELL row (boilerplate was the only rule, 13 rows) -> DROP the row,
 *     but APPEND it to a `.quarantine.jsonl` so nothing is permanently lost.
 *   - vault .md -> remove the standalone `- read read_first...` list line only;
 *     keep the section header and every other line.
 *
 * Safety (per project data-safety rules + obsidian-sync prune incident):
 *   - NO direct unlink / rmSync. Dropped rows are quarantined, not deleted.
 *   - Writes a one-time `.bak` before modifying (won't clobber an existing .bak).
 *   - Path roots are explicit; vault root is taken from OBSIDIAN_VAULT_ROOT
 *     (or --vault-root) so tests/sandboxes never touch the real vault.
 *   - `--dry-run` prints per-file counts and writes nothing.
 *
 * Usage:
 *   OBSIDIAN_VAULT_ROOT=C:/Obsidian node scripts/clean-boilerplate-rules.mjs --dry-run
 *   OBSIDIAN_VAULT_ROOT=C:/Obsidian node scripts/clean-boilerplate-rules.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const BOILERPLATE = 'read read_first notes before writing a plan';

/** True iff a rules[] element is exactly the boilerplate (whitespace-tolerant). */
export function isBoilerplate(rule) {
  return typeof rule === 'string' && rule.trim() === BOILERPLATE;
}

/**
 * Process one parsed jsonl row. Pure - never mutates input.
 * @returns {{ row: object|null, stripped: boolean, dropped: boolean }}
 *   - dropped=true (row=null): boilerplate was the only rule -> drop + quarantine.
 *   - stripped=true: boilerplate removed, all other rules/fields preserved.
 *   - both false: row had no boilerplate -> returned unchanged.
 */
export function processJsonlRow(row) {
  const rules = Array.isArray(row.rules) ? row.rules : [];
  if (!rules.some(isBoilerplate)) {
    return { row, stripped: false, dropped: false };
  }
  const kept = rules.filter((r) => !isBoilerplate(r));
  if (kept.length === 0) {
    return { row: null, stripped: false, dropped: true };
  }
  return { row: { ...row, rules: kept }, stripped: true, dropped: false };
}

// A markdown boilerplate line: a list item (-, *, +, optional indent) whose
// content is exactly the boilerplate phrase. Prose mentions are NOT matched.
const MD_BOILERPLATE_LINE = new RegExp(
  '^\\s*[-*+]\\s+' + BOILERPLATE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$'
);

/**
 * Remove standalone boilerplate list lines from markdown. Pure.
 * Section headers and all other lines are preserved verbatim.
 * @returns {{ text: string, changed: boolean, removedLines: number }}
 */
export function stripBoilerplateFromMarkdown(text) {
  const src = String(text || '');
  const trailingNewline = /\n$/.test(src);
  const lines = src.split(/\r?\n/);
  let removed = 0;
  const kept = lines.filter((line) => {
    if (MD_BOILERPLATE_LINE.test(line)) {
      removed += 1;
      return false;
    }
    return true;
  });
  if (removed === 0) {
    return { text: src, changed: false, removedLines: 0 };
  }
  const out = kept.join('\n') + (trailingNewline && kept.length ? '\n' : '');
  return { text: out, changed: true, removedLines: removed };
}

function backupOnce(file) {
  const bak = file + '.bak';
  if (!fs.existsSync(bak)) {
    fs.copyFileSync(file, bak);
    return bak;
  }
  return bak + ' (already existed - not overwritten)';
}

/**
 * Clean one lessons.jsonl file: strip mixed rows, drop+quarantine shell rows.
 * @returns summary object
 */
export function processJsonlFile(file, { dryRun = false } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { file, error: 'read failed: ' + err.message };
  }

  const trailingNewline = /\n$/.test(raw);
  const lines = raw.split(/\r?\n/);
  const outLines = [];
  const quarantined = [];
  let parsedRows = 0;
  let stripped = 0;
  let dropped = 0;
  let nonJsonKept = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      outLines.push(line); // preserve non-JSON verbatim
      nonJsonKept += 1;
      continue;
    }
    parsedRows += 1;
    const result = processJsonlRow(parsed);
    if (result.dropped) {
      dropped += 1;
      quarantined.push(parsed); // keep the original - never lose it
      continue;
    }
    if (result.stripped) stripped += 1;
    outLines.push(JSON.stringify(result.row));
  }

  const changed = stripped > 0 || dropped > 0;
  const summary = {
    file,
    type: 'jsonl',
    parsedRows,
    stripped,
    dropped,
    nonJsonKept,
    rowsAfter: parsedRows - dropped,
    changed
  };

  if (dryRun || !changed) return summary;

  summary.backup = backupOnce(file);
  if (quarantined.length) {
    const q = file + '.quarantine.jsonl';
    const qBody = quarantined.map((r) => JSON.stringify(r)).join('\n') + '\n';
    fs.appendFileSync(q, qBody, 'utf8'); // append - accumulate across runs
    summary.quarantine = q;
  }
  const body = outLines.join('\n') + (trailingNewline ? '\n' : '');
  fs.writeFileSync(file, body, 'utf8');
  summary.written = true;
  return summary;
}

/** Clean one vault markdown file: strip standalone boilerplate list lines. */
export function processMarkdownFile(file, { dryRun = false } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { file, error: 'read failed: ' + err.message };
  }
  const { text, changed, removedLines } = stripBoilerplateFromMarkdown(raw);
  const summary = { file, type: 'md', removedLines, changed };
  if (dryRun || !changed) return summary;
  summary.backup = backupOnce(file);
  fs.writeFileSync(file, text, 'utf8');
  summary.written = true;
  return summary;
}

// ---------------------------------------------------------------------------
// CLI orchestration (skipped when imported under test).
// ---------------------------------------------------------------------------

function listMarkdownRecursive(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMarkdownRecursive(p));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(p);
  }
  return out;
}

function gatherTargets(vaultRoot) {
  const jsonl = [
    'C:/JSProj/Talkup/.claude/runtime/knowledge/lessons.jsonl',
    'C:/JSProj/Talkup_test1/.claude/runtime/knowledge/lessons.jsonl'
  ].filter((f) => fs.existsSync(f));

  // Vault artifact folders that carry the boilerplate (measured).
  const mdRoots = [
    path.join(vaultRoot, 'TalkUp', '08_Lessons'),
    path.join(vaultRoot, 'TalkUp', '10_Worklogs'),
    path.join(vaultRoot, 'TalkUp', '07_Decisions'),
    path.join(vaultRoot, 'TalkUp', '06_Troubleshooting'),
    path.join(vaultRoot, 'AresParSimVR', '10_Worklogs')
  ];
  const md = mdRoots.flatMap(listMarkdownRecursive);
  return { jsonl, md };
}

function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const vaultArgIdx = argv.indexOf('--vault-root');
  const vaultRoot =
    (vaultArgIdx >= 0 && argv[vaultArgIdx + 1]) ||
    process.env.OBSIDIAN_VAULT_ROOT ||
    '';

  if (!vaultRoot) {
    console.error(
      'ERROR: vault root not set. Pass --vault-root <path> or set OBSIDIAN_VAULT_ROOT.\n' +
        '       (Refusing to guess - protects the real vault from accidental edits.)'
    );
    return 2;
  }

  console.log(
    '[clean-boilerplate-rules] ' + (dryRun ? 'DRY RUN' : 'APPLY') + ' - vault=' + vaultRoot + '\n' +
      '  boilerplate = "' + BOILERPLATE + '"'
  );

  const { jsonl, md } = gatherTargets(vaultRoot);
  let jStripped = 0;
  let jDropped = 0;
  let mdRemoved = 0;
  let mdFilesChanged = 0;

  console.log('\n-- jsonl (' + jsonl.length + ' files) --');
  for (const file of jsonl) {
    const s = processJsonlFile(file, { dryRun });
    if (s.error) {
      console.log('  SKIP  ' + file + '\n        ' + s.error);
      continue;
    }
    jStripped += s.stripped;
    jDropped += s.dropped;
    if (s.changed) {
      console.log(
        '  ' + (s.written ? 'WROTE' : 'WOULD') + '  ' + file + '\n' +
          '        rows=' + s.parsedRows + ' stripped=' + s.stripped + ' dropped=' + s.dropped + ' ' +
          'rowsAfter=' + s.rowsAfter + (s.quarantine ? ' quarantine=' + s.quarantine : '') +
          (s.backup ? ' backup=' + s.backup : '')
      );
    } else {
      console.log('  CLEAN  ' + file);
    }
  }

  console.log('\n-- vault markdown (' + md.length + ' files scanned) --');
  for (const file of md) {
    const s = processMarkdownFile(file, { dryRun });
    if (s.error || !s.changed) continue;
    mdRemoved += s.removedLines;
    mdFilesChanged += 1;
    console.log(
      '  ' + (s.written ? 'WROTE' : 'WOULD') + '  ' + file + ' (removed ' + s.removedLines + ' line(s))'
    );
  }

  console.log(
    '\n[clean-boilerplate-rules] TOTAL jsonl: stripped=' + jStripped + ' dropped=' + jDropped + ' | ' +
      'md: files=' + mdFilesChanged + ' lines=' + mdRemoved
  );
  return 0;
}

// Run only as a script, not when imported by tests.
const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
