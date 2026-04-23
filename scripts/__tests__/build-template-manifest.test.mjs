import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildManifest,
  writeManifest,
  isRequiredTemplate,
  sha256File
} from '../build-template-manifest.mjs';

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-manifest-'));
  const packageRoot = path.join(root, 'pkg');
  const templatesDir = path.join(packageRoot, 'templates');
  fs.mkdirSync(templatesDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({ name: 'pkg', version: '9.9.9' }),
    'utf8'
  );
  return { root, packageRoot, templatesDir };
}

function cleanup(sb) {
  try {
    fs.rmSync(sb.root, { recursive: true, force: true });
  } catch {}
}

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

describe('isRequiredTemplate', () => {
  it('marks hooks/*.sh as required', () => {
    assert.equal(isRequiredTemplate('hooks/runtime-session-start.sh'), true);
  });
  it('marks obsidian_paths.json / context_routes.json / runtime-manifest.json as required', () => {
    assert.equal(isRequiredTemplate('obsidian_paths.json'), true);
    assert.equal(isRequiredTemplate('context_routes.json'), true);
    assert.equal(isRequiredTemplate('runtime-manifest.json'), true);
  });
  it('marks vault/00_Home/*.md as required', () => {
    assert.equal(isRequiredTemplate('vault/00_Home/_Index.md'), true);
    assert.equal(isRequiredTemplate('vault/00_Home/Current_Focus.md'), true);
  });
  it('marks eval/golden-tasks.json as required', () => {
    assert.equal(isRequiredTemplate('eval/golden-tasks.json'), true);
  });
  it('marks commands/*.md as optional (false)', () => {
    assert.equal(isRequiredTemplate('commands/task-start.md'), false);
  });
  it('excludes _manifest.json itself', () => {
    assert.equal(isRequiredTemplate('_manifest.json'), false);
  });
});

describe('buildManifest — fixtures', () => {
  let sb;
  before(() => {
    sb = makeSandbox();
    writeFile(
      path.join(sb.templatesDir, 'hooks', 'runtime-session-start.sh'),
      '#!/bin/bash\necho start\n'
    );
    writeFile(
      path.join(sb.templatesDir, 'obsidian_paths.json'),
      '{"vaultRoot":"placeholder"}\n'
    );
    writeFile(
      path.join(sb.templatesDir, 'commands', 'task-start.md'),
      '# slash command\n'
    );
  });
  after(() => cleanup(sb));

  it('emits one record per file with sha256 + size + required flag', () => {
    const manifest = buildManifest({
      templatesDir: sb.templatesDir,
      packageRoot: sb.packageRoot,
      now: new Date('2026-04-23T00:00:00Z')
    });
    assert.equal(manifest.schemaVersion, '1.0.0');
    assert.equal(manifest.packageVersion, '9.9.9');
    assert.equal(manifest.generatedAt, '2026-04-23T00:00:00.000Z');
    assert.equal(manifest.files.length, 3);

    const byPath = Object.fromEntries(manifest.files.map((f) => [f.relPath, f]));
    assert.equal(byPath['hooks/runtime-session-start.sh'].required, true);
    assert.equal(byPath['obsidian_paths.json'].required, true);
    assert.equal(byPath['commands/task-start.md'].required, false);

    for (const f of manifest.files) {
      assert.ok(/^[0-9a-f]{64}$/.test(f.sha256));
      assert.ok(f.size >= 0);
    }
  });

  it('is deterministic — same inputs yield identical rootFingerprint', () => {
    const a = buildManifest({
      templatesDir: sb.templatesDir,
      packageRoot: sb.packageRoot,
      now: new Date('2026-04-23T00:00:00Z')
    });
    const b = buildManifest({
      templatesDir: sb.templatesDir,
      packageRoot: sb.packageRoot,
      now: new Date('2026-04-23T00:00:00Z')
    });
    assert.equal(a.rootFingerprint, b.rootFingerprint);
    // Manifests structurally identical too.
    assert.deepEqual(a.files, b.files);
  });

  it('sorts files[] by relPath (stable lexicographic)', () => {
    const manifest = buildManifest({
      templatesDir: sb.templatesDir,
      packageRoot: sb.packageRoot
    });
    const paths = manifest.files.map((f) => f.relPath);
    const sorted = [...paths].sort((a, b) => a.localeCompare(b));
    assert.deepEqual(paths, sorted);
  });

  it('sha256File matches direct crypto.createHash for a file', () => {
    const content = 'check me\n';
    const fp = path.join(sb.templatesDir, 'tmp-check.txt');
    writeFile(fp, content);
    const expected = crypto.createHash('sha256').update(content).digest('hex');
    assert.equal(sha256File(fp), expected);
    fs.unlinkSync(fp);
  });
});

describe('writeManifest — real filesystem', () => {
  let sb;
  before(() => {
    sb = makeSandbox();
    writeFile(
      path.join(sb.templatesDir, 'hooks', 'runtime-stop.sh'),
      '#!/bin/bash\n'
    );
  });
  after(() => cleanup(sb));

  it('writes templates/_manifest.json and excludes itself from files[]', () => {
    const manifestPath = path.join(sb.templatesDir, '_manifest.json');
    writeManifest({
      templatesDir: sb.templatesDir,
      packageRoot: sb.packageRoot,
      manifestPath
    });
    assert.ok(fs.existsSync(manifestPath));
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const paths = parsed.files.map((f) => f.relPath);
    assert.ok(!paths.includes('_manifest.json'));
    assert.ok(paths.includes('hooks/runtime-stop.sh'));
  });

  it('throws if templates directory is missing', () => {
    const missingDir = path.join(sb.root, 'does-not-exist', 'templates');
    assert.throws(
      () =>
        buildManifest({
          templatesDir: missingDir,
          packageRoot: sb.packageRoot
        }),
      /templates directory missing/
    );
  });
});
