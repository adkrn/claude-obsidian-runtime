#!/usr/bin/env node

/**
 * decision-write — 세션 Claude 가 직접 판단·작성한 decision 을 저장하는 얇은 CLI (D-25).
 *
 * 작업을 수행한 세션 Claude 가 "무엇을 왜 결정했나"를 직접 써서 stdin 으로 넘기면,
 * frontmatter 문서(Obsidian, status: active) + jsonl 인덱스에 저장한다.
 * create/update/skip 판단은 세션이 직접 함(코드의 토큰겹침 추측 폐기):
 *   - 기존에 같은 주제 decision 이 없으면 mode=create
 *   - 있고 보완이 필요하면 기존 문서를 읽고 통합해 mode=update (decision.id 로 같은 문서 교체)
 *   - 충분하면 아예 이 CLI 를 호출하지 않음(skip)
 *
 * 입력(stdin, JSON):
 *   {
 *     "taskId": "<생략 시 current-task pointer>",
 *     "mode": "create" | "update",
 *     "decision": {
 *       "statement": "무엇을 결정했나 (한 문장, 필수)",
 *       "why": ["왜 이 결정인가 / 어떤 대안을 왜 안 골랐나", "..."],
 *       "relatedFiles": [],
 *       "scope": "",
 *       "trigger_keywords": ["검색용 키워드", "..."],
 *       "applicable_when": { "language": [], "kind": ["decision"], "task_type": [], "scope_id": "" },
 *       "id": "<update 시 기존 decision id>"
 *     }
 *   }
 *
 * 사용:
 *   echo '<json>' | node commands/decision-write.mjs [--project-dir <dir>]
 *
 * 출력(stdout, JSON 한 줄): { ok, action, taskId, artifact } 또는 { ok:false, reason }
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadObsidianConfig } from '../core/obsidian-config.mjs';
import { writeSessionDecision } from '../core/learning-curate.mjs';
import { writeVaultArtifact } from '../core/utils.mjs';
import { loadCurrentTaskPointer } from '../core/runtime-lib.mjs';

function parseArgs(argv) {
  const args = { projectDir: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--project-dir') { args.projectDir = argv[i + 1] || ''; i += 1; }
  }
  return args;
}

function loadManifest(projectDir) {
  const p = path.join(projectDir, '.claude', 'runtime-manifest.json');
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const projectDir = path.resolve(args.projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd());

  const raw = await readStdin();
  if (!raw) {
    emit({ ok: false, reason: 'empty_input', detail: 'stdin 으로 decision JSON 을 넘겨주세요.' });
    process.exitCode = 1;
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    emit({ ok: false, reason: 'invalid_json', detail: String(err?.message || err) });
    process.exitCode = 1;
    return;
  }

  let taskId = payload.taskId;
  if (!taskId) {
    const pointer = loadCurrentTaskPointer(projectDir);
    taskId = pointer?.taskId || '';
  }
  if (!taskId) {
    emit({ ok: false, reason: 'no_task', detail: 'taskId 미지정이고 current-task pointer 도 없습니다.' });
    process.exitCode = 1;
    return;
  }

  const manifest = loadManifest(projectDir);
  const obsidianConfig = loadObsidianConfig(projectDir);

  const result = writeSessionDecision(projectDir, {
    taskId,
    mode: payload.mode === 'update' ? 'update' : 'create',
    decision: payload.decision,
    publish: payload.publish !== false
  }, {
    loadObsidianConfig: () => obsidianConfig,
    writeVaultArtifact: (params) => writeVaultArtifact({
      projectDir,
      vaultRoot: obsidianConfig.vaultRoot || '',
      relativePath: params.relativePath,
      content: params.content,
      queueRoot: 'document/obsidian_writeback_queue'
    }),
    projectTag: manifest.projectTag || 'project',
    scopeFolderMap: manifest.scopeFolderMap || {}
  });

  emit(result);
  if (!result.ok) process.exitCode = 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    emit({ ok: false, reason: 'unexpected_error', detail: String(err?.message || err) });
    process.exitCode = 1;
  });
}
