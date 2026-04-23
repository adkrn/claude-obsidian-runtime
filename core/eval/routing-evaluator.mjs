/**
 * core/eval/routing-evaluator.mjs — Routing 4-metric evaluator (P3).
 *
 * Pure function module (no fs/process side effects at module scope).
 * Consumes:
 *   - routing-goldens.json parsed cases (see schemas/routing-goldens-p3.json)
 *   - delegations.jsonl parsed records (validated by core/delegation-schema.mjs)
 *
 * Produces:
 *   { delegationCorrectness, bouncingRate, loopRate, recoveryRate, details: [] }
 *
 * Policy (P3 design §4):
 *   - delegation_correctness cases are evaluated by re-running P1 matching
 *     algorithm locally (deterministic). No Claude API call.
 *   - bouncing/loop/recovery cases may provide a simulatedTrace; when absent,
 *     they operate on the real delegations records passed in.
 *   - loop detection uses P2 governance.loopDetection parameters
 *     (window_minutes=5, threshold=3 by default).
 *   - never mutates inputs.
 */

import { validateDelegationEvent } from '../delegation-schema.mjs';

const DEFAULT_LOOP_WINDOW_MINUTES = 5;
const DEFAULT_LOOP_THRESHOLD = 3;

/**
 * Normalize a prompt for deterministic matching (lowercase, collapse spaces).
 */
export function normalizePrompt(prompt) {
  if (typeof prompt !== 'string') return '';
  return prompt.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * P1 §4-3 structured score matching, reproduced locally.
 *
 * @param {string} prompt  User prompt (raw).
 * @param {Array<{name, triggers, domain}>} agents  Agent catalog entries.
 * @returns {{ callee: string, score: number, ties: string[] }}
 *   callee = chosen agent name, or 'lead' if score==0.
 */
export function simulateP1Routing(prompt, agents) {
  const normalized = normalizePrompt(prompt);
  let best = { score: -1, names: [] };
  for (const agent of agents) {
    if (!Array.isArray(agent?.triggers) || agent.triggers.length === 0) continue;
    const matchedTriggers = agent.triggers.filter((t) =>
      typeof t === 'string' && t.length > 0 && normalized.includes(t.toLowerCase())
    ).length;
    const matchedDomain = Array.isArray(agent.domain)
      ? agent.domain.filter((d) =>
          typeof d === 'string' && d.length > 0 && normalized.includes(d.toLowerCase())
        ).length
      : 0;
    const score = matchedTriggers + 0.3 * matchedDomain;
    if (score > best.score) {
      best = { score, names: [agent.name] };
    } else if (score === best.score && score > 0) {
      best.names.push(agent.name);
    }
  }
  if (best.score <= 0 || best.names.length === 0) {
    return { callee: 'lead', score: 0, ties: [] };
  }
  best.names.sort();
  return { callee: best.names[0], score: best.score, ties: best.names.slice(1) };
}

/**
 * delegation_correctness metric.
 *
 * @param {Array<object>} cases  routing-goldens cases with metric === 'delegation_correctness'.
 * @param {Array<object>} agentCatalog  Parsed agent catalog entries from the project (name, triggers, domain).
 * @returns {{ rate: number, total: number, correct: number, details: Array }}
 */
export function evaluateDelegationCorrectness(cases, agentCatalog) {
  const details = [];
  let correct = 0;
  for (const c of cases) {
    const agents = Array.isArray(c.installedAgents) && c.installedAgents.length > 0
      ? agentCatalog.filter((a) => c.installedAgents.includes(a.name))
      : agentCatalog;
    const result = simulateP1Routing(c.prompt, agents);
    const allowed = new Set([c.expectedCallee, ...(Array.isArray(c.allowedFallback) ? c.allowedFallback : [])]);
    const matched = allowed.has(result.callee);
    if (matched) correct += 1;
    details.push({
      id: c.id,
      expected: c.expectedCallee,
      actual: result.callee,
      matched,
      score: result.score,
      ties: result.ties
    });
  }
  const total = cases.length;
  return {
    rate: total > 0 ? correct / total : 0,
    total,
    correct,
    details
  };
}

function groupByTask(records) {
  const byTask = new Map();
  for (const r of records) {
    if (!r || typeof r.task_id !== 'string') continue;
    if (!byTask.has(r.task_id)) byTask.set(r.task_id, []);
    byTask.get(r.task_id).push(r);
  }
  return byTask;
}

/**
 * bouncing instability metric.
 * Counts tasks where callee changes >= 2 times (i.e., 3 distinct callees or
 * same callee seen after a different one and then again).
 */
export function evaluateBouncingRate(records) {
  const byTask = groupByTask(records);
  let total = 0;
  let bouncing = 0;
  const details = [];
  for (const [taskId, list] of byTask) {
    total += 1;
    list.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    const callees = list.map((r) => r.callee);
    let switches = 0;
    for (let i = 1; i < callees.length; i++) {
      if (callees[i] !== callees[i - 1]) switches += 1;
    }
    if (switches >= 2) {
      bouncing += 1;
      details.push({ taskId, switches, callees });
    }
  }
  return {
    rate: total > 0 ? bouncing / total : 0,
    total,
    bouncing,
    details
  };
}

/**
 * loop behavior metric.
 * Uses P2 governance.loopDetection (window_minutes, threshold).
 */
export function evaluateLoopRate(records, options = {}) {
  const windowMs = (options.windowMinutes || DEFAULT_LOOP_WINDOW_MINUTES) * 60 * 1000;
  const threshold = options.threshold || DEFAULT_LOOP_THRESHOLD;
  const byTask = groupByTask(records);
  let total = 0;
  let looping = 0;
  const details = [];
  for (const [taskId, list] of byTask) {
    total += 1;
    list.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    const pairCounts = new Map();
    let loopDetected = false;
    for (const r of list) {
      const key = `${r.caller}->${r.callee}`;
      const ts = Date.parse(r.ts);
      if (!Number.isFinite(ts)) continue;
      const arr = pairCounts.get(key) || [];
      const pruned = arr.filter((t) => ts - t <= windowMs);
      pruned.push(ts);
      pairCounts.set(key, pruned);
      if (pruned.length >= threshold) {
        loopDetected = true;
      }
    }
    if (loopDetected) {
      looping += 1;
      details.push({ taskId, pairs: Array.from(pairCounts.keys()) });
    }
  }
  return {
    rate: total > 0 ? looping / total : 0,
    total,
    looping,
    details
  };
}

/**
 * recovery after misroutes metric.
 * Denominator: tasks where at least one outcome=bounced occurred.
 * Numerator: tasks where after a bounced record, a later record (same task_id)
 * has outcome=success.
 */
export function evaluateRecoveryRate(records) {
  const byTask = groupByTask(records);
  let denom = 0;
  let numer = 0;
  const details = [];
  for (const [taskId, list] of byTask) {
    list.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    let bouncedAt = -1;
    let recovered = false;
    for (let i = 0; i < list.length; i++) {
      if (list[i].outcome === 'bounced' && bouncedAt < 0) bouncedAt = i;
      if (bouncedAt >= 0 && i > bouncedAt && list[i].outcome === 'success') {
        recovered = true;
        break;
      }
    }
    if (bouncedAt >= 0) {
      denom += 1;
      if (recovered) numer += 1;
      details.push({ taskId, recovered });
    }
  }
  return {
    rate: denom > 0 ? numer / denom : null,
    denom,
    numer,
    details
  };
}

/**
 * High-level orchestrator. Accepts parsed goldens and delegation records,
 * returns consolidated report.
 *
 * @param {object} params
 * @param {object} params.goldens  parsed routing-goldens.json (already schema-valid)
 * @param {Array<object>} params.delegationLogs  parsed records from delegations-*.jsonl
 * @param {Array<object>} params.agentCatalog  parsed agent frontmatter entries
 * @param {object} [params.loopOptions]  { windowMinutes, threshold }
 * @returns {object}  { delegationCorrectness, bouncingRate, loopRate, recoveryRate, details }
 */
export function evaluateRouting({
  goldens,
  delegationLogs,
  agentCatalog,
  loopOptions = {}
}) {
  const validRecords = Array.isArray(delegationLogs)
    ? delegationLogs.filter((r) => {
        const result = validateDelegationEvent(r);
        return result.valid;
      })
    : [];

  const caseBuckets = {
    delegation_correctness: [],
    bouncing: [],
    loop: [],
    recovery: []
  };
  const goldenCases = Array.isArray(goldens?.cases) ? goldens.cases : [];
  for (const c of goldenCases) {
    if (c && caseBuckets[c.metric]) caseBuckets[c.metric].push(c);
  }

  const correctness = evaluateDelegationCorrectness(
    caseBuckets.delegation_correctness,
    Array.isArray(agentCatalog) ? agentCatalog : []
  );

  const simulatedRecords = [];
  const baseTs = Date.now() - 24 * 60 * 60 * 1000;
  for (const c of [...caseBuckets.bouncing, ...caseBuckets.loop, ...caseBuckets.recovery]) {
    if (!Array.isArray(c.simulatedTrace)) continue;
    for (const step of c.simulatedTrace) {
      simulatedRecords.push({
        ts: new Date(baseTs + (step.ts_offset_seconds || 0) * 1000).toISOString(),
        type: 'delegation',
        caller: step.caller,
        callee: step.callee,
        task_id: step.task_id,
        reason: 'simulated',
        outcome: step.outcome
      });
    }
  }

  const combined = validRecords.concat(simulatedRecords);
  const bouncing = evaluateBouncingRate(combined);
  const loop = evaluateLoopRate(combined, loopOptions);
  const recovery = evaluateRecoveryRate(combined);

  return {
    delegationCorrectness: correctness.rate,
    bouncingRate: bouncing.rate,
    loopRate: loop.rate,
    recoveryRate: recovery.rate,
    details: {
      delegationCorrectness: correctness,
      bouncing,
      loop,
      recovery
    }
  };
}
