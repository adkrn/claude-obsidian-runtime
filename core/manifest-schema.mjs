/**
 * runtime-manifest.json schema validator.
 *
 * Contract (PATCH_Phase1 §2-A SSOT, §12-6):
 *   Required 6 axes: projectTag, defaultScope, surfacePatterns, scopeFolderMap,
 *                    preserveHooks, sessionEndPipeline
 *   Optional extensions: coreHooks, managedRoots, retrievalWeights, memoryLayers
 *
 *   - 6 axes missing/malformed  -> FAIL
 *   - extension absent          -> PASS
 *   - extension present + type error -> FAIL
 *   - managedRoots = []         -> PASS (explicit empty)
 *
 * Empty-value semantics (template-default, treated as "user not yet configured"):
 *   - surfacePatterns: []       -> PASS (consumers check `.length > 0` before use)
 *   - scopeFolderMap: {}        -> PASS (consumers gate on `Object.keys.length > 0`)
 *   - defaultScope/scopeFolderMap consistency check is skipped when scopeFolderMap is empty.
 *
 * Sentinel values:
 *   - coreHooks: "all"          -> PASS (install-hooks.mjs reads this as "enable all hooks")
 */

/**
 * @typedef {Object} SchemaError
 * @property {string} path
 * @property {string} expected
 * @property {string} actual
 * @property {'fail'|'warn'} severity
 */

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} valid
 * @property {SchemaError[]} errors
 */

const REQUIRED_AXES = [
  'projectTag',
  'defaultScope',
  'surfacePatterns',
  'scopeFolderMap',
  'preserveHooks',
  'sessionEndPipeline'
];

const RETRIEVAL_WEIGHTS_KEYS = [
  'alphaRecency',
  'alphaImportance',
  'alphaRelevance',
  'decayRatePerDay'
];

// DESIGN_MANUS_C §4-C — optional diversity sub-keys (default 0.2 / 0.7).
// Phase A/B — optional lightweight-relevance sub-keys (default 0.5 / 0.15),
// consumed by core/memory/similarity.mjs via buildLessonReadFirst.
const RETRIEVAL_WEIGHTS_OPTIONAL_KEYS = [
  'diversityLambda',
  'diversityJaccardThreshold',
  'triggerKeywordWeight',
  'trigramWeight'
];

const MEMORY_LAYERS_KEYS = {
  reflectionsEnabled: 'boolean',
  proceduralEnabled: 'boolean',
  evolutionEnabled: 'boolean',
  evolutionSimilarityThreshold: 'number',
  proceduralRepeatThreshold: 'number',
  proceduralWindowDays: 'number'
};

function typeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function validateSurfacePatterns(value, errors) {
  // Allowed: string[] or Record<scope, string[]>
  // Empty array/object means "user not yet configured" — PASS (consumers gate on .length).
  if (Array.isArray(value)) {
    if (!value.every((v) => typeof v === 'string')) {
      errors.push({
        path: 'surfacePatterns',
        expected: 'string[] (all string)',
        actual: `array with ${typeName(value.find((v) => typeof v !== 'string'))}`,
        severity: 'fail'
      });
      return false;
    }
    return true; // empty array OK
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return true; // empty object OK
    for (const key of keys) {
      if (!isStringArray(value[key])) {
        errors.push({
          path: `surfacePatterns.${key}`,
          expected: 'string[]',
          actual: typeName(value[key]),
          severity: 'fail'
        });
        return false;
      }
    }
    return true;
  }
  errors.push({
    path: 'surfacePatterns',
    expected: 'string[] | Record<string, string[]>',
    actual: typeName(value),
    severity: 'fail'
  });
  return false;
}

function validateScopeFolderMap(value, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push({
      path: 'scopeFolderMap',
      expected: 'Record<string, string | string[]>',
      actual: typeName(value),
      severity: 'fail'
    });
    return false;
  }
  // Empty object means "user not yet configured" — PASS (consumers gate on Object.keys.length).
  if (Object.keys(value).length === 0) return true;
  // Non-empty: each entry must be string OR non-empty string[].
  // Consumer learning-curate.mjs:102 (`map[normalized]` — string value) and
  // post-edit.mjs:42 (path-segment matching) both accept string OR string[].
  for (const key of Object.keys(value)) {
    const v = value[key];
    const isValidString = typeof v === 'string' && v.length > 0;
    const isValidArray = isStringArray(v) && v.length >= 1;
    if (!isValidString && !isValidArray) {
      errors.push({
        path: 'scopeFolderMap',
        expected: 'Record<string, string | non-empty string[]>',
        actual: 'malformed',
        severity: 'fail'
      });
      return false;
    }
  }
  return true;
}

function validateDefaultScopeConsistency(data, errors) {
  if (!data.scopeFolderMap || typeof data.scopeFolderMap !== 'object') {
    return; // upstream error already recorded
  }
  if (typeof data.defaultScope !== 'string' || data.defaultScope.length === 0) {
    return; // upstream error already recorded
  }
  const keys = Object.keys(data.scopeFolderMap);
  if (keys.length === 0) return; // upstream error
  if (!keys.includes(data.defaultScope)) {
    errors.push({
      path: 'defaultScope',
      expected: `one of scopeFolderMap keys: [${keys.join(', ')}]`,
      actual: data.defaultScope,
      severity: 'fail'
    });
  }
}

function validateRequiredAxes(data, errors) {
  // projectTag
  if (typeof data.projectTag !== 'string' || data.projectTag.length === 0) {
    errors.push({
      path: 'projectTag',
      expected: 'non-empty string',
      actual: typeName(data.projectTag),
      severity: 'fail'
    });
  }
  // defaultScope
  if (typeof data.defaultScope !== 'string' || data.defaultScope.length === 0) {
    errors.push({
      path: 'defaultScope',
      expected: 'non-empty string',
      actual: typeName(data.defaultScope),
      severity: 'fail'
    });
  }
  // surfacePatterns
  validateSurfacePatterns(data.surfacePatterns, errors);
  // scopeFolderMap
  validateScopeFolderMap(data.scopeFolderMap, errors);
  // preserveHooks — empty array allowed
  if (!isStringArray(data.preserveHooks)) {
    errors.push({
      path: 'preserveHooks',
      expected: 'string[]',
      actual: typeName(data.preserveHooks),
      severity: 'fail'
    });
  }
  // sessionEndPipeline — empty array allowed
  if (!isStringArray(data.sessionEndPipeline)) {
    errors.push({
      path: 'sessionEndPipeline',
      expected: 'string[]',
      actual: typeName(data.sessionEndPipeline),
      severity: 'fail'
    });
  }
  // defaultScope must be a key of scopeFolderMap (cross-axis)
  validateDefaultScopeConsistency(data, errors);
}

function validateOptionalExtensions(data, errors) {
  // coreHooks: string[] OR sentinel "all" (install-hooks.mjs reads "all" as enable-all).
  if (data.coreHooks !== undefined) {
    const isSentinel = data.coreHooks === 'all';
    if (!isSentinel && !isStringArray(data.coreHooks)) {
      errors.push({
        path: 'coreHooks',
        expected: 'string[] | "all"',
        actual: typeName(data.coreHooks),
        severity: 'fail'
      });
    }
  }
  // managedRoots — empty array allowed
  if (data.managedRoots !== undefined) {
    if (!isStringArray(data.managedRoots)) {
      errors.push({
        path: 'managedRoots',
        expected: 'string[]',
        actual: typeName(data.managedRoots),
        severity: 'fail'
      });
    }
  }
  // retrievalWeights
  if (data.retrievalWeights !== undefined) {
    const rw = data.retrievalWeights;
    if (!rw || typeof rw !== 'object' || Array.isArray(rw)) {
      errors.push({
        path: 'retrievalWeights',
        expected: 'object',
        actual: typeName(rw),
        severity: 'fail'
      });
    } else {
      for (const key of RETRIEVAL_WEIGHTS_KEYS) {
        if (typeof rw[key] !== 'number' || Number.isNaN(rw[key])) {
          errors.push({
            path: `retrievalWeights.${key}`,
            expected: 'number',
            actual: typeName(rw[key]),
            severity: 'fail'
          });
        }
      }
      // DESIGN_MANUS_C §4-C — diversity sub-keys are optional but, when present,
      // must be valid numbers. Absence is fine (consumer applies defaults).
      for (const key of RETRIEVAL_WEIGHTS_OPTIONAL_KEYS) {
        if (rw[key] === undefined) continue;
        if (typeof rw[key] !== 'number' || Number.isNaN(rw[key])) {
          errors.push({
            path: `retrievalWeights.${key}`,
            expected: 'number',
            actual: typeName(rw[key]),
            severity: 'fail'
          });
        }
      }
    }
  }
  // memoryLayers
  if (data.memoryLayers !== undefined) {
    const ml = data.memoryLayers;
    if (!ml || typeof ml !== 'object' || Array.isArray(ml)) {
      errors.push({
        path: 'memoryLayers',
        expected: 'object',
        actual: typeName(ml),
        severity: 'fail'
      });
    } else {
      for (const [key, expectedType] of Object.entries(MEMORY_LAYERS_KEYS)) {
        if (typeof ml[key] !== expectedType) {
          errors.push({
            path: `memoryLayers.${key}`,
            expected: expectedType,
            actual: typeName(ml[key]),
            severity: 'fail'
          });
        }
      }
    }
  }
}

/**
 * Validate runtime-manifest.json data against the 6-axis + extension contract.
 *
 * @param {unknown} data parsed JSON payload
 * @returns {ValidationResult}
 */
export function validateManifest(data) {
  /** @type {SchemaError[]} */
  const errors = [];

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    errors.push({
      path: '$root',
      expected: 'object',
      actual: typeName(data),
      severity: 'fail'
    });
    return { valid: false, errors };
  }

  validateRequiredAxes(data, errors);
  validateOptionalExtensions(data, errors);

  const valid = errors.every((e) => e.severity !== 'fail');
  return { valid, errors };
}

export const REQUIRED_MANIFEST_AXES = REQUIRED_AXES;
