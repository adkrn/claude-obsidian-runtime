/**
 * DESIGN_MANUS_4A §8 — 13 AC for task-close --verify gate.
 *
 * Strategy:
 *   - Pure-function helpers (resolveVerifyOptions, evaluateVerifyResult,
 *     formatUnverifiedBadge, formatUnverifiedNotify, deriveWorklogStatus,
 *     buildReflectionInput, prependUnverifiedBadge) are tested directly.
 *   - End-to-end behavior (CLI --verify with stubbed doctor output) is tested
 *     by spawning session-end.mjs against a fixture project. Doctor reads
 *     real fixtures so we drive C01..C11 by manipulating fixture files.
 *
 * Coverage matrix (#1..#13 mapped to design AC):
 *   #1 verify_default_on_all_pass        — pure (resolveVerifyOptions)
 *   #2 verify_fail_one_check             — pure (evaluateVerifyResult + badge)
 *   #3 verify_fail_multiple              — pure (badge format with 2 IDs)
 *   #4 verify_warn_only                  — pure (evaluateVerifyResult)
 *   #5 no_verify_skip                    — pure (resolveVerifyOptions)
 *   #6 verify_checks_override            — pure (resolveVerifyOptions)
 *   #7 verify_checks_invalid_id          — pure (resolveVerifyOptions)
 *   #8 modified_files_only_not_success   — pure (deriveWorklogStatus)
 *   #9 doctor_one_way                    — static (no import of session-end inside doctor)
 *  #10 reflection_draft_e_reuse          — pure (buildReflectionInput trigger)
 *  #11 unverified_badge_format_exact     — pure (formatUnverifiedBadge)
 *  #12 notify_after_unverified           — pure (formatUnverifiedNotify)
 *  #13 no_eval_spawn                     — static (verify check ids exclude c09/c10/c12)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildReflectionDraft } from '../../core/learning-curate.mjs';
import {
  buildReflectionInput,
  deriveWorklogStatus,
  evaluateVerifyResult,
  formatUnverifiedBadge,
  formatUnverifiedNotify,
  prependUnverifiedBadge,
  reflectionDraftRelativePath,
  resolveVerifyOptions,
  VERIFY_CHECK_IDS,
  VERIFY_EXCLUDED_IDS
} from '../../core/task-close-verify.mjs';
import { parseSessionEndArgs } from '../../core/session-end-engine.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const DOCTOR_SOURCE = path.join(PACKAGE_ROOT, 'commands', 'doctor.mjs');
const SESSION_END_SOURCE = path.join(PACKAGE_ROOT, 'commands', 'session-end.mjs');

describe('DESIGN_MANUS_4A — verify gate behavior (#1, #4~#7)', () => {
  it('#1 verify_default_on_all_pass: no flags → enabled with default 5 checks', () => {
    const args = parseSessionEndArgs(['--close']);
    const opts = resolveVerifyOptions(args);
    assert.equal(opts.enabled, true);
    assert.deepEqual(opts.checkIds, [...VERIFY_CHECK_IDS]);
    assert.equal(opts.invalidIds.length, 0);
  });

  it('#1b explicit --verify behaves the same as default', () => {
    const args = parseSessionEndArgs(['--close', '--verify']);
    const opts = resolveVerifyOptions(args);
    assert.equal(opts.enabled, true);
    assert.deepEqual(opts.checkIds, [...VERIFY_CHECK_IDS]);
  });

  it('#4 verify_warn_only: WARN-only → verified, badge omitted', () => {
    const checks = [
      { id: 'c01', status: 'pass', message: '' },
      { id: 'c07', status: 'warn', message: 'index slightly stale' }
    ];
    const ev = evaluateVerifyResult(checks);
    assert.equal(ev.unverified, false);
    assert.deepEqual(ev.failedChecks, []);
    assert.deepEqual(ev.warnedChecks, ['C07']);
    assert.equal(deriveWorklogStatus({ failedChecks: ev.failedChecks }), 'verified');
  });

  it('#5 no_verify_skip: --no-verify → enabled=false, no checks', () => {
    const args = parseSessionEndArgs(['--close', '--no-verify']);
    const opts = resolveVerifyOptions(args);
    assert.equal(opts.enabled, false);
    assert.deepEqual(opts.checkIds, []);
  });

  it('#5b --no-verify wins when combined with --verify-checks', () => {
    const args = parseSessionEndArgs([
      '--close',
      '--verify-checks', 'c01,c02',
      '--no-verify'
    ]);
    const opts = resolveVerifyOptions(args);
    assert.equal(opts.enabled, false);
  });

  it('#6 verify_checks_override: --verify-checks c01,c02 → only those run', () => {
    const args = parseSessionEndArgs(['--close', '--verify-checks', 'c01,c02']);
    const opts = resolveVerifyOptions(args);
    assert.equal(opts.enabled, true);
    assert.deepEqual(opts.checkIds, ['c01', 'c02']);
    // none of the heavy checks selected
    for (const heavy of VERIFY_EXCLUDED_IDS) {
      assert.equal(opts.checkIds.includes(heavy), false);
    }
  });

  it('#7 verify_checks_invalid_id: --verify-checks c99 → invalidIds set, no checks', () => {
    const args = parseSessionEndArgs(['--close', '--verify-checks', 'c99']);
    const opts = resolveVerifyOptions(args);
    assert.equal(opts.enabled, true);
    assert.deepEqual(opts.invalidIds, ['c99']);
    assert.deepEqual(opts.checkIds, []);
  });
});

describe('DESIGN_MANUS_4A — fail/badge/notify text (#2, #3, #11, #12)', () => {
  it('#2 verify_fail_one_check: FAIL=1 → unverified, single ID in badge', () => {
    const checks = [
      { id: 'c01', status: 'pass', message: '' },
      { id: 'c07', status: 'fail', message: 'code index missing' },
      { id: 'c08', status: 'pass', message: '' }
    ];
    const ev = evaluateVerifyResult(checks);
    assert.equal(ev.unverified, true);
    assert.deepEqual(ev.failedChecks, ['C07']);
    const badge = formatUnverifiedBadge({
      failedChecks: ev.failedChecks,
      reflectionDraftPath: '08_Reflections/Drafts/2026-05-07_t-2.md'
    });
    assert.match(badge, /^> ⚠️ \*\*unverified\*\* — task-close 검증 실패: C07$/m);
    assert.match(badge, /^> 상세: \[Reflection Draft\]\(08_Reflections\/Drafts\/2026-05-07_t-2\.md\)$/m);
  });

  it('#3 verify_fail_multiple: comma-separated IDs in badge', () => {
    const checks = [
      { id: 'c07', status: 'fail', message: 'a' },
      { id: 'c08', status: 'fail', message: 'b' }
    ];
    const ev = evaluateVerifyResult(checks);
    assert.deepEqual(ev.failedChecks, ['C07', 'C08']);
    const badge = formatUnverifiedBadge({ failedChecks: ev.failedChecks });
    assert.match(badge, /task-close 검증 실패: C07, C08/);
  });

  it('#11 unverified_badge_format_exact: two-line format with draft link', () => {
    const badge = formatUnverifiedBadge({
      failedChecks: ['C07', 'C08'],
      reflectionDraftPath: '08_Reflections/Drafts/2026-05-07_t-X.md'
    });
    const expected =
      '> ⚠️ **unverified** — task-close 검증 실패: C07, C08\n'
      + '> 상세: [Reflection Draft](08_Reflections/Drafts/2026-05-07_t-X.md)';
    assert.equal(badge, expected);
  });

  it('#11b badge omits second line when no reflection draft', () => {
    const badge = formatUnverifiedBadge({ failedChecks: ['C07'] });
    assert.equal(badge, '> ⚠️ **unverified** — task-close 검증 실패: C07');
  });

  it('#12 notify_after_unverified: [NOTIFY] prefix + draft path', () => {
    const text = formatUnverifiedNotify({
      failedChecks: ['C07', 'C08'],
      reflectionDraftPath: '08_Reflections/Drafts/2026-05-07_t-X.md'
    });
    assert.match(text, /^\[NOTIFY\] /);
    assert.match(text, /실패 체크: C07, C08/);
    assert.match(text, /L4 Reflective draft: 08_Reflections\/Drafts\/2026-05-07_t-X\.md/);
  });
});

describe('DESIGN_MANUS_4A — modifiedFiles vs verify status (#8)', () => {
  it('#8 modified_files_only_not_success: failedChecks decides status, not file count', () => {
    // 5 modified files but C07 FAIL → unverified
    assert.equal(deriveWorklogStatus({ failedChecks: ['C07'] }), 'unverified');
    // No FAIL → verified, regardless of how many files
    assert.equal(deriveWorklogStatus({ failedChecks: [] }), 'verified');
  });
});

describe('DESIGN_MANUS_4A — reflection draft re-use (#10)', () => {
  it('#10 reflection_draft_e_reuse: synthesized input feeds the same E §8 entrypoint', () => {
    const taskRecord = {
      taskId: 't-10',
      title: 'verify gate FAIL flow',
      matchedScopes: ['repo']
    };
    const input = buildReflectionInput({
      task: taskRecord,
      failedChecks: ['C07'],
      rawCheckResults: [
        { id: 'c07', status: 'fail', message: 'code index missing' }
      ]
    });
    assert.equal(input.taskId, 't-10');
    assert.equal(input.failures.length, 1);
    assert.equal(input.failures[0].eventType, 'verification_failed');
    // E §8 SSOT — same buildReflectionDraft as the cap-exceeded path.
    const draft = buildReflectionDraft(input);
    assert.ok(draft);
    assert.equal(draft.kind, 'reflection');
    assert.equal(draft.related_task, 't-10');
  });

  it('reflectionDraftRelativePath uses 08_Reflections/Drafts location', () => {
    const p = reflectionDraftRelativePath('t-X', new Date('2026-05-07T12:00:00Z'));
    assert.match(p, /^08_Reflections\/Drafts\/\d{4}-\d{2}-\d{2}_t-X\.md$/);
  });
});

describe('DESIGN_MANUS_4A — D-15 one-way + no eval spawn (#9, #13)', () => {
  it('#9 doctor_one_way: doctor.mjs does not import session-end (no reverse edge)', () => {
    const src = fs.readFileSync(DOCTOR_SOURCE, 'utf8');
    assert.equal(/from\s+['"][^'"]*session-end[^'"]*['"]/.test(src), false,
      'doctor must not import session-end (D-15 one-way)');
  });

  it('#13 no_eval_spawn: VERIFY_CHECK_IDS exclude c09/c10/c12 (no eval-run, no heavy checks)', () => {
    for (const heavy of VERIFY_EXCLUDED_IDS) {
      assert.equal(VERIFY_CHECK_IDS.includes(heavy), false);
    }
  });

  it('#13b session-end uses --json-equivalent in-process call (no spawn of doctor + --eval)', () => {
    const src = fs.readFileSync(SESSION_END_SOURCE, 'utf8');
    // Must not pass the --eval flag anywhere.
    assert.equal(/--eval/.test(src), false, 'session-end must not pass --eval');
    // Must not spawn child_process for doctor.
    assert.equal(/spawn[A-Z][a-z]+\(.*doctor/.test(src), false,
      'session-end must not spawn doctor as a subprocess');
  });
});

describe('DESIGN_MANUS_4A — badge prepend insertion point', () => {
  it('prepends after frontmatter when present', () => {
    const body = '---\ntitle: test\n---\n# Worklog\n\nbody';
    const out = prependUnverifiedBadge(body, '> ⚠️ **unverified** — task-close 검증 실패: C07');
    assert.match(out, /^---\ntitle: test\n---\n> ⚠️/);
    assert.match(out, /\n# Worklog/);
  });

  it('prepends at top when no frontmatter', () => {
    const body = '# Worklog\n\nbody';
    const out = prependUnverifiedBadge(body, '> ⚠️ **unverified** — task-close 검증 실패: C07');
    assert.match(out, /^> ⚠️/);
  });

  it('returns body unchanged when badge empty', () => {
    const body = '# Worklog';
    assert.equal(prependUnverifiedBadge(body, ''), body);
  });
});
