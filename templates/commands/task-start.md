# 새 runtime memory 흐름으로 작업을 시작합니다.

다음 순서로 진행하세요.

1. 다음 명령을 실행합니다. **쉘에 맞는 변수 문법을 사용하세요** — 섞이면 경로가 깨집니다.
   - Bash 툴: `node "$CLAUDE_RUNTIME_HOME/commands/task-start.mjs" --task "$ARGUMENTS" --session-id "${CLAUDE_SESSION_ID}"`
   - PowerShell 툴: `node "$env:CLAUDE_RUNTIME_HOME/commands/task-start.mjs" --task "$ARGUMENTS" --session-id "$env:CLAUDE_SESSION_ID"`
   - 환경변수가 비어 있으면 절대경로로 폴백: `node "C:/JSProj/claude-obsidian-runtime/commands/task-start.mjs" ...`
2. 출력된 `taskId`, `readFirst`, `knowledgeHits`, `codeHits`, `guardrails`를 확인합니다.
   - **`taskId`를 반드시 기억하세요.** `/task-close` 때 `--task-id`로 넘겨야 이 세션의 task를 정확히 닫습니다(멀티세션 안전). 예: `20260625-1739-task-47c12f97`. session-id가 비어도 taskId로 닫으면 되므로, 이 값이 세션을 구분하는 신뢰 키입니다.
3. `readFirst`와 `knowledgeHits`에 나온 노트를 먼저 읽고, `codeHits` 상위 경로를 읽어 변경 표면을 줄입니다.
4. multi-file 작업이거나 설계 판단이 필요한 경우, `taskId`를 기준으로 짧은 plan을 먼저 작성합니다.
5. 작업 중에는 새 public surface(route/page/store/service/hook)가 생기면 후속 architecture sync 후보로 취급합니다.

규칙:

- 계획 전에 `readFirst` 문서를 건너뛰지 않습니다.
- 코드 탐색은 `codeHits` 상위 경로부터 시작합니다.
- 바로 수정하지 말고, 최소 diff와 검증 방법을 먼저 정리합니다.
- task 단위 usage 추적을 위해 `--session-id`를 넘기되, 비어 있어도 괜찮습니다 — 종료는 `--task-id`로 하므로 session-id 누락이 치명적이지 않습니다(taskId가 세션 구분의 1차 키).
- 이 흐름이 현재 기본 runtime-first 시작점입니다.
