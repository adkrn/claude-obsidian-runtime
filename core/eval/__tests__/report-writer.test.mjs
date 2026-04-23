import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  writeReport,
  validateReportSchema,
  formatTs,
  atomicWrite,
  SchemaError
} from '../report-writer.mjs';

function baseReport() {
  return {
    projectId: 'talksim',
    runtimeVersion: '0.1.0',
    reportedAt: '2026-04-22T09:40:00.000Z',
    goldenRuns: [],
    presence: { checksPassed: null, note: 'run doctor --full separately' },
    equivalence: { schemaMatch: 1.0, distributionSkew: 0 },
    quality: {
      precisionAt5: 0,
      recallAt10: 0,
      mrr: 0,
      ndcgAt10: 0,
      sampleCount: 0,
      perTaskRows: []
    },
    lessonReuse: {
      reuseRate: 0,
      lessonsCreatedPre: 0,
      lessonsRematched: 0,
      confidenceDist: { high: 0, medium: 0, low: 0 },
      chiSquared: null
    },
    performance: {
      avgTaskStartMs: 0,
      tokenWma7d: 0,
      deltaVsPriorWeek: '0%',
      monotoneDecreasing3d: false,
      perDaySeries: []
    }
  };
}

test('validateReportSchema: passes for complete report', () => {
  assert.doesNotThrow(() => validateReportSchema(baseReport()));
});

test('validateReportSchema: each missing key throws SchemaError naming the key', () => {
  const required = [
    'projectId',
    'runtimeVersion',
    'reportedAt',
    'goldenRuns',
    'presence',
    'equivalence',
    'quality',
    'lessonReuse',
    'performance'
  ];
  for (const key of required) {
    const report = baseReport();
    delete report[key];
    assert.throws(
      () => validateReportSchema(report),
      (err) => err instanceof SchemaError && err.message.includes(key),
      `expected SchemaError mentioning ${key}`
    );
  }
});

test('validateReportSchema: rejects bad reportedAt', () => {
  const report = baseReport();
  report.reportedAt = 'not-a-date';
  assert.throws(() => validateReportSchema(report), /ISO-8601/);
});

test('formatTs: produces YYYYMMDD-HHmm in UTC', () => {
  assert.equal(formatTs('2026-04-22T09:40:00.000Z'), '20260422-0940');
});

test('formatTs: optional seconds form', () => {
  assert.equal(formatTs('2026-04-22T09:40:15.000Z', true), '20260422-094015');
});

test('atomicWrite: writes content and removes tmp file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-atomic-'));
  const target = path.join(dir, 'sub', 'out.json');
  atomicWrite(target, '{"hello":"world"}');
  assert.equal(fs.readFileSync(target, 'utf8'), '{"hello":"world"}');
  assert.equal(fs.existsSync(`${target}.tmp`), false);
});

test('writeReport: validates + writes to expected path with deterministic name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-write-'));
  const reportPath = writeReport(dir, baseReport());
  const expected = path.join(
    dir,
    '.claude',
    'runtime',
    'eval',
    'reports',
    '20260422-0940_talksim.json'
  );
  assert.equal(reportPath, expected);
  const contents = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(contents.projectId, 'talksim');
  assert.equal(contents.goldenRuns.length, 0);
});

test('writeReport: same-minute collision falls back to seconds form', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-collide-'));
  const r1 = writeReport(dir, baseReport());
  const r2Report = baseReport();
  r2Report.reportedAt = '2026-04-22T09:40:30.000Z';
  const r2 = writeReport(dir, r2Report);
  assert.notEqual(r1, r2);
  assert.match(path.basename(r2), /20260422-094030_talksim\.json$/);
});

test('writeReport: invalid report throws before touching disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-bad-'));
  const bad = baseReport();
  delete bad.quality;
  assert.throws(() => writeReport(dir, bad), SchemaError);
  const reportsDir = path.join(dir, '.claude', 'runtime', 'eval', 'reports');
  assert.equal(fs.existsSync(reportsDir), false, 'should not create dir on validation failure');
});
