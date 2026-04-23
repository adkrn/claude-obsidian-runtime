# {{PROJECT_ID}} 프로젝트에 유형별 권장 에이전트를 설치합니다.

입력:

- `--kind <web|cli>` 플래그 (선택). 미지정 시 `runtime-manifest.json`의 `projectKinds`를 사용합니다.
- 대화형 모드: 플래그·manifest 모두 비어있으면 "`projectKinds`를 먼저 설정해 주세요" 안내 후 `/task-start` 이전에 lead의 Project Manager 섹션 응답이 필요함을 알립니다.

다음 순서로 진행하세요. 각 단계의 에러 처리는 명시된 분기에 따릅니다.

1. **사전 조건 확인**
   - `.claude/runtime-manifest.json`을 Read 합니다.
   - `projectKinds` 필드가 배열이고 `length >= 1`인지 확인합니다.
   - 조건 불충족 시: "현재 projectKinds가 설정되지 않았어요. lead 세션에서 Project Manager 안내에 먼저 응답하거나, `--kind web` 같은 플래그로 실행해 주세요." 메시지를 출력하고 **중단**합니다.
   - `--kind` 플래그가 주어지고 manifest `projectKinds`와 **불일치**하면: "플래그 `<kind>`가 manifest의 `<projectKinds>`와 다릅니다. 어느 쪽으로 진행할까요?" 로 **사용자에게 질문**합니다. 기본 선택지: `(a) 플래그 우선` `(b) manifest 우선` `(c) 취소`. 응답 없이 자동 진행 금지.

2. **설치 대상 kind 확정**
   - 위 1단계 결과로 하나 이상의 kind가 확정됩니다 (hybrid 지원 — 복수 kind 허용).
   - 각 kind에 대해 `$CLAUDE_RUNTIME_HOME/templates/agents/_recommended/<kind>/` 디렉토리를 Glob 으로 조회합니다 (`*.md`).
   - 디렉토리 부재·빈 디렉토리일 경우: "kind `<kind>`에는 아직 권장 템플릿이 없어요 (P2 예정일 수 있음)." 를 출력하고 다음 kind 로 넘어갑니다.
   - 각 kind 디렉토리 결과에 `_recommended/_common/test-writer.md`가 존재하면 합집합에 포함합니다 (unknown kind는 제외).

3. **중복 체크 및 합집합 계산**
   - 복수 kind의 템플릿 집합을 **파일명 기준 합집합** (같은 `test-writer.md`는 1번만).
   - 각 템플릿에 대해 목표 경로 `.claude/agents/{{PROJECT_ID}}-<role>.md`가 **이미 존재**하는지 확인합니다.
   - 존재 시: `--force` 플래그(아래 6단계에서 다룸) 부재면 **skip 후보**로 분류, 존재면 **덮어쓰기 후보**로 분류.

4. **Dry-run 요약 출력**
   - 다음 포맷으로 사용자에게 출력합니다:
     ```
     다음 에이전트를 설치합니다:
       [install] .claude/agents/{{PROJECT_ID}}-frontend-reviewer.md  (from _recommended/web/)
       [install] .claude/agents/{{PROJECT_ID}}-api-designer.md       (from _recommended/web/)
       [install] .claude/agents/{{PROJECT_ID}}-test-writer.md        (from _recommended/web/)

     다음 파일은 이미 존재하여 skip됩니다:
       [skip]    .claude/agents/{{PROJECT_ID}}-docs-writer.md

     계속 진행할까요? (yes / no)
     ```

5. **사용자 승인 대기**
   - 사용자가 `yes` 또는 명시적 긍정 응답을 할 때까지 **쓰기 작업 금지**.
   - `no` 또는 거부 시: "설치를 취소했어요. 언제든 다시 `/agents-bootstrap`으로 실행할 수 있어요." 출력 후 **종료**.

6. **설치 실행**
   - 각 install 후보에 대해:
     1. 템플릿 파일(`$CLAUDE_RUNTIME_HOME/templates/agents/_recommended/<kind>/<role>.md`)을 Read 합니다.
     2. 내용에서 `{{PROJECT_ID}}` 문자열을 전부 실제 `projectTag` 값(manifest에서 읽음)으로 치환합니다. 그 외 placeholder는 치환하지 않습니다.
     3. 목표 경로 `.claude/agents/{{PROJECT_ID}}-<role>.md`에 Write 합니다.
   - 쓰기 실패(권한·디스크 공간 등) 발생 시: 현재까지 성공한 파일 목록을 출력하고 나머지는 skip. **부분 설치 상태**가 유지됩니다 (재실행 시 skip 처리되어 안전).

7. **결과 요약**
   - 다음 포맷:
     ```
     [done]
       installed: 3 file(s)
       skipped:   1 file(s)
       failed:    0 file(s)

     다음 단계:
       - 설치된 에이전트를 확인하려면 ls .claude/agents/
       - lead가 다음 프롬프트부터 이 에이전트들에게 자동 위임합니다.
     ```

규칙:

- **자동 설치 금지**: 4·5단계 없이 바로 Write 하는 경로는 존재하지 않습니다.
- **shared 주권**: `$CLAUDE_RUNTIME_HOME` 아래 파일을 Write 하지 않습니다. 항상 읽기만.
- **`core/*` 호출 금지**: 본 커맨드는 `core/`의 어떤 `.mjs` 파일도 import 하지 않습니다. 모든 로직은 Claude 본인이 Read/Write/Glob 도구로 수행합니다.
- **`commands/init-project.mjs` 호출 금지**: init 플로우와 완전히 분리됩니다.
- **치환 범위**: `{{PROJECT_ID}}`만 치환합니다. 다른 placeholder 는 추가하지 않습니다.
- **재실행 안전**: 같은 kind 로 여러 번 실행해도 안전합니다 (기본 skip). `--force` 가 필요하면 사용자가 명시적으로 요청해야 합니다 (본 P1 기본 동작은 skip).

호환성:

- `projectKinds`가 `["unknown"]` 인 프로젝트: "unknown 유형에는 권장 템플릿이 없어요. 유형을 구체화하고 싶으면 `.claude/runtime-manifest.json`의 `projectKinds`를 편집해 주세요."
- 기존 P0 프로젝트 (lead만 있음): 그대로 실행 가능. lead는 건드리지 않습니다.
- `--kind library` 또는 `--kind data` (P1 범위 밖): "kind `<kind>` 는 P2에서 제공돼요." 안내 후 종료.
