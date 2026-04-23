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

  it('FAIL: surfacePatterns empty array', () => {
    const m = baseManifest({ surfacePatterns: [] });
    const r = validateManifest(m);
    assert.equal(r.valid, false);
  });

  it('FAIL: scopeFolderMap empty object', () => {
    const m = baseManifest({ scopeFolderMap: {} });
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
