#!/usr/bin/env node

/**
 * learn-write — 세션 Claude 가 직접 작성한 lesson 을 저장하는 얇은 CLI (D-23).
 *
 * 작업을 수행한 세션 Claude 가 "무엇을 왜 배웠는가"를 gold 포맷 JSON 으로 써서
 * stdin 으로 넘기면, frontmatter 문서(Obsidian) + jsonl 인덱스(runtime)로 저장한다.
 * 휴리스틱/별도 API 호출 없음 — 맥락이 살아있는 세션 Claude 가 본문을 만든다.
 *
 * create/update/skip 판단은 세션 Claude 가 직접 함(D-25 미러링): 같은 주제 lesson 이
 * 없으면 mode=create, 있고 보완이면 기존 id 로 mode=update(같은 문서 교체), 충분하면
 * 아예 호출하지 않음(skip). list-artifacts.mjs --kind lesson 으로 기존 목록 확인.
 *
 * 입력(stdin, JSON):
 *   {
 *     "taskId": "<task id>",            // 생략 시 current-task pointer 사용
 *     "mode": "create" | "update",      // 생략 시 create
 *     "lesson": {
 *       "summary": "한 줄: 무엇을 왜 배웠나 (필수)",
 *       "rules": ["when X, do Y because Z", ...],
 *       "applicable_when": { "language":[], "kind":[], "task_type":[], "scope_id":"" },
 *       "trigger_keywords": [],
 *       "relatedFiles": [],
 *       "importance": 1..10,
 *       "confidence": "high"|"medium"|"low",
 *       "id": "<update 시 기존 lesson id>"
 *     }
 *   }
 *
 * 사용:
 *   echo '<json>' | node commands/learn-write.mjs [--project-dir <dir>]
 *
 * 출력(stdout, JSON 한 줄): { ok, taskId, artifact } 또는 { ok:false, reason }
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadObsidianConfig } from '../core/obsidian-config.mjs';
import { writeSessionLesson } from '../core/learning-curate.mjs';
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
    emit({ ok: false, reason: 'empty_input', detail: 'stdin 으로 lesson JSON 을 넘겨주세요.' });
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

  const result = writeSessionLesson(projectDir, {
    taskId,
    mode: payload.mode === 'update' ? 'update' : 'create',
    lesson: payload.lesson,
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
