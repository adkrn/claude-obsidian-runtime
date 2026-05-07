/**
 * DESIGN_MANUS_H §7 — 12 AC for the [NOTIFY] / [ASK] message convention.
 *
 * Verification mode: text inspect (per design §7 NOTE — runtime [ASK] blocking
 * is delegated to Claude Code's general turn flow; this test suite verifies
 * convention is correctly defined in the lead guide and consistently used by
 * the dependent components — E §4-D / E §8-D / §4-A §5-A / F §6-B).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  formatUnverifiedBadge,
  formatUnverifiedNotify
} from '../../../core/task-close-verify.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LEAD_PATH = path.resolve(__dirname, '..', '_lead.md');

function readLead() {
  return fs.readFileSync(LEAD_PATH, 'utf8');
}

function isPrefixed(text, prefix) {
  return text.startsWith(`${prefix} `);
}

describe('DESIGN_MANUS_H — definition section in _lead.md (#1, #2, #3)', () => {
  it('#1 notify_prefix_present: lead guide defines [NOTIFY] usage', () => {
    const t = readLead();
    assert.match(t, /## 메시지 컨벤션 \(notify vs ask\)/);
    assert.match(t, /\*\*`\[NOTIFY\]`\*\*.*non-blocking/s);
  });

  it('#2 ask_prefix_present: lead guide defines [ASK] usage', () => {
    const t = readLead();
    assert.match(t, /\*\*`\[ASK\]`\*\*.*blocking.*reply 필수/s);
  });

  it('#3 no_prefix_violation: lead guide forbids missing prefix', () => {
    const t = readLead();
    assert.match(t, /prefix 누락 X/);
  });
});

describe('DESIGN_MANUS_H — blocking semantics defined (#4, #5)', () => {
  it('#4 ask_blocking_wait: [ASK] is described as blocking with reply required', () => {
    const t = readLead();
    // The convention text must declare [ASK] blocking + reply required.
    assert.match(t, /\[ASK\][^\n]*blocking[^\n]*reply 필수|`\[ASK\]`.*blocking.*reply 필수/s);
    // essential criteria triggers [ASK]
    assert.match(t, /essential 기준/);
    assert.match(t, /자동 fallback 부재/);
  });

  it('#5 notify_non_blocking: [NOTIFY] is described as non-blocking, no reply expected', () => {
    const t = readLead();
    assert.match(t, /\[NOTIFY\][^\n]*non-blocking|`\[NOTIFY\]`.*non-blocking/s);
    assert.match(t, /reply 기대 X|reply 불필요/);
  });
});

describe('DESIGN_MANUS_H — anti-patterns documented (#6, #7, #8)', () => {
  it('#6 wrong_ask_for_info: bad example "[ASK] 작업 시작" present', () => {
    const t = readLead();
    assert.match(t, /❌ `\[ASK\] 작업 시작합니다`/);
  });

  it('#7 wrong_notify_for_decision: bad example "[NOTIFY] 어느 scope" present', () => {
    const t = readLead();
    assert.match(t, /❌ `\[NOTIFY\] 어느 scope/);
  });

  it('#8 both_prefix_violation: forbids two prefixes in one message', () => {
    const t = readLead();
    assert.match(t, /한 메시지에 두 prefix 동시 사용 X/);
  });
});

describe('DESIGN_MANUS_H — cross-reference with E + §4-A + F (#9, #10, #11, #12)', () => {
  // The convention is enforced by other components. We verify those
  // emit messages with the correct prefix per H §6-A..§6-D.

  it('#9 escalate_message_format: E §4-D escalate uses [ASK] prefix', () => {
    const lead = readLead();
    // The error-protocol section in lead guide ends the cap-exceeded step
    // with [ASK]. (Real runtime escalate emission is covered by lead's text
    // since automatic retry orchestration is out-of-scope per §3-3 NOTE.)
    assert.match(lead, /## 에러 마주치면/);
    assert.match(lead, /escalate.*\[ASK\]|\[ASK\] prefix 로 사용자에게 결정 요청/);
  });

  it('#10 unverified_message_format: §4-A §5-A notify uses [NOTIFY] prefix + draft path', () => {
    const text = formatUnverifiedNotify({
      failedChecks: ['C07'],
      reflectionDraftPath: '08_Reflections/Drafts/2026-05-07_t-X.md'
    });
    assert.equal(isPrefixed(text, '[NOTIFY]'), true);
    assert.equal(text.startsWith('[ASK]'), false);
    assert.match(text, /실패 체크: C07/);
    assert.match(text, /L4 Reflective draft: 08_Reflections\/Drafts\/2026-05-07_t-X\.md/);
  });

  it('#10b unverified badge text mirrors the notify channel', () => {
    const badge = formatUnverifiedBadge({
      failedChecks: ['C07'],
      reflectionDraftPath: '08_Reflections/Drafts/2026-05-07_t-X.md'
    });
    assert.match(badge, /unverified/);
    assert.match(badge, /Reflection Draft/);
  });

  it('#11 draft_notify_format: E §8-D draft alert uses [NOTIFY] prefix (defined in lead)', () => {
    // The lead guide must explicitly list "L4 Reflection draft 생성 알림"
    // under the [NOTIFY] use-cases.
    const lead = readLead();
    assert.match(lead, /L4 Reflection draft 생성 알림|reflection draft.*\[NOTIFY\]/i);
  });

  it('#12 lesson_quality_warn: F (S1) §6-B applicable_when notify uses [NOTIFY] prefix', () => {
    const lead = readLead();
    // Existing applicable_when notify section + listing under message convention.
    assert.match(lead, /\[NOTIFY\] lesson <[^>]+> applicable_when 미정의/);
    // Convention block also lists "lesson 품질 경고".
    assert.match(lead, /lesson 품질 경고/);
  });
});

describe('DESIGN_MANUS_H — convention regex baseline', () => {
  it('every documented [NOTIFY]/[ASK] example in lead guide passes the prefix regex', () => {
    const t = readLead();
    // Match ❌/✅ markers anywhere inside a list line; the convention block
    // uses `- ❌ \`[ASK] ...\`` and `  → ✅ \`[NOTIFY] ...\`` styles.
    const regex = /[❌✅][^`\n]*`(\[(?:NOTIFY|ASK)\][^`]*)`/g;
    let m;
    let inspected = 0;
    while ((m = regex.exec(t)) !== null) {
      const sample = m[1];
      assert.equal(/^\[(NOTIFY|ASK)\] /.test(sample), true,
        `documented sample must match prefix regex: ${sample}`);
      inspected += 1;
    }
    assert.ok(inspected >= 4, `expected at least 4 ❌/✅ inline examples, got ${inspected}`);
  });
});
