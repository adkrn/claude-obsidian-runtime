import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  checkRuntimeHome,
  checkManifestSchema,
  checkObsidianPaths,
  checkManagedRoots,
  checkHookWrappers,
  checkLeadAgent,
  checkCodeIndex,
  checkKnowledgeIndex,
  checkPrerequisites,
  checkTemplateIntegrity,
  checkPerformanceObservability,
  ALL_CHECK_IDS,
  EXPECTED_CORE_HOOKS,
  DEFAULT_MANAGED_ROOTS
} from '../doctor-checks.mjs';

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-check-'));
  const projectDir = path.join(root, 'proj');
  const packageRoot = path.join(root, 'pkg');
  const vaultRoot = path.join(root, 'vault');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.mkdirSync(vaultRoot, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'claude-obsidian-runtime', version: '0.0.0-test' }), 'utf8');
  return { root, projectDir, packageRoot, vaultRoot };
}

function cleanupSandbox(sb) {
  try { fs.rmSync(sb.root, { recursive: true, force: true }); } catch {}
}

function writeFileSafe(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

function validManifestData(projectTag = 'demo') {
  return {
    projectTag,
    defaultScope: 'backend',
    surfacePatterns: ['backend/src/**/*.ts'],
    scopeFolderMap: { backend: ['backend/src'] },
    preserveHooks: [],
    sessionEndPipeline: []
  };
}

function baseCtx(sb) {
  return {
    projectDir: sb.projectDir,
    packageRoot: sb.packageRoot,
    manifest: null,
    paths: null
  };
}

describe('doctor-checks ID coverage', () => {
  it('exports 11 checks (C09 excluded)', () => {
    assert.equal(ALL_CHECK_IDS.length, 11);
    assert.ok(!ALL_CHECK_IDS.includes('c09'));
  });
});

describe('C01 checkRuntimeHome', () => {
  let sb;
  before(() => { sb = makeSandbox(); });
  after(() => cleanupSandbox(sb));

  it('PASS when packageRoot + package.json exist', () => {
    const c = checkRuntimeHome(baseCtx(sb));
    assert.equal(c.status, 'pass');
    assert.equal(c.id, 'c01');
  });

  it('FAIL when packageRoot path invalid', () => {
    const prev = process.env.CLAUDE_RUNTIME_HOME;
    delete process.env.CLAUDE_RUNTIME_HOME;
    try {
      const ctx = baseCtx(sb);
      ctx.packageRoot = path.join(sb.root, 'does-not-exist');
      const c = checkRuntimeHome(ctx);
      assert.equal(c.status, 'fail');
    } finally {
      if (prev) process.env.CLAUDE_RUNTIME_HOME = prev;
    }
  });
});

describe('C02 checkManifestSchema', () => {
  let sb;
  before(() => { sb = makeSandbox(); });
  after(() => cleanupSandbox(sb));

  it('FAIL when manifest missing', () => {
    const c = checkManifestSchema(baseCtx(sb));
    assert.equal(c.status, 'fail');
    assert.match(c.message, /Missing/);
  });

  it('PASS with 6-axis manifest + populates ctx.manifest', () => {
    const manifestPath = path.join(sb.projectDir, '.claude', 'runtime-manifest.json');
    writeFileSafe(manifestPath, JSON.stringify(validManifestData()));
    const ctx = baseCtx(sb);
    const c = checkManifestSchema(ctx);
    assert.equal(c.status, 'pass', c.message);
    assert.equal(ctx.manifest?.projectTag, 'demo');
  });

  it('FAIL when required axis dropped', () => {
    const manifestPath = path.join(sb.projectDir, '.claude', 'runtime-manifest.json');
    const broken = validManifestData();
    delete broken.preserveHooks;
    writeFileSafe(manifestPath, JSON.stringify(broken));
    const c = checkManifestSchema(baseCtx(sb));
    assert.equal(c.status, 'fail');
    assert.match(c.message, /preserveHooks/);
  });
});

describe('C03 checkObsidianPaths', () => {
  let sb;
  before(() => { sb = makeSandbox(); });
  after(() => cleanupSandbox(sb));

  it('WARN when obsidian_paths.json missing', () => {
    const c = checkObsidianPaths(baseCtx(sb));
    assert.equal(c.status, 'warn');
  });

  it('PASS when vaultRoot resolves + populates ctx.paths', () => {
    const p = path.join(sb.projectDir, 'document', 'obsidian_context', '_meta', 'obsidian_paths.json');
    writeFileSafe(p, JSON.stringify({ vaultRoot: sb.vaultRoot, managedRoots: DEFAULT_MANAGED_ROOTS }));
    const ctx = baseCtx(sb);
    const c = checkObsidianPaths(ctx);
    assert.equal(c.status, 'pass');
    assert.equal(ctx.paths?.vaultRoot, sb.vaultRoot);
  });

  it('FAIL when vaultRoot does not exist', () => {
    const p = path.join(sb.projectDir, 'document', 'obsidian_context', '_meta', 'obsidian_paths.json');
    writeFileSafe(p, JSON.stringify({ vaultRoot: path.join(sb.root, 'nope') }));
    const c = checkObsidianPaths(baseCtx(sb));
    assert.equal(c.status, 'fail');
  });
});

describe('C04 checkManagedRoots (default 9 fallback)', () => {
  let sb;
  before(() => { sb = makeSandbox(); });
  after(() => cleanupSandbox(sb));

  it('WARN when managed roots absent from vault', () => {
    const ctx = baseCtx(sb);
    ctx.paths = { vaultRoot: sb.vaultRoot };
    const c = checkManagedRoots(ctx);
    assert.equal(c.status, 'warn');
    assert.match(c.message, /not created yet/);
  });

  it('PASS when all 9 default roots exist', () => {
    const ctx = baseCtx(sb);
    ctx.paths = { vaultRoot: sb.vaultRoot };
    for (const r of DEFAULT_MANAGED_ROOTS) {
      fs.mkdirSync(path.join(sb.vaultRoot, r), { recursive: true });
    }
    const c = checkManagedRoots(ctx);
    assert.equal(c.status, 'pass');
  });

  it('PASS when managedRoots explicitly empty', () => {
    const ctx = baseCtx(sb);
    ctx.paths = { vaultRoot: sb.vaultRoot };
    ctx.manifest = { managedRoots: [] };
    const c = checkManagedRoots(ctx);
    assert.equal(c.status, 'pass');
    assert.match(c.message, /explicit empty/);
  });
});

describe('C05 checkHookWrappers', () => {
  let sb;
  before(() => { sb = makeSandbox(); });
  after(() => cleanupSandbox(sb));

  it('FAIL when .claude/hooks missing', () => {
    const c = checkHookWrappers(baseCtx(sb));
    assert.equal(c.status, 'fail');
  });

  it('FAIL when core hook missing', () => {
    const hooksDir = path.join(sb.projectDir, '.claude', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    // Only write 3 of the 6 core hooks
    for (const h of EXPECTED_CORE_HOOKS.slice(0, 3)) {
      writeFileSafe(path.join(hooksDir, h), '#!/usr/bin/env bash\necho ok\n');
    }
    const c = checkHookWrappers(baseCtx(sb));
    assert.equal(c.status, 'fail');
    assert.match(c.message, /Missing core hook/);
  });

  it('PASS or WARN (bash-unavailable) when all 6 core hooks exist', () => {
    const hooksDir = path.join(sb.projectDir, '.claude', 'hooks');
    fs.rmSync(hooksDir, { recursive: true, force: true });
    fs.mkdirSync(hooksDir, { recursive: true });
    for (const h of EXPECTED_CORE_HOOKS) {
      writeFileSafe(path.join(hooksDir, h), '#!/usr/bin/env bash\necho ok\n');
    }
    const c = checkHookWrappers(baseCtx(sb));
    assert.ok(c.status === 'pass' || c.status === 'warn', `got ${c.status}: ${c.message}`);
  });
});

describe('C06 checkLeadAgent', () => {
  let sb;
  before(() => { sb = makeSandbox(); });
  after(() => cleanupSandbox(sb));

  it('WARN when manifest.projectTag missing', () => {
    const c = checkLeadAgent(baseCtx(sb));
    assert.equal(c.status, 'warn');
  });

  it('FAIL when lead agent file missing', () => {
    const ctx = baseCtx(sb);
    ctx.manifest = { projectTag: 'demo' };
    const c = checkLeadAgent(ctx);
    assert.equal(c.status, 'fail');
  });

  it('PASS when lead agent has valid frontmatter', () => {
    const ctx = baseCtx(sb);
    ctx.manifest = { projectTag: 'demo' };
    const agentPath = path.join(sb.projectDir, '.claude', 'agents', 'demo-lead.md');
    writeFileSafe(agentPath, `---\nname: demo-lead\ntools: [Read, Edit, Bash]\n---\n\n# body\n`);
    const c = checkLeadAgent(ctx);
    assert.equal(c.status, 'pass');
  });

  it('FAIL when name in frontmatter mismatched', () => {
    const ctx = baseCtx(sb);
    ctx.manifest = { projectTag: 'demo' };
    const agentPath = path.join(sb.projectDir, '.claude', 'agents', 'demo-lead.md');
    writeFileSafe(agentPath, `---\nname: other-lead\ntools: [Read]\n---\nbody\n`);
    const c = checkLeadAgent(ctx);
    assert.equal(c.status, 'fail');
  });
});

describe('C07 checkCodeIndex', () => {
  let sb;
  before(() => { sb = makeSandbox(); });
  after(() => cleanupSandbox(sb));

  it('WARN when code-index dir missing', () => {
    const c = checkCodeIndex(baseCtx(sb));
    assert.equal(c.status, 'warn');
  });

  it('PASS when jsonl rows parse cleanly', () => {
    const p = path.join(sb.projectDir, '.claude', 'runtime', 'code-index', 'backend.jsonl');
    writeFileSafe(p, `${JSON.stringify({ id: 'a' })}\n${JSON.stringify({ id: 'b' })}\n`);
    const c = checkCodeIndex(baseCtx(sb));
    assert.equal(c.status, 'pass');
    assert.match(c.message, /2 total rows/);
  });

  it('FAIL on malformed JSONL row', () => {
    const p = path.join(sb.projectDir, '.claude', 'runtime', 'code-index', 'backend.jsonl');
    writeFileSafe(p, `${JSON.stringify({ id: 'a' })}\n{broken\n`);
    const c = checkCodeIndex(baseCtx(sb));
    assert.equal(c.status, 'fail');
  });
});

describe('C08 checkKnowledgeIndex', () => {
  let sb;
  before(() => { sb = makeSandbox(); });
  after(() => cleanupSandbox(sb));

  it('WARN when knowledge dir missing', () => {
    const c = checkKnowledgeIndex(baseCtx(sb));
    assert.equal(c.status, 'warn');
  });

  it('PASS when all three files present + parseable', () => {
    const dir = path.join(sb.projectDir, '.claude', 'runtime', 'knowledge');
    fs.mkdirSync(dir, { recursive: true });
    writeFileSafe(path.join(dir, 'lessons.jsonl'), `${JSON.stringify({ id: 'seed:1' })}\n`);
    writeFileSafe(path.join(dir, 'troubleshooting.jsonl'), `${JSON.stringify({ id: 't1' })}\n`);
    writeFileSafe(path.join(dir, 'decisions.jsonl'), `${JSON.stringify({ id: 'd1' })}\n`);
    const c = checkKnowledgeIndex(baseCtx(sb));
    assert.equal(c.status, 'pass');
  });

  it('FAIL on malformed row', () => {
    const dir = path.join(sb.projectDir, '.claude', 'runtime', 'knowledge');
    writeFileSafe(path.join(dir, 'lessons.jsonl'), `{broken\n`);
    const c = checkKnowledgeIndex(baseCtx(sb));
    assert.equal(c.status, 'fail');
  });
});

describe('C10 checkPrerequisites', () => {
  it('PASS or FAIL based on node/git availability (node in sandbox is >= 20)', () => {
    const c = checkPrerequisites({ projectDir: '', packageRoot: '' });
    assert.ok(['pass', 'fail'].includes(c.status));
    assert.equal(c.id, 'c10');
  });
});

describe('C11 checkTemplateIntegrity', () => {
  let sb;
  before(() => { sb = makeSandbox(); });
  after(() => cleanupSandbox(sb));

  it('FAIL when templates/ dir missing', () => {
    const ctx = baseCtx(sb);
    const c = checkTemplateIntegrity(ctx);
    assert.equal(c.status, 'fail');
  });

  it('WARN when templates/_manifest.json missing (pre-publish)', () => {
    fs.mkdirSync(path.join(sb.packageRoot, 'templates'), { recursive: true });
    const c = checkTemplateIntegrity(baseCtx(sb));
    assert.equal(c.status, 'warn');
  });

  it('PASS when sha256 matches manifest entry', async () => {
    const templatesDir = path.join(sb.packageRoot, 'templates');
    fs.mkdirSync(templatesDir, { recursive: true });
    writeFileSafe(path.join(templatesDir, 'sample.md'), 'hello');
    const crypto = await import('node:crypto');
    const sha = crypto.createHash('sha256').update('hello').digest('hex');
    writeFileSafe(
      path.join(templatesDir, '_manifest.json'),
      JSON.stringify({ files: [{ relPath: 'sample.md', sha256: sha, required: true }] })
    );
    const c = checkTemplateIntegrity(baseCtx(sb));
    assert.equal(c.status, 'pass');
  });

  it('FAIL on sha256 mismatch', () => {
    const templatesDir = path.join(sb.packageRoot, 'templates');
    writeFileSafe(path.join(templatesDir, 'sample.md'), 'TAMPERED');
    const c = checkTemplateIntegrity(baseCtx(sb));
    assert.equal(c.status, 'fail');
  });
});

describe('C12 checkPerformanceObservability', () => {
  let sb;
  before(() => { sb = makeSandbox(); });
  after(() => cleanupSandbox(sb));

  it('WARN when last-context.json missing', () => {
    const c = checkPerformanceObservability(baseCtx(sb));
    assert.equal(c.status, 'warn');
  });

  it('FAIL when last-context.json >1MB', () => {
    const p = path.join(sb.projectDir, '.claude', 'runtime', 'retrieval', 'last-context.json');
    writeFileSafe(p, 'x'.repeat(1024 * 1024 + 10));
    const c = checkPerformanceObservability(baseCtx(sb));
    assert.equal(c.status, 'fail');
  });

  it('PASS when last-context small and token skew < 30%', () => {
    const p = path.join(sb.projectDir, '.claude', 'runtime', 'retrieval', 'last-context.json');
    writeFileSafe(p, '{}');
    const usageDir = path.join(sb.projectDir, '.claude', 'runtime', 'task-usage');
    fs.mkdirSync(usageDir, { recursive: true });
    writeFileSafe(path.join(usageDir, 'a.json'), JSON.stringify({ totalTokens: 1000 }));
    writeFileSafe(path.join(usageDir, 'b.json'), JSON.stringify({ totalTokens: 1100 }));
    writeFileSafe(path.join(usageDir, 'c.json'), JSON.stringify({ totalTokens: 1200 }));
    const c = checkPerformanceObservability(baseCtx(sb));
    assert.equal(c.status, 'pass', c.message);
  });

  it('FAIL when token skew >= 30%', () => {
    const usageDir = path.join(sb.projectDir, '.claude', 'runtime', 'task-usage');
    for (const f of fs.readdirSync(usageDir)) fs.rmSync(path.join(usageDir, f), { force: true });
    writeFileSafe(path.join(usageDir, 'a.json'), JSON.stringify({ totalTokens: 1000 }));
    writeFileSafe(path.join(usageDir, 'b.json'), JSON.stringify({ totalTokens: 1500 }));
    writeFileSafe(path.join(usageDir, 'c.json'), JSON.stringify({ totalTokens: 2000 }));
    const c = checkPerformanceObservability(baseCtx(sb));
    assert.equal(c.status, 'fail');
  });
});
