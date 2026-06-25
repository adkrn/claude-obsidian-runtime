#!/usr/bin/env node

/**
 * list-artifacts — 기존 산출물 목록을 조회하는 얇은 CLI (D-25).
 *
 * 세션 Claude 가 task-close 흐름에서 create/update/skip 을 판단할 때,
 * "기존에 같은 주제 문서가 있나"를 확인하기 위해 사용한다.
 *
 * 사용:
 *   node commands/list-artifacts.mjs --kind decision [--project-dir <dir>]
 *
 * 출력(stdout, JSON 한 줄): { ok, kind, count, items: [{id,title,summary,scope,sourceDoc,updatedAt}] }
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { listSessionArtifacts } from '../core/learning-curate.mjs';

const VALID_KINDS = new Set(['decision', 'lesson', 'troubleshooting', 'architecture']);

function parseArgs(argv) {
  const args = { projectDir: '', kind: 'decision' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--project-dir') { args.projectDir = argv[i + 1] || ''; i += 1; }
    else if (argv[i] === '--kind') { args.kind = argv[i + 1] || 'decision'; i += 1; }
  }
  return args;
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const projectDir = path.resolve(args.projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd());

  if (!VALID_KINDS.has(args.kind)) {
    emit({ ok: false, reason: 'invalid_kind', detail: `kind 는 ${[...VALID_KINDS].join('|')} 중 하나여야 합니다.` });
    process.exitCode = 1;
    return;
  }

  const items = listSessionArtifacts(projectDir, args.kind);
  emit({ ok: true, kind: args.kind, count: items.length, items });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (err) {
    emit({ ok: false, reason: 'unexpected_error', detail: String(err?.message || err) });
    process.exitCode = 1;
  }
}
