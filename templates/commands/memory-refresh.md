# runtime memory 인덱스를 갱신합니다.

다음을 실행하세요.

```bash
node "$CLAUDE_RUNTIME_HOME/commands/memory-refresh.mjs"
```

이 명령은 code-index와 knowledge-index를 재구축합니다.

다음 상황에 사용합니다.

- Claude가 관련 코드를 못 찾을 때
- 새 lesson/decision/troubleshooting이 반영되지 않을 때
- Obsidian mirror가 갱신되지 않을 때
