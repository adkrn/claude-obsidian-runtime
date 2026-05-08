# 새 runtime memory 흐름으로 작업을 시작합니다.

다음 순서로 진행하세요.

1. `node "$CLAUDE_RUNTIME_HOME/commands/task-start.mjs" --task "$ARGUMENTS" --session-id "${CLAUDE_SESSION_ID}"` 를 실행합니다.
2. 출력된 `taskId`, `readFirst`, `knowledgeHits`, `codeHits`, `guardrails`를 확인합니다.
3. `readFirst`와 `knowledgeHits`에 나온 노트를 먼저 읽고, `codeHits` 상위 경로를 읽어 변경 표면을 줄입니다.
4. multi-file 작업이거나 설계 판단이 필요한 경우, `taskId`를 기준으로 짧은 plan을 먼저 작성합니다.
5. 작업 중에는 새 public surface(route/page/store/service/hook)가 생기면 후속 architecture sync 후보로 취급합니다.

규칙:

- 계획 전에 `readFirst` 문서를 건너뛰지 않습니다.
- 코드 탐색은 `codeHits` 상위 경로부터 시작합니다.
- 바로 수정하지 말고, 최소 diff와 검증 방법을 먼저 정리합니다.
- task 단위 usage 추적을 위해 `--session-id`를 빠뜨리지 않습니다.
- 이 흐름이 현재 기본 runtime-first 시작점입니다.
