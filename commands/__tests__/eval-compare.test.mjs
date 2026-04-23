import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI_PATH = path.resolve(__dirname, '..', 'eval-compare.mjs');

function baseReport(over = {}) {
  return {
    projectId: 'A',
    runtimeVersion: '3.0.0',
    reportedAt: '2026-04-23T00:00:00.000Z',
    goldenRuns: [
      {
        taskId: 't1',
        readFirstCount: 2,
        codeHitsCount: 3,
        guardrailsCount: 1,
        actualScopes: ['workflow'],
        rawSchemaKeys: ['taskId', 'readFirst', 'codeHits', 'knowledgeHits', 'guardrails', 'matchedScopes', 'matchedGroups', 'currentTaskPath', 'lastContextPath']
      }
    ],
    presence: { checksPassed: 12 },
    equivalence: { schemaMatch: 1.0, distributionSkew: 0 },
    quality: { precisionAt5: 0.8, recallAt10: 0.7, mrr: 0.9, ndcgAt10: 0.85, sampleCount: 10 },
    lessonReuse: { reuseRate: 0.4, lessonsCreatedPre: 5, lessonsRematched: 2, confidenceDist: { high: 1, medium: 3, low: 1 } },
    performance: { avgTaskStartMs: 1000, tokenWma7d: 8000, monotoneDecreasing3d: true, perDaySeries: [] },
    ...over
  };
}

function writeTwoReports(aOver = {}, bOver = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-cli-'));
  const aPath = path.join(dir, 'a.json');
  const bPath = path.join(dir, 'b.json');
  fs.writeFileSync(aPath, JSON.stringify(baseReport(aOver)));
  fs.writeFileSync(bPath, JSON.stringify(baseReport({ projectId: 'B', ...bOver })));
  return { dir, aPath, bPath };
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], { encoding: 'utf8' });
}

test('eval-compare — identical reports → exit 0, verdict pass', () => {
  const { aPath, bPath } = writeTwoReports();
  const r = runCli(['--reports', aPath, bPath]);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('PASS') || r.stdout.includes('Verdict: PASS'));
});

test('eval-compare — schema divergence → exit 1', () => {
  const { aPath, bPath } = writeTwoReports(
    {},
    { goldenRuns: [{ ...baseReport().goldenRuns[0], rawSchemaKeys: ['taskId'] }] }
  );
  const r = runCli(['--reports', aPath, bPath]);
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes('FAIL'));
});

test('eval-compare — token delta >15% → exit 1', () => {
  const { aPath, bPath } = writeTwoReports(
    {},
    { performance: { ...baseReport().performance, tokenWma7d: 12000 } }
  );
  const r = runCli(['--reports', aPath, bPath]);
  assert.equal(r.status, 1);
});

test('eval-compare --json → stdout parseable JSON', () => {
  const { aPath, bPath } = writeTwoReports();
  const r = runCli(['--reports', aPath, bPath, '--json']);
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.ok('verdict' in parsed);
  assert.ok('equivalence' in parsed);
});

test('eval-compare — missing report path → exit 1 with friendly stderr', () => {
  const r = runCli(['--reports', '/nonexistent/a.json', '/nonexistent/b.json']);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.length > 0);
});
