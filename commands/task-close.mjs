#!/usr/bin/env node

/**
 * task-close — `session-end.mjs --close` 의 정식 별칭.
 *
 * /task-close 명령 이름에서 세션 Claude 가 task-close.mjs 를 유추해 호출하는
 * 사례가 실측 4회(CardGame) — 파일이 없어 Cannot find module 로 실패하고
 * 재시도 비용을 만들었다. 유추 호출이 그대로 동작하도록 얇은 진입점을 둔다.
 *
 * 인자는 session-end 와 동일하며 --close 는 자동으로 붙는다:
 *   node commands/task-close.mjs --task-id "<taskId>" [--session-id <id>] [--no-verify]
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { main } from './session-end.mjs';

const currentFilePath = fileURLToPath(import.meta.url);
const invokedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (currentFilePath === invokedFilePath) {
  const argv = process.argv.slice(2);
  if (!argv.includes('--close')) argv.push('--close');
  main(argv).catch((err) => {
    process.stderr.write(`[task-close] ${err.message}\n`);
    process.exit(1);
  });
}
