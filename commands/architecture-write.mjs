#!/usr/bin/env node

/**
 * architecture-write — 세션 Claude 가 직접 작성한 architecture 문서를 저장하는 얇은 CLI (D-26).
 *
 * 기존 detectArchitectureChanges(surfacePatterns) 자동감지는 surfacePatterns 가 비면
 * 0개를 만든다. 작업을 수행한 세션 Claude 가 "이 작업이 구조를 어떻게 바꿨나"를 본문
 * 마크다운으로 직접 써서 stdin 으로 넘기면, frontmatter 문서(Obsidian, status: active) +
 * jsonl 인덱스에 저장한다. 전체 재작성(부분교체 마커 불필요).
 * create/update/skip 판단은 세션이 직접 함(D-25 미러링):
 *   - 기존에 같은 주제 architecture 가 없으면 mode=create
 *   - 있고 보완이 필요하면 기존 문서를 읽고 통째로 다시 써 mode=update (architecture.id 로 교체)
 *   - 충분하면 아예 이 CLI 를 호출하지 않음(skip)
 *
 * 입력(stdin, JSON):
 *   {
 *     "taskId": "<생략 시 current-task pointer>",
 *     "mode": "create" | "update",
 *     "architecture": {
 *       "summary": "이 구조 문서의 한 줄 개요 (필수)",
 *       "body": "본문 마크다운 (## 컴포넌트, ## 데이터 흐름 등 자유 구성)",
 *       "title": "문서 제목 (생략 시 task title)",
 *       "relatedFiles": [],
 *       "scope": "",
 *       "id": "<update 시 기존 architecture id>"
 *     }
 *   }
 *
 * 사용:
 *   echo '<json>' | node commands/architecture-write.mjs [--project-dir <dir>]
 *
 * 출력(stdout, JSON 한 줄): { ok, action, taskId, artifact } 또는 { ok:false, reason }
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadObsidianConfig } from '../core/obsidian-config.mjs';
import { writeSessionArchitecture } from '../core/learning-curate.mjs';
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
    emit({ ok: false, reason: 'empty_input', detail: 'stdin 으로 architecture JSON 을 넘겨주세요.' });
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

  const result = writeSessionArchitecture(projectDir, {
    taskId,
    mode: payload.mode === 'update' ? 'update' : 'create',
    architecture: payload.architecture,
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
