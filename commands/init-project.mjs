#!/usr/bin/env node

/**
 * Initialize a new project for Obsidian-Claude runtime integration (v3.0.0).
 *
 * Wave 3 A3 — 기획서 §5-①/③ + §12-5 managedRoots 9개 + §12-4 doctor 자동 호출.
 *
 * Usage:
 *   claude-obsidian-runtime init --project-id <id> --vault-root <path>
 *                                [--project-dir <path>] [--preserve] [--no-doctor]
 *                                [--force] [--skip-hooks]
 *
 * Does:
 *   1. Create 9 managed vault roots (§12-5 v3.1) + Drafts/Auto subfolders
 *   2. Copy vault templates (Index, Current_Focus, Reading_Order) with {{PROJECT_ID}} substitution
 *   3. Copy obsidian_paths.json, context_routes.json, runtime-manifest.json templates
 *   4. Create .claude/runtime/ subdirectories
 *   5. Copy .claude/commands/*.md slash command templates
 *   6. Copy templates/agents/_lead.md → .claude/agents/<projectId>-lead.md (§5-③ AC-15)
 *   7. Copy templates/eval/golden-tasks.json → .claude/runtime/eval/golden-tasks.json
 *   8. Invoke install-hooks to register hooks and patch settings.json
 *   9. Auto-inject CLAUDE_RUNTIME_HOME into .claude/settings.local.json env
 *      (preserves existing keys; v3.3.4)
 *  10. Invoke doctor --full --since-init (§12-4) unless --no-doctor
 *
 * Idempotent: existing files are not overwritten (see --force for lead upsert).
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const TEMPLATES_DIR = path.join(PACKAGE_ROOT, 'templates');

/**
 * §12-5 v3.1 — managedRoots 9개 기본값 (L3/L4 신설 포함).
 */
export const DEFAULT_MANAGED_ROOTS_9 = [
  '00_Home',
  '04_Architecture',
  '06_Troubleshooting',
  '07_Decisions',
  '08_Lessons',
  '08_Reflections',
  '09_Templates',
  '09_Templates/Procedures',
  '10_Worklogs'
];

/**
 * 각 managedRoot 아래에 생성하는 Drafts/Auto 서브폴더. init은 빈 디렉토리만 준비한다.
 */
const MANAGED_ROOT_SUBDIRS = [
  '04_Architecture/Drafts',
  '04_Architecture/Generated',
  '06_Troubleshooting/Drafts',
  '07_Decisions/Drafts',
  '08_Lessons/Drafts',
  '08_Reflections/Drafts',
  '10_Worklogs/Auto'
];

const RUNTIME_SUBDIRS = [
  'tasks',
  'events',
  'retrieval',
  'code-index',
  'knowledge',
  'architecture',
  'eval'
];

export function parseArgs(argv) {
  const args = {
    projectId: '',
    projectDir: '',
    vaultRoot: '',
    preserve: false,
    noDoctor: false,
    force: false,
    skipHooks: false,
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project-id' && argv[i + 1]) { args.projectId = argv[++i]; }
    else if (a === '--project-dir' && argv[i + 1]) { args.projectDir = argv[++i]; }
    else if (a === '--vault-root' && argv[i + 1]) { args.vaultRoot = argv[++i]; }
    else if (a === '--preserve') { args.preserve = true; }
    else if (a === '--no-doctor') { args.noDoctor = true; }
    else if (a === '--force') { args.force = true; }
    else if (a === '--skip-hooks') { args.skipHooks = true; }
    else if (a === '--help' || a === '-h') { args.help = true; }
  }
  return args;
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

export function substitute(content, vars) {
  return Object.entries(vars).reduce(
    (acc, [k, v]) => acc.replaceAll(`{{${k}}}`, v),
    content
  );
}

function usage() {
  return [
    'Usage: claude-obsidian-runtime init --project-id <id> --vault-root <path>',
    '                                    [--project-dir <path>] [--preserve]',
    '                                    [--no-doctor] [--force] [--skip-hooks]',
    '',
    '  --project-id <id>     (필수) 프로젝트 식별자 (예: talksim, poeact)',
    '  --vault-root <path>   (필수) Obsidian 볼트 경로',
    '  --project-dir <path>  (선택) 프로젝트 루트 (기본: cwd)',
    '  --preserve            (선택) 기존 파일 덮어쓰지 않음 (default)',
    '  --no-doctor           (선택) doctor --full --since-init 자동 호출 skip',
    '  --force               (선택) <projectId>-lead.md 덮어쓰기 허용',
    '  --skip-hooks          (선택) install-hooks 호출 skip'
  ].join('\n');
}

/**
 * 순수 함수: init 스캐폴드 실행 (doctor/install-hooks 부수 효과 제외).
 * @returns {{ created: string[], skipped: string[], missingTemplates: string[], leadPath: string, vaultRoot: string, projectDir: string }}
 */
export function runInit(opts) {
  const {
    projectId,
    projectDir,
    vaultRoot,
    preserve = false,
    force = false,
    templatesDir = TEMPLATES_DIR
  } = opts;

  if (!projectId) throw new Error('projectId required');
  if (!projectDir) throw new Error('projectDir required');
  if (!vaultRoot) throw new Error('vaultRoot required');

  const vars = {
    PROJECT_ID: projectId,
    VAULT_ROOT: vaultRoot.replace(/\\/g, '/')
  };

  const report = {
    created: [],
    skipped: [],
    missingTemplates: [],
    leadPath: '',
    vaultRoot,
    projectDir
  };

  const record = (status, target) => {
    if (status === 'written') report.created.push(target);
    else if (status === 'skipped') report.skipped.push(target);
    else if (status === 'missing') report.missingTemplates.push(target);
  };

  // 1. 9 managed vault roots + subdirs
  for (const root of DEFAULT_MANAGED_ROOTS_9) {
    ensureDir(path.join(vaultRoot, ...root.split('/')));
  }
  for (const sub of MANAGED_ROOT_SUBDIRS) {
    ensureDir(path.join(vaultRoot, ...sub.split('/')));
  }

  // 2. vault 00_Home/*.md
  const vaultFiles = [
    {
      templateRel: 'vault/00_Home/_Index.md',
      target: path.join(vaultRoot, '00_Home', `${projectId}_Index.md`)
    },
    {
      templateRel: 'vault/00_Home/Current_Focus.md',
      target: path.join(vaultRoot, '00_Home', 'Current_Focus.md')
    },
    {
      templateRel: 'vault/00_Home/Reading_Order.md',
      target: path.join(vaultRoot, '00_Home', 'Reading_Order.md')
    }
  ];
  for (const { templateRel, target } of vaultFiles) {
    const { status } = copyTemplateWith(templatesDir, templateRel, target, vars, false);
    record(status, target);
  }

  // 3. _meta/ configs
  const metaDir = path.join(projectDir, 'document', 'obsidian_context', '_meta');
  ensureDir(metaDir);
  const metaFiles = [
    { templateRel: 'obsidian_paths.json', target: path.join(metaDir, 'obsidian_paths.json') },
    { templateRel: 'context_routes.json', target: path.join(metaDir, 'context_routes.json') }
  ];
  for (const { templateRel, target } of metaFiles) {
    const { status } = copyTemplateWith(templatesDir, templateRel, target, vars, false);
    record(status, target);
  }

  // 4. .claude/runtime/ subdirs
  const runtimeDir = path.join(projectDir, '.claude', 'runtime');
  for (const subdir of RUNTIME_SUBDIRS) {
    ensureDir(path.join(runtimeDir, subdir));
  }

  // 5. runtime-manifest.json
  const manifestTarget = path.join(projectDir, '.claude', 'runtime-manifest.json');
  {
    const { status } = copyTemplateWith(templatesDir, 'runtime-manifest.json', manifestTarget, vars, false);
    record(status, manifestTarget);
  }

  // 6. slash command templates
  const commandsDir = path.join(projectDir, '.claude', 'commands');
  ensureDir(commandsDir);
  const commandsTemplateDir = path.join(templatesDir, 'commands');
  if (fs.existsSync(commandsTemplateDir)) {
    const cmdFiles = fs.readdirSync(commandsTemplateDir).filter((f) => f.endsWith('.md'));
    for (const cmd of cmdFiles) {
      const target = path.join(commandsDir, cmd);
      const { status } = copyTemplateWith(templatesDir, `commands/${cmd}`, target, vars, false);
      record(status, target);
    }
  }

  // 7. <projectId>-lead.md (§5-③ AC-15)
  const agentsDir = path.join(projectDir, '.claude', 'agents');
  ensureDir(agentsDir);
  const leadTarget = path.join(agentsDir, `${projectId}-lead.md`);
  // preserve=true 이면 force 무시하고 기존 보존, preserve=false 이면 force에 따라 덮어쓰기 여부 결정
  const leadForce = force && !preserve;
  {
    const { status, src } = copyTemplateWith(templatesDir, 'agents/_lead.md', leadTarget, vars, leadForce);
    if (status === 'missing') {
      report.missingTemplates.push(src);
    } else {
      record(status, leadTarget);
    }
    report.leadPath = leadTarget;
  }

  // 8. eval/golden-tasks.json (Wave 1 C1 seed)
  const evalTarget = path.join(runtimeDir, 'eval', 'golden-tasks.json');
  {
    const src = path.join(templatesDir, 'eval', 'golden-tasks.json');
    if (!fs.existsSync(src)) {
      report.missingTemplates.push(src);
    } else if (fs.existsSync(evalTarget) && !force) {
      report.skipped.push(evalTarget);
    } else {
      ensureDir(path.dirname(evalTarget));
      fs.copyFileSync(src, evalTarget);
      report.created.push(evalTarget);
    }
  }

  return report;
}

/**
 * Ensure .claude/settings.local.json contains env.CLAUDE_RUNTIME_HOME
 * pointing to PACKAGE_ROOT.
 *
 * Behavior:
 *   - File missing → create with minimal { env: { CLAUDE_RUNTIME_HOME: ... } }
 *   - File exists, no env key → add env block (preserve other keys)
 *   - File exists, env present, CLAUDE_RUNTIME_HOME missing → add the key
 *   - File exists, CLAUDE_RUNTIME_HOME already set → no change (preserve user value)
 *   - JSON parse fails → write WARNING to stderr, skip (do not destroy user file)
 *
 * Returns one of: 'created' | 'added' | 'present' | 'parse-error'
 */
export function ensureSettingsLocalEnv(projectDir, runtimeHomePath) {
  const settingsPath = path.join(projectDir, '.claude', 'settings.local.json');
  const runtimeHomePosix = runtimeHomePath.replace(/\\/g, '/');

  // File missing → create minimal
  if (!fs.existsSync(settingsPath)) {
    ensureDir(path.dirname(settingsPath));
    const content = {
      env: { CLAUDE_RUNTIME_HOME: runtimeHomePosix }
    };
    fs.writeFileSync(settingsPath, JSON.stringify(content, null, 2) + '\n', 'utf8');
    return 'created';
  }

  // File exists → parse
  let parsed;
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`  [settings] WARN: ${settingsPath} parse failed (${err.message}). Skipping env injection — please add manually:\n`);
    process.stderr.write(`             "env": { "CLAUDE_RUNTIME_HOME": "${runtimeHomePosix}" }\n`);
    return 'parse-error';
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    process.stderr.write(`  [settings] WARN: ${settingsPath} root is not an object. Skipping env injection.\n`);
    return 'parse-error';
  }

  parsed.env = parsed.env || {};
  if (parsed.env.CLAUDE_RUNTIME_HOME) {
    return 'present'; // preserve user value
  }
  parsed.env.CLAUDE_RUNTIME_HOME = runtimeHomePosix;
  fs.writeFileSync(settingsPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  return 'added';
}

function copyTemplateWith(templatesDir, templateRel, targetPath, vars, force) {
  const src = path.join(templatesDir, templateRel);
  if (!fs.existsSync(src)) {
    return { status: 'missing', src };
  }
  const raw = fs.readFileSync(src, 'utf8');
  const content = substitute(raw, vars);
  if (fs.existsSync(targetPath) && !force) {
    return { status: 'skipped', src };
  }
  ensureDir(path.dirname(targetPath));
  fs.writeFileSync(targetPath, content, 'utf8');
  return { status: 'written', src };
}

/**
 * doctor --full --since-init 자동 호출 (§12-4).
 * @returns {{ invoked: boolean, status: number|null }}
 */
export function runDoctorAfterInit({ projectDir, packageRoot = PACKAGE_ROOT, skip = false }) {
  if (skip) return { invoked: false, status: null };
  const doctorPath = path.join(packageRoot, 'commands', 'doctor.mjs');
  if (!fs.existsSync(doctorPath)) {
    return { invoked: false, status: null };
  }
  const result = spawnSync(
    process.execPath,
    [doctorPath, '--full', '--since-init', '--project-dir', projectDir],
    { stdio: 'inherit' }
  );
  return { invoked: true, status: result.status };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(usage() + '\n');
    return;
  }

  if (!args.projectId || !args.vaultRoot) {
    process.stderr.write('error: --project-id and --vault-root are required.\n\n');
    process.stderr.write(usage() + '\n');
    process.exit(2);
  }

  const projectDir = path.resolve(args.projectDir || process.cwd());
  const vaultRoot = path.resolve(args.vaultRoot);

  process.stdout.write('claude-obsidian-runtime init\n');
  process.stdout.write(`  Project ID:   ${args.projectId}\n`);
  process.stdout.write(`  Project dir:  ${projectDir}\n`);
  process.stdout.write(`  Vault root:   ${vaultRoot}\n`);
  process.stdout.write('\n');

  let report;
  try {
    report = runInit({
      projectId: args.projectId,
      projectDir,
      vaultRoot,
      preserve: args.preserve,
      force: args.force
    });
  } catch (err) {
    process.stderr.write(`[init] ${err.message}\n`);
    process.exit(1);
  }

  process.stdout.write(`  [vault] ${DEFAULT_MANAGED_ROOTS_9.length} managed roots ready\n`);
  process.stdout.write(`  [runtime] ${RUNTIME_SUBDIRS.length} subdirs ready\n`);
  process.stdout.write(`  [lead] ${report.leadPath}\n`);
  process.stdout.write(`  [eval] ${path.join(projectDir, '.claude', 'runtime', 'eval', 'golden-tasks.json')}\n`);

  // install-hooks
  if (!args.skipHooks) {
    process.stdout.write('\n  [hooks] Running install-hooks...\n');
    try {
      const installArgv = ['install-hooks', '--project-dir', projectDir];
      if (args.preserve) installArgv.push('--preserve');
      process.argv = [process.argv[0], ...installArgv];
      await import(pathToFileURL(path.join(PACKAGE_ROOT, 'commands', 'install-hooks.mjs')).href);
    } catch (err) {
      process.stderr.write(`  [hooks] FAILED: ${err.message}\n`);
    }
  } else {
    process.stdout.write('  [hooks] Skipped (--skip-hooks)\n');
  }

  // Auto-inject CLAUDE_RUNTIME_HOME into .claude/settings.local.json so that
  // Claude Code sessions in this project always see the env regardless of shell.
  // Preserves any existing settings/env keys.
  try {
    const status = ensureSettingsLocalEnv(projectDir, PACKAGE_ROOT);
    const statusMsg = {
      'created': 'created with env.CLAUDE_RUNTIME_HOME',
      'added': 'env.CLAUDE_RUNTIME_HOME added (other keys preserved)',
      'present': 'env.CLAUDE_RUNTIME_HOME already set (preserved)',
      'parse-error': 'skipped (parse error — see WARN above)'
    }[status] || status;
    process.stdout.write(`  [settings] .claude/settings.local.json: ${statusMsg}\n`);
  } catch (err) {
    process.stderr.write(`  [settings] FAILED: ${err.message}\n`);
  }

  process.stdout.write('\n');
  process.stdout.write(`Initialized project: ${args.projectId}\n`);
  process.stdout.write(`  Created: ${report.created.length} file(s)\n`);
  process.stdout.write(`  Skipped (already exist): ${report.skipped.length} file(s)\n`);
  if (report.missingTemplates.length > 0) {
    process.stdout.write(`  Missing templates: ${report.missingTemplates.length}\n`);
  }

  // doctor
  if (!args.noDoctor) {
    process.stdout.write('\n  [doctor] Running doctor --full --since-init...\n');
    const { invoked, status } = runDoctorAfterInit({ projectDir, skip: false });
    if (invoked) {
      process.stdout.write(`  [doctor] exit code ${status}\n`);
      if (status && status !== 0) {
        process.exit(status);
      }
    } else {
      process.stdout.write('  [doctor] skipped (commands/doctor.mjs missing)\n');
    }
  } else {
    process.stdout.write('  [doctor] Skipped (--no-doctor)\n');
  }

  // Next steps — 4 phases (essential → recommended → optional → ongoing)
  process.stdout.write('\n');
  process.stdout.write('═══════════════════════════════════════════════════════════════════\n');
  process.stdout.write(' Next Steps — 4 Phases\n');
  process.stdout.write('═══════════════════════════════════════════════════════════════════\n');

  process.stdout.write('\n[Phase 1: Essential Setup] (자동 처리됨)\n');
  process.stdout.write(`  1. CLAUDE_RUNTIME_HOME 환경변수:\n`);
  process.stdout.write(`     ✅ .claude/settings.local.json 의 env 로 자동 주입됨\n`);
  process.stdout.write(`     → Claude Code 세션 시작 시 자동 로드 (셸 무관)\n`);
  process.stdout.write(`     → 외부 셸(bash/PowerShell)에서도 쓰려면 선택적으로:\n`);
  process.stdout.write(`        export CLAUDE_RUNTIME_HOME="${PACKAGE_ROOT.replace(/\\/g, '/')}"\n`);
  process.stdout.write(`\n`);
  process.stdout.write(`  2. (선택) 프로젝트 surface/scope 커스터마이징:\n`);
  process.stdout.write(`     .claude/runtime-manifest.json 편집 — surfacePatterns / scopeFolderMap\n`);
  process.stdout.write(`     (빈 값이어도 작동하지만, 채우면 lesson 분류 정확도 ↑)\n`);

  process.stdout.write('\n[Phase 2: Lead Bootstrap] (필수 — Claude 첫 세션에서)\n');
  process.stdout.write(`  3. Claude Code 세션 시작 (이 디렉토리에서):\n`);
  process.stdout.write(`     - lead 에이전트(${args.projectId}-lead)에게 PM 부트스트랩 요청\n`);
  process.stdout.write(`     - 예시 프롬프트: "${args.projectId}-lead 호출. PM 부트스트랩 시작해줘"\n`);
  process.stdout.write(`     - lead가 projectKinds 질문 → 응답 (web / cli / data / library / unknown, 복수 가능)\n`);
  process.stdout.write(`\n`);
  process.stdout.write(`  4. 권장 에이전트 일괄 설치:\n`);
  process.stdout.write(`     /agents-bootstrap\n`);
  process.stdout.write(`     - dry-run으로 설치 대상 표시 → yes 응답 → 설치\n`);
  process.stdout.write(`     - 각 kind별로 3~4개 에이전트 추가 (frontend-reviewer, api-designer 등)\n`);

  process.stdout.write('\n[Phase 3: Optional Activation] (선택 — 학습 누적 강화)\n');
  process.stdout.write(`  5. (선택) Code Index 빌드 — 코드 구조 인덱싱:\n`);
  process.stdout.write(`     node "${PACKAGE_ROOT.replace(/\\/g, '/')}/commands/memory-refresh.mjs" \\\n`);
  process.stdout.write(`          --project-dir "${projectDir.replace(/\\/g, '/')}"\n`);
  process.stdout.write(`     (코드 5개 이상일 때 의미 있음)\n`);
  process.stdout.write(`\n`);
  process.stdout.write(`  6. (선택) Governance 활성화 — 위임 감사 로그:\n`);
  process.stdout.write(`     .claude/runtime-manifest.json → "governance.enabled": true\n`);
  process.stdout.write(`     - lead → subagent 위임을 .claude/runtime/delegations-YYYY-MM.jsonl 에 기록\n`);
  process.stdout.write(`     - 비용 추적 + 무한루프 감지에 유용\n`);
  process.stdout.write(`\n`);
  process.stdout.write(`  7. (선택) Reflection 활성화 — 월간 메타 회고:\n`);
  process.stdout.write(`     .claude/runtime-manifest.json → "reflection.enabled": true\n`);
  process.stdout.write(`     - 월 1회 /reflection-run 실행 시 30일 패턴 자동 추출\n`);

  process.stdout.write('\n[Phase 4: Ongoing Workflow] (작업 시작 후)\n');
  process.stdout.write(`  8. 모든 작업은 /task-start ~ /task-close 사이클로 감싸기\n`);
  process.stdout.write(`     - lesson / decision / troubleshooting draft 자동 생성\n`);
  process.stdout.write(`     - 4-channel writeback 발동\n`);
  process.stdout.write(`\n`);
  process.stdout.write(`  9. 주기적 (월 1회 권장):\n`);
  process.stdout.write(`     - /reflection-run  : 메타 회고 생성\n`);
  process.stdout.write(`     - /architecture-promote : draft → 정식 문서 승격\n`);
  process.stdout.write(`     - claude-obsidian-runtime doctor : 헬스 체크\n`);

  process.stdout.write('\n───────────────────────────────────────────────────────────────────\n');
  process.stdout.write(' 빠른 시작 (최소 절차):\n');
  process.stdout.write('   Phase 1.1 (env) → Phase 2.3 (lead) → Phase 2.4 (agents-bootstrap)\n');
  process.stdout.write(' 위 3단계만 완료해도 v3.3.0 핵심 기능 작동 시작.\n');
  process.stdout.write('───────────────────────────────────────────────────────────────────\n');
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (__filename === invokedPath) {
  main().catch((err) => {
    process.stderr.write(`[init] Error: ${err.message}\n`);
    process.exit(1);
  });
}

export { main as initProject };
