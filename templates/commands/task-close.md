# 현재 runtime task를 정제하고 종료합니다.

다음 순서로 진행하세요.

1. `node "$CLAUDE_RUNTIME_HOME/commands/session-end.mjs" --close --session-id "$SESSION_ID"` 를 실행합니다.
2. 출력된 worklog, 생성된 lesson/decision/troubleshooting 초안, architecture generated 문서 요약을 확인합니다.
3. `recommendation: promote`가 보이면 `/architecture-promote`로 정식 문서 승격을 검토합니다.

규칙:

- 현재 task의 검증 기록이 부족하면 먼저 검증 명령을 실행하고 나서 close 합니다.
- 실패가 있었다면 troubleshooting draft가 생성되었는지 확인합니다.
- close 후 새 작업은 `/task-start`로 시작합니다.
