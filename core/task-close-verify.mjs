/**
 * DESIGN_MANUS_4A — task-close --verify gate.
 *
 * Owns:
 *   - default check selection (§4-B: C01/C02/C07/C08/C11)
 *   - status judgment (§4-C: FAIL≥1 → unverified, WARN-only → verified)
 *   - unverified badge markdown (§5-A)
 *   - reflection draft synthesis input (§5-B re-uses E §8 buildReflectionDraft)
 *   - [NOTIFY] alert text (§5-A, H §4-A)
 *
 * Does NOT:
 *   - re-define buildReflectionDraft (E §8 SSOT — caller imports it)
 *   - spawn doctor (§7 prefers in-process import; caller can fall back to spawn)
 *   - invoke any C09/C10/C12 (§4-B exclusion: no eval-run, no task-start --dry-run)
 */

import { toDateStamp } from './utils.mjs';

// §4-B SSOT — selected check IDs (lowercase to match doctor CHECK_FN_MAP keys).
export const VERIFY_CHECK_IDS = Object.freeze(['c01', 'c02', 'c07', 'c08', 'c11']);

// §4-B exclusion — these checks must never run inside task-close --verify.
//   c09 = task-start --dry-run (heavy)
//   c10 = prerequisites (per-task drift unlikely)
//   c12 = performance observability (heavy)
export const VERIFY_EXCLUDED_IDS = Object.freeze(['c09', 'c10', 'c12']);

// All recognized doctor IDs (must mirror commands/doctor.mjs CHECK_FN_MAP keys).
const ALL_KNOWN_CHECK_IDS = Object.freeze([
  'c01', 'c02', 'c03', 'c04', 'c05', 'c06',
  'c07', 'c08', 'c09', 'c10', 'c11', 'c12'
]);

/**
 * §6-A/§6-B — resolve effective verify intent from parsed CLI args.
 *
 * @param {{ verify: boolean | null, verifyChecks: string[] | null }} args
 * @returns {{ enabled: boolean, checkIds: string[], invalidIds: string[] }}
 */
export function resolveVerifyOptions(args = {}) {
  // §6-B precedence: --no-verify wins over --verify-checks (verify itself skipped).
  if (args.verify === false) {
    return { enabled: false, checkIds: [], invalidIds: [] };
  }
  if (Array.isArray(args.verifyChecks) && args.verifyChecks.length > 0) {
    const invalid = args.verifyChecks.filter((id) => !ALL_KNOWN_CHECK_IDS.includes(id));
    if (invalid.length > 0) {
      return { enabled: true, checkIds: [], invalidIds: invalid };
    }
    return { enabled: true, checkIds: [...args.verifyChecks], invalidIds: [] };
  }
  // §4-A default ON — also when --verify is explicit (true) or unspecified (null).
  return { enabled: true, checkIds: [...VERIFY_CHECK_IDS], invalidIds: [] };
}

/**
 * §4-C — judge verify result from doctor checks output.
 *
 * Input: array of { id, status, message } from runChecks. Status values are
 * the doctor convention: 'pass' | 'warn' | 'fail' | 'pending'.
 *
 * @returns {{
 *   unverified: boolean,
 *   failedChecks: string[],   // upper-case IDs, in input order, for badge
 *   warnedChecks: string[],
 *   rawCheckResults: Array<{ id: string, status: string, message: string }>
 * }}
 */
export function evaluateVerifyResult(checks = []) {
  const safe = Array.isArray(checks) ? checks : [];
  const failedChecks = [];
  const warnedChecks = [];
  for (const c of safe) {
    if (!c || typeof c !== 'object') continue;
    if (c.status === 'fail') failedChecks.push(String(c.id || '').toUpperCase());
    else if (c.status === 'warn') warnedChecks.push(String(c.id || '').toUpperCase());
  }
  return {
    unverified: failedChecks.length > 0,
    failedChecks,
    warnedChecks,
    rawCheckResults: safe
  };
}

/**
 * §5-A — exact unverified badge markdown.
 *
 * Two-line format. Second line (Reflection Draft link) emitted only if
 * `reflectionDraftPath` truthy.
 */
export function formatUnverifiedBadge({ failedChecks = [], reflectionDraftPath = '' } = {}) {
  const ids = failedChecks.join(', ');
  const lines = [
    `> ⚠️ **unverified** — task-close 검증 실패: ${ids}`
  ];
  if (reflectionDraftPath) {
    lines.push(`> 상세: [Reflection Draft](${reflectionDraftPath})`);
  }
  return lines.join('\n');
}

/**
 * §4-A §5-A — [NOTIFY] alert text after unverified verdict.
 * H §4-A cross-reference: prefix is `[NOTIFY]` (non-blocking).
 */
export function formatUnverifiedNotify({ failedChecks = [], reflectionDraftPath = '' } = {}) {
  const ids = failedChecks.join(', ');
  const lines = [
    `[NOTIFY] worklog unverified — 실패 체크: ${ids}`
  ];
  if (reflectionDraftPath) {
    lines.push(`        L4 Reflective draft: ${reflectionDraftPath}`);
  }
  return lines.join('\n');
}

/**
 * §5-B — synthesize the input task object for E §8 buildReflectionDraft.
 * Caller passes the result to buildReflectionDraft (which is the SSOT
 * algorithm — do not re-define). `failures[].eventType: 'verification_failed'`
 * satisfies the trigger (E §8-B "verification" substring match).
 */
export function buildReflectionInput({ task, failedChecks = [], rawCheckResults = [] } = {}) {
  const safeTask = task || {};
  const ts = new Date().toISOString();
  const lookup = new Map(
    (rawCheckResults || []).map((c) => [String(c?.id || '').toLowerCase(), c])
  );
  const failures = (failedChecks || []).map((upperId) => {
    const lookupKey = String(upperId).toLowerCase();
    const c = lookup.get(lookupKey);
    return {
      summary: `task-close --verify FAIL: ${upperId} — ${c?.message || ''}`,
      eventType: 'verification_failed',
      type: `verify-${lookupKey}`,
      ts
    };
  });
  const verifications = (rawCheckResults || []).map((c) => ({
    command: `doctor --check=${c?.id ?? ''}`,
    success: c?.status === 'pass',
    summary: c?.message ?? ''
  }));
  return {
    taskId: safeTask.taskId || '',
    title: safeTask.title || '',
    prompt: safeTask.prompt || '',
    matchedScopes: Array.isArray(safeTask.matchedScopes) ? safeTask.matchedScopes : [],
    failures,
    verifications
  };
}

/**
 * §5-A — vault-relative path of the Reflection Draft for a given task,
 *        used by both the badge link and the [NOTIFY] alert.
 */
export function reflectionDraftRelativePath(taskId, date = new Date()) {
  return `08_Reflections/Drafts/${toDateStamp(date)}_${taskId || 'unknown'}.md`;
}

/**
 * §5-A — prepend the badge to worklog body (idempotent: caller decides
 * whether to call). Inserts after frontmatter if present, otherwise at top.
 */
export function prependUnverifiedBadge(worklogBody, badgeMarkdown) {
  const body = String(worklogBody || '');
  const trimmedBadge = String(badgeMarkdown || '').replace(/\s+$/, '');
  if (!trimmedBadge) return body;

  // Detect YAML frontmatter (leading `---` ... `---` block).
  const fmMatch = body.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  if (fmMatch) {
    const head = body.slice(0, fmMatch[0].length);
    const tail = body.slice(fmMatch[0].length);
    return `${head}${trimmedBadge}\n\n${tail}`;
  }
  return `${trimmedBadge}\n\n${body}`;
}

/**
 * §5-C — derive worklog status from verify outcome.
 * `failedChecks.length > 0 ? 'unverified' : 'verified'`.
 * modifiedFiles count is intentionally ignored.
 */
export function deriveWorklogStatus({ failedChecks = [] } = {}) {
  return (failedChecks || []).length > 0 ? 'unverified' : 'verified';
}
