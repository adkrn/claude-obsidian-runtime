/**
 * Deterministic JSON serialization for cache-friendly prefix stability.
 *
 * Spec: DESIGN_MANUS_D §5-A.
 *
 *   - Object keys are sorted (recursive).
 *   - Arrays preserve input order (caller orders via §5-C sort keys).
 *   - undefined / function are omitted (object) or coerced to null (array),
 *     matching JSON.stringify standard semantics.
 *   - Cyclic references throw, matching JSON.stringify.
 *   - options.space mirrors JSON.stringify's third arg.
 *
 * Why: Node's JSON.stringify preserves object insertion order — same data
 * built via different code paths can serialize differently and break
 * KV-cache prefix matching (P-M3 §3 violation signal).
 */

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value);
}

function sortRecursive(value, seen) {
  if (value === null) return null;
  if (typeof value !== 'object') return value;
  if (seen.has(value)) {
    throw new TypeError('Converting circular structure to JSON');
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => sortRecursive(entry, seen));
    }
    if (isPlainObject(value)) {
      const out = {};
      const keys = Object.keys(value).sort();
      for (const key of keys) {
        const v = value[key];
        if (v === undefined || typeof v === 'function') continue;
        out[key] = sortRecursive(v, seen);
      }
      return out;
    }
    return value;
  } finally {
    seen.delete(value);
  }
}

/**
 * @param {unknown} obj
 * @param {{ space?: number | string }} [options]
 * @returns {string}
 */
export function stableStringify(obj, options = {}) {
  const sorted = sortRecursive(obj, new Set());
  const space = options && options.space !== undefined ? options.space : undefined;
  return JSON.stringify(sorted, null, space);
}
