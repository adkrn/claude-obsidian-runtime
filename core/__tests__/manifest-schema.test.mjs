import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest, REQUIRED_MANIFEST_AXES } from '../manifest-schema.mjs';

function baseManifest(overrides = {}) {
  return {
    projectTag: 'demo',
    defaultScope: 'backend',
    surfacePatterns: ['backend/src/**/*.ts'],
    scopeFolderMap: { backend: ['backend/src'] },
    preserveHooks: [],
    sessionEndPipeline: [],
    ...overrides
  };
}

describe('manifest-schema.validateManifest', () => {
  it('returns REQUIRED_MANIFEST_AXES as the 6 required fields', () => {
    assert.deepEqual(
      REQUIRED_MANIFEST_AXES.sort(),
      [
        'defaultScope',
        'preserveHooks',
        'projectTag',
        'scopeFolderMap',
        'sessionEndPipeline',
        'surfacePatterns'
      ].sort()
    );
  });

  it('PASS: minimal 6-axis manifest (no extensions)', () => {
    const result = validateManifest(baseManifest());
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    assert.deepEqual(result.errors, []);
  });

  it('FAIL: root not an object', () => {
    const r = validateManifest(null);
    assert.equal(r.valid, false);
    assert.equal(r.errors[0].path, '$root');
  });

  it('FAIL: missing preserveHooks (6-axis required)', () => {
    const m = baseManifest();
    delete m.preserveHooks;
    const r = validateManifest(m);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.path === 'preserveHooks' && e.severity === 'fail'));
  });

  it('FAIL: multiple required missing produces multiple errors', () => {
    const m = baseManifest();
    delete m.preserveHooks;
    delete m.sessionEndPipeline;
    const r = validateManifest(m);
    assert.equal(r.valid, false);
    const paths = r.errors.map((e) => e.path);
    assert.ok(paths.includes('preserveHooks'));
    assert.ok(paths.includes('sessionEndPipeline'));
  });

  it('FAIL: surfacePatterns wrong type', () => {
    const m = baseManifest({ surfacePatterns: 'not-an-array' });
    const r = validateManifest(m);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.path === 'surfacePatterns'));
  });

  it('PASS: surfacePatterns as Record<scope, string[]>', () => {
    const m = baseManifest({ surfacePatterns: { backend: ['backend/src/**/*.ts'] } });
    const r = validateManifest(m);
    assert.equal(r.valid, true);
  });

  it('PASS: surfacePatterns empty array (user not yet configured)', () => {
    // Empty value is template default; consumers (post-edit/session-end) gate on .length > 0.
    const m = baseManifest({ surfacePatterns: [] });
    const r = validateManifest(m);
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });

  it('PASS: scopeFolderMap empty object (user not yet configured)', () => {
    // Empty value is template default; consumers gate on Object.keys.length > 0.
    // defaultScope consistency check is also skipped when scopeFolderMap is empty.
    const m = baseManifest({ scopeFolderMap: {} });
    const r = validateManifest(m);
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });

  it('FAIL: scopeFolderMap with empty value array still rejected', () => {
    // Non-empty map but malformed entry should still fail.
    const m = baseManifest({ scopeFolderMap: { backend: [] } });
    const r = validateManifest(m);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.path === 'scopeFolderMap'));
  });

  it('PASS: scopeFolderMap with string values (consumer learning-curate.mjs:102 pattern)', () => {
    // talkSim-style: { "scope-name": "FolderName" } — consumer reads `map[normalized]` as string.
    const m = baseManifest({
      defaultScope: 'frontend',
      scopeFolderMap: { frontend: 'Frontend', backend: 'Backend' }
    });
    const r = validateManifest(m);
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });

  it('FAIL: scopeFolderMap with empty string value', () => {
    const m = baseManifest({ scopeFolderMap: { backend: '' } });
    const r = validateManifest(m);
    assert.equal(r.valid, false);
  });

  it('FAIL: scopeFolderMap with non-string non-array value', () => {
    const m = baseManifest({ scopeFolderMap: { backend: 42 } });
    const r = validateManifest(m);
    assert.equal(r.valid, false);
  });

  it('FAIL: defaultScope not a key of scopeFolderMap', () => {
    const m = baseManifest({
      defaultScope: 'nope',
      scopeFolderMap: { backend: ['backend/src'] }
    });
    const r = validateManifest(m);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.path === 'defaultScope'));
  });

  it('PASS: extensions absent (optional)', () => {
    const m = baseManifest();
    const r = validateManifest(m);
    assert.equal(r.valid, true);
  });

  it('PASS: coreHooks sentinel "all" (install-hooks.mjs reads as enable-all)', () => {
    const m = baseManifest({ coreHooks: 'all' });
    const r = validateManifest(m);
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });

  it('PASS: coreHooks string[] explicit list', () => {
    const m = baseManifest({ coreHooks: ['PostToolUse', 'SessionEnd'] });
    const r = validateManifest(m);
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });

  it('FAIL: coreHooks invalid sentinel', () => {
    const m = baseManifest({ coreHooks: 'all-of-them' });
    const r = validateManifest(m);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.path === 'coreHooks'));
  });

  it('PASS: managedRoots explicit empty array allowed', () => {
    const m = baseManifest({ managedRoots: [] });
    const r = validateManifest(m);
    assert.equal(r.valid, true);
  });

  it('FAIL: managedRoots wrong element type', () => {
    const m = baseManifest({ managedRoots: ['00_Home', 123] });
    const r = validateManifest(m);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.path === 'managedRoots'));
  });

  it('PASS: retrievalWeights fully typed', () => {
    const m = baseManifest({
      retrievalWeights: {
        alphaRecency: 1.0,
        alphaImportance: 1.0,
        alphaRelevance: 1.5,
        decayRatePerDay: 0.05
      }
    });
    const r = validateManifest(m);
    assert.equal(r.valid, true);
  });

  it('FAIL: retrievalWeights string where number expected', () => {
    const m = baseManifest({
      retrievalWeights: {
        alphaRecency: '1.0',
        alphaImportance: 1.0,
        alphaRelevance: 1.5,
        decayRatePerDay: 0.05
      }
    });
    const r = validateManifest(m);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.path === 'retrievalWeights.alphaRecency'));
  });

  it('FAIL: memoryLayers missing typed field', () => {
    const m = baseManifest({
      memoryLayers: {
        reflectionsEnabled: true,
        proceduralEnabled: true,
        evolutionEnabled: true,
        evolutionSimilarityThreshold: 0.7,
        proceduralRepeatThreshold: 3
        // proceduralWindowDays missing
      }
    });
    const r = validateManifest(m);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.path === 'memoryLayers.proceduralWindowDays'));
  });
});
