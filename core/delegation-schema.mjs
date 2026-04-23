/**
 * core/delegation-schema.mjs — Validator for Governance Layer delegation events.
 *
 * P2 (design-p2-governance.md §1-1-3) implements JSON Schema draft-07 rules
 * via hand-written checks (no external JSON Schema library dependency).
 *
 * Exported:
 *   validateDelegationEvent(obj) -> { valid: boolean, errors: string[] }
 *
 * Non-goals:
 *   - does not write files
 *   - does not mutate input
 *   - does not depend on fs/path
 *
 * This file is standalone: no imports from other core/* modules.
 */

const VALID_OUTCOMES = new Set([
  'success',
  'failed',
  'bounced',
  'cap_rejected',
  'loop_rejected'
]);

const CALLER_PATTERN = /^[A-Za-z0-9_\-:]+$/;
const CALLEE_PATTERN = /^[A-Za-z0-9_\-]+$/;
const TASK_ID_PATTERN = /^[A-Za-z0-9_\-]+$/;
const CORR_ID_PATTERN = /^[A-Za-z0-9_\-]+$/;
const TS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const MAX_REASON_LEN = 100;
const MAX_CALLER_LEN = 120;
const MAX_CALLEE_LEN = 120;
const MAX_TASK_ID_LEN = 60;
const MAX_CORR_ID_LEN = 80;
const MAX_TOKENS = 10_000_000;
const MAX_DURATION_MS = 3_600_000;
const MAX_FANOUT_INDEX = 10;

/**
 * Validate a delegation event object.
 *
 * @param {object} obj
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateDelegationEvent(obj) {
  const errors = [];

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { valid: false, errors: ['not_an_object'] };
  }

  const required = ['ts', 'type', 'caller', 'callee', 'task_id', 'reason', 'outcome'];
  for (const key of required) {
    if (obj[key] === undefined || obj[key] === null) {
      errors.push(`missing_required:${key}`);
    }
  }

  if (obj.type !== undefined && obj.type !== 'delegation') {
    errors.push(`invalid_type:${obj.type}`);
  }

  if (typeof obj.ts === 'string' && !TS_PATTERN.test(obj.ts)) {
    errors.push('invalid_ts_format');
  }

  if (typeof obj.caller === 'string') {
    if (obj.caller.length === 0 || obj.caller.length > MAX_CALLER_LEN) {
      errors.push('invalid_caller_length');
    } else if (!CALLER_PATTERN.test(obj.caller)) {
      errors.push('invalid_caller_pattern');
    }
  }

  if (typeof obj.callee === 'string') {
    if (obj.callee.length === 0 || obj.callee.length > MAX_CALLEE_LEN) {
      errors.push('invalid_callee_length');
    } else if (!CALLEE_PATTERN.test(obj.callee)) {
      errors.push('invalid_callee_pattern');
    }
  }

  if (typeof obj.task_id === 'string') {
    if (obj.task_id.length === 0 || obj.task_id.length > MAX_TASK_ID_LEN) {
      errors.push('invalid_task_id_length');
    } else if (!TASK_ID_PATTERN.test(obj.task_id)) {
      errors.push('invalid_task_id_pattern');
    }
  }

  if (typeof obj.reason === 'string') {
    if (obj.reason.length === 0 || obj.reason.length > MAX_REASON_LEN) {
      errors.push('invalid_reason_length');
    }
  }

  if (obj.outcome !== undefined && !VALID_OUTCOMES.has(obj.outcome)) {
    errors.push(`invalid_outcome:${obj.outcome}`);
  }

  if (obj.tokens_estimate !== undefined) {
    if (!Number.isInteger(obj.tokens_estimate) || obj.tokens_estimate < 0 || obj.tokens_estimate > MAX_TOKENS) {
      errors.push('invalid_tokens_estimate');
    }
  }

  if (obj.duration_ms !== undefined) {
    if (!Number.isInteger(obj.duration_ms) || obj.duration_ms < 0 || obj.duration_ms > MAX_DURATION_MS) {
      errors.push('invalid_duration_ms');
    }
  }

  if (obj.correlation_id !== undefined) {
    if (typeof obj.correlation_id !== 'string'
        || obj.correlation_id.length === 0
        || obj.correlation_id.length > MAX_CORR_ID_LEN
        || !CORR_ID_PATTERN.test(obj.correlation_id)) {
      errors.push('invalid_correlation_id');
    }
  }

  if (obj.fanout_index !== undefined) {
    if (!Number.isInteger(obj.fanout_index) || obj.fanout_index < 1 || obj.fanout_index > MAX_FANOUT_INDEX) {
      errors.push('invalid_fanout_index');
    }
  }

  const allowed = new Set([
    ...required,
    'tokens_estimate', 'duration_ms', 'correlation_id', 'fanout_index'
  ]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      errors.push(`unknown_key:${key}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Lightweight secret pattern detection for reason field (§10 Security).
 * Returns true if obvious secret tokens are present.
 *
 * NOT a full DLP scan — blocks only well-known prefix shapes.
 */
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bghp_[A-Za-z0-9]{36}\b/,
  /\bxox[baprs]-[A-Za-z0-9\-]{10,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/
];

export function reasonContainsSecret(reason) {
  if (typeof reason !== 'string') return false;
  return SECRET_PATTERNS.some((re) => re.test(reason));
}
