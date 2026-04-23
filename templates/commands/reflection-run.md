# {{PROJECT_ID}} 프로젝트에서 Reflection 에이전트를 실행합니다.

입력:

- `--window-days <n>` (선택). 미지정 시 `runtime-manifest.json.reflection.windowDays` (기본 30).
- `--max-input-files <n>` (선택). 미지정 시 `runtime-manifest.json.reflection.maxInputFiles` (기본 100).
- `--dry-run` (선택). 입력 범위와 읽을 파일 목록만 출력, 쓰기 안 함.

다음 순서로 진행하세요.

1. **사전 조건 확인**
   - `.claude/runtime-manifest.json` 을 Read 합니다.
   - `reflection` 블록 존재를 확인합니다 (부재 시 기본값 fallback).
   - `.claude/agents/{{PROJECT_ID}}-reflection-agent.md` 파일 존재 확인.
   - 부재 시: "Reflection 에이전트가 설치되지 않았어요. 먼저 `/agents-bootstrap` 을 실행해 주세요." 안내 후 중단.

2. **입력 수집 범위 확정**
   - `windowDays` 와 `maxInputFiles` 로 범위 결정.
   - `inputScopes` 배열에 따라 아래 소스를 순회:
     - `"lessons"` → `<vaultRoot>/08_Lessons/**/Drafts/*.md`
     - `"decisions"` → `<vaultRoot>/07_Decisions/Drafts/*.md`
     - `"troubleshooting"` → `<vaultRoot>/06_Troubleshooting/*/Drafts/*.md`
     - `"delegations"` → `.claude/runtime/delegations-*.jsonl` (윈도우 내 월 파일)

3. **Reflection 에이전트 위임**
   - `Agent` tool 로 `{{PROJECT_ID}}-reflection-agent` 호출.
   - 프롬프트: "지난 `{windowDays}` 일의 lessons/decisions/troubleshooting/delegations 를 메타 회고하고 `08_Reflections/Drafts/YYYY-MM_monthly.md` 에 기록해 주세요. 파일 수 상한은 `{maxInputFiles}` 개입니다."

4. **결과 확인**
   - Reflection 에이전트가 반환한 경로(`08_Reflections/Drafts/YYYY-MM_monthly.md`) 를 사용자에게 안내.
   - 사용자가 `--dry-run` 플래그를 줬으면 이 step 대신 입력 파일 목록만 출력.

규칙:

- **승격 금지**: Reflection 은 draft 만 생성. 정식 승격은 `/architecture-promote`.
- **shared 주권**: `$CLAUDE_RUNTIME_HOME` 아래 파일 Write 금지.
- **core/* 호출 금지**: 본 커맨드는 `core/` 어떤 `.mjs` 도 import 하지 않음.
- **중복 실행 방지**: 같은 월 파일이 이미 존재하면 사용자에게 "덮어쓰기 / 병합 / 취소" 3 선택지 제시.
- **실패 허용**: delegations.jsonl 부재 등 일부 입력 누락 시 "해당 섹션 생략" 으로 계속.
