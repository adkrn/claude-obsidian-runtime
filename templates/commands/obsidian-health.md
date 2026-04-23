# Obsidian-Claude 연동 상태를 점검합니다.

다음을 실행하세요.

```bash
npx claude-obsidian-runtime doctor --full
```

또는:

```bash
node "$CLAUDE_RUNTIME_HOME/bin/cli.mjs" doctor --full
```

점검 항목:

- `CLAUDE_RUNTIME_HOME` 환경변수 설정
- `runtime-manifest.json`, `settings.json`, hook shell wrapper, `obsidian_paths.json`
- 패키지 버전 vs 설치된 버전
- runtime state 디렉토리, code-index jsonl 파일

`warn` 이상이 나오면 제시된 remedy를 따라 조치합니다.
