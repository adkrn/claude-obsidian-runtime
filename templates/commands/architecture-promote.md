# 가장 최근 generated architecture 문서를 정식 아키텍처 문서로 승격합니다.

다음을 실행하세요.

```bash
node "$CLAUDE_RUNTIME_HOME/commands/architecture-promote.mjs"
```

기본 동작:

- 가장 최근 task의 `recommendation: promote` 후보만 정식 문서로 올림
- 기존 정식 문서가 있으면 `Auto Generated Surface Map` 섹션만 갱신
- generated 문서는 그대로 보존

사용 시점:

- `/task-close` 후 `recommendation: promote` 메시지가 보일 때
- 새 public surface(route/store/service/hook)가 정식 아키텍처에 반영되어야 할 때
