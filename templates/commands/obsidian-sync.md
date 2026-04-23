# Obsidian 원본 볼트를 프로젝트 컨텍스트로 동기화합니다.

다음을 실행하세요.

```bash
node "$CLAUDE_RUNTIME_HOME/commands/obsidian-sync.mjs"
```

또는 CLI:

```bash
npx claude-obsidian-runtime sync
```

규칙:

- 원본 볼트 수정은 Obsidian 앱에서만 합니다.
- 프로젝트 `document/obsidian_context/`는 자동 갱신되는 미러본입니다. 직접 수정하지 마세요.
- sync 결과에서 `copied`/`removed` 카운트가 예상과 다르면 `mirrorExcludeRoots`를 확인하세요.
