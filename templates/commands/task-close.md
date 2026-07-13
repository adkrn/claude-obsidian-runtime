# 현재 runtime task를 정제하고 종료합니다.

다음 순서로 진행하세요.

> **taskId 먼저 확보**: 아래 모든 단계(산출물 저장 + 종료)는 `/task-start` 때 받은 `taskId`를 기준으로 동작합니다. 그 taskId를 각 CLI에 `"taskId":"<값>"`(JSON) 또는 `--task-id "<값>"`(종료)로 명시하면, session-id가 비어 있거나 여러 세션이 열려 있어도 **이 세션의 task만** 정확히 다룹니다. taskId를 모르면 current-task 포인터로 폴백하나 멀티세션에선 부정확할 수 있습니다.

## 0. 기존 산출물 목록을 한 번에 조회

아래 1~1.7단계의 create/update/skip 판단에 쓸 기존 산출물 목록을 **한 번만** 조회합니다. kind별로 4번 따로 호출하지 마세요 — 같은 정보를 세션 최심부 컨텍스트에 4번 싣는 낭비입니다.

```bash
node "$CLAUDE_RUNTIME_HOME/commands/list-artifacts.mjs" --kind all
```

각 항목에 `kind` 필드(lesson|decision|troubleshooting|architecture)가 붙어 있습니다. 아래 단계들은 이 출력에서 해당 kind 항목만 골라 판단하고, list-artifacts를 다시 호출하지 않습니다.

## 1. lesson을 직접 작성해 저장 (D-23 — 가장 중요)

당신(이 세션의 Claude)이 방금 이 작업을 직접 수행했습니다. "무엇을 왜 배웠는가"는 당신이 가장 잘 압니다. 별도 LLM/API를 부르지 말고, **당신이 직접** 재사용 가능한 lesson을 작성해 `learn-write`로 저장하세요.

작성 기준 (gold 포맷 — 보일러플레이트 금지):
- **summary**: 한 문장. "무엇을 배웠고 왜 중요한가" (작업이 *무엇이었는지*가 아님). 예: "additive 멀티씬에서 SceneManager.GetActiveScene()로 씬 판정 시 NullReference — active scene이 항상 부트스트랩이라 신뢰 불가".
- **rules**: 1~5개의 구체적 재사용 규칙 ("X일 때 Y하라, 왜냐하면 Z"). "readFirst 정독" 같은 일반론 금지.
- **relatedFiles**: 실제 task에서 다룬 파일 경로만.
- 증상·근본 원인·코드 예시가 있으면 summary/rules에 녹입니다.

이번 작업에서 **재사용할 만한 교훈이 없으면 이 단계를 건너뜁니다** (쓰레기 lesson을 만들지 않습니다 — 이게 핵심).

교훈이 있으면, 0단계 출력의 `kind: lesson` 항목을 보고 create/update/skip을 **당신이 직접 판단**합니다:

- **같은 주제 없음 → create** (mode 생략 시 create):
  ```bash
  echo '{
    "mode": "create",
    "lesson": {
      "summary": "<한 문장>",
      "rules": ["<구체적 규칙1>", "..."],
      "applicable_when": { "language": [], "kind": [], "task_type": [], "scope_id": "" },
      "trigger_keywords": [],
      "relatedFiles": [],
      "importance": 7,
      "confidence": "high"
    }
  }' | node "$CLAUDE_RUNTIME_HOME/commands/learn-write.mjs"
  ```
- **같은 주제 있고 이미 충분 → skip**: 아무것도 하지 않음(중복 lesson 방지 — 이게 핵심).
- **같은 주제 있고 보완 필요 → update**: 기존 문서를 읽고 통합한 **전체본**을 작성해 같은 id로 교체.
  ```bash
  echo '{"mode":"update","lesson":{"id":"<기존 lesson id>","summary":"...","rules":["..."],"applicable_when":{},"relatedFiles":[]}}' | node "$CLAUDE_RUNTIME_HOME/commands/learn-write.mjs"
  ```

(`taskId`를 생략하면 current-task pointer를 사용합니다. 세션이 쓴 lesson은 바로 active(검색 대상) — 사람 승격 단계 없음. 출력 `{ ok, action, artifact }`로 저장 경로를 확인하세요.)

## 1.5. decision을 직접 판단·작성 (D-25 — create/update/skip)

당신이 이번 작업에서 **아키텍처/기술/방향 결정**을 내렸나? (예: "X 대신 Y를 쓰기로", "이 모듈은 Z 패턴으로", "A 접근법을 B 이유로 폐기") **결정이 없으면 이 단계를 건너뜁니다.**

결정이 있으면, 0단계 출력의 `kind: decision` 항목(id/title/summary)을 보고 create/update/skip 을 **당신이 직접 판단**합니다:
- **같은 주제 없음 → create**: 새로 작성.
  ```bash
  echo '{"mode":"create","decision":{"statement":"<무엇을 결정했나, 한 문장>","why":["<왜 이 결정 / 어떤 대안을 왜 안 골랐나>"],"relatedFiles":[],"scope":"","trigger_keywords":[],"applicable_when":{"language":[],"kind":["decision"],"task_type":[],"scope_id":""}}}' | node "$CLAUDE_RUNTIME_HOME/commands/decision-write.mjs"
  ```
- **같은 주제 있고 이미 충분 → skip**: 아무것도 하지 않음(중복 방지).
- **같은 주제 있고 보완 필요 → update**: 기존 문서(목록의 sourceDoc)를 읽고, 새 내용을 통합한 **전체본**을 작성해 같은 id로 교체.
  ```bash
  echo '{"mode":"update","decision":{"id":"<기존 decision id>","statement":"...","why":["..."],"relatedFiles":[],"scope":"","trigger_keywords":[],"applicable_when":{}}}' | node "$CLAUDE_RUNTIME_HOME/commands/decision-write.mjs"
  ```

작성 기준: statement="무엇을 결정했나"(한 문장), why="왜 이 결정인가 / 어떤 대안을 왜 안 골랐나"(1~3개, 가장 중요). **`trigger_keywords`를 꼭 채워라** — 이 결정을 다음에 어떤 단어로 검색할지(고유명사·모듈명·기술명·핵심 개념 5~10개). 비우면 검색 게이트·랭킹에 전혀 기여하지 못한다(lesson과 동일 신호). 보일러플레이트 금지. 세션이 쓴 decision 은 바로 active(검색 대상) — 사람 승격 단계 없음.

## 1.6. troubleshooting을 직접 작성 (D-26 — create/update/skip)

이번 작업에서 **버그/장애를 진단·수정**했나? (증상→원인→수정까지 도달한 문제) **그런 문제가 없으면 이 단계를 건너뜁니다.** (자동 troubleshooting은 더 이상 만들지 않습니다 — 세션이 원인/수정/재발방지까지 직접 채웁니다.)

문제가 있으면, 0단계 출력의 `kind: troubleshooting` 항목을 보고 create/update/skip을 **당신이 직접 판단**합니다:

- **같은 문제 없음 → create**:
  ```bash
  echo '{"mode":"create","troubleshooting":{"symptom":"<무슨 증상>","cause":"<실제 원인>","fix":"<수정 방법>","prevention":"<재발 방지 규칙>","verification":"<어떻게 검증했나>","relatedFiles":[],"scope":"","trigger_keywords":[],"applicable_when":{"language":[],"kind":["troubleshooting"],"task_type":[],"scope_id":""}}}' | node "$CLAUDE_RUNTIME_HOME/commands/troubleshoot-write.mjs"
  ```
- **같은 문제 있고 이미 충분 → skip**.
- **같은 문제 있고 보완 필요 → update**: 기존 문서(목록의 sourceDoc)를 읽고 통합한 전체본을 같은 id로 교체.
  ```bash
  echo '{"mode":"update","troubleshooting":{"id":"<기존 id>","symptom":"...","cause":"...","fix":"...","relatedFiles":[],"trigger_keywords":[],"applicable_when":{}}}' | node "$CLAUDE_RUNTIME_HOME/commands/troubleshoot-write.mjs"
  ```

작성 기준: symptom(필수)은 증상, cause/fix/prevention/verification은 당신이 직접 채움(CURATOR_TODO 마커 없음). **`trigger_keywords`를 꼭 채워라** — 이 문제를 다음에 어떤 단어로 검색할지(증상·에러·모듈명 5~10개). 비우면 검색 게이트·랭킹에 기여하지 못한다(lesson/decision/architecture와 동일 신호). 세션이 쓴 troubleshooting은 바로 active.

## 1.7. architecture를 직접 작성 (D-26 — create/update/skip)

이번 작업에서 다음 중 하나라도 했나?
- **구조를 바꿨다**: 컴포넌트 추가 / 관계 변경 / 데이터 흐름 재편 / 모듈 경계 이동, 또는
- **기존 구조를 새로 이해·문서화했다**: 코드를 분석해 "이 시스템이 어떻게 생겼는지"의 지도를 그렸다 (비효율·중복 진단, 리팩토링 계획 수립, 책임 분산 파악 등 — **분석·계획 task도 포함**). 코드를 실제로 바꾸지 않았어도 해당된다.

architecture 문서의 본질은 "구조를 바꿨다"가 아니라 **"이 시스템이 어떻게 생겼고 왜 그런가"의 지도**다. 분석·계획 task야말로 그 지도를 그리는 핵심 활동이므로, **"코드를 안 바꿨으니 skip"으로 판단하지 말 것** — 새로 파악한 구조가 있으면 그게 architecture 재료다.

**둘 다 아니면(단순 값 수정·문구 변경·구조 무관 버그픽스 등) 건너뜁니다.** 한 task에서 모든 걸 architecture로 만들지는 말 것 — 재사용할 "구조 지도"가 생겼을 때만. (자동 감지는 surfacePatterns가 비면 0개라 신뢰 불가 — 세션이 직접 본문을 씁니다.)

해당되면, 0단계 출력의 `kind: architecture` 항목을 보고 create/update/skip을 **당신이 직접 판단**합니다:

- **같은 주제 없음 → create**: body에 본문 마크다운(## 컴포넌트, ## 데이터 흐름 등 자유 구성)을 직접 작성.
  ```bash
  echo '{"mode":"create","architecture":{"summary":"<한 줄 개요>","body":"## 컴포넌트\n- ...\n\n## 데이터 흐름\n- ...","title":"<문서 제목>","relatedFiles":[],"scope":"","trigger_keywords":[],"applicable_when":{"language":[],"kind":["architecture"],"task_type":[],"scope_id":""}}}' | node "$CLAUDE_RUNTIME_HOME/commands/architecture-write.mjs"
  ```
- **같은 주제 있고 이미 충분 → skip**.
- **같은 주제 있고 보완 필요 → update**: 기존 문서(목록의 sourceDoc)를 읽고 **통째로 다시 쓴** 전체본을 같은 id로 교체(부분교체 아님).
  ```bash
  echo '{"mode":"update","architecture":{"id":"<기존 id>","summary":"...","body":"<전체 재작성>","relatedFiles":[],"trigger_keywords":[],"applicable_when":{}}}' | node "$CLAUDE_RUNTIME_HOME/commands/architecture-write.mjs"
  ```

작성 기준: summary(필수)는 한 줄 개요, body는 당신이 쓴 본문 마크다운. **`trigger_keywords`를 꼭 채워라** — 이 구조를 다음에 어떤 단어로 찾을지(컴포넌트명·모듈명·핵심 개념 5~10개). 비우면 검색 게이트·랭킹에 기여하지 못한다. 세션이 쓴 architecture는 바로 active. 04_Architecture/Generated에 저장됩니다.

## 2. 나머지 종료 파이프라인 실행

**`/task-start` 때 기억한 `taskId`를 `--task-id`로 넘겨 종료합니다** (세션 구분의 1차 키):

```bash
node "$CLAUDE_RUNTIME_HOME/commands/session-end.mjs" --close --task-id "<task-start 때 받은 taskId>" --session-id "${CLAUDE_SESSION_ID}"
```

- `commands/task-close.mjs`는 같은 동작의 별칭입니다(`--close` 자동 적용) — 어느 쪽을 실행해도 됩니다.
- **`--task-id`가 핵심입니다.** Claude Code가 hook 쉘에 `CLAUDE_SESSION_ID`를 주입하지 않아 session-id가 비면, `--session-id`만으로는 "no active task"가 납니다. `--task-id`를 넘기면 session-id 어긋남과 무관하게 이 세션의 task를 정확히 닫습니다(멀티세션 안전).
- `--session-id`는 보조입니다 — 있으면 usage 추적에 쓰이고, 없어도 무방합니다.
- taskId를 잊었다면(컨텍스트 압축 등) `--task-id` 없이 실행하면 current-task 포인터로 폴백하나, **여러 세션이 동시에 열려 있으면 다른 세션의 task를 닫을 수 있으니** 가능한 한 taskId를 명시하세요.

(lesson·decision·troubleshooting·architecture는 위 1~1.7단계가 세션작성으로 담당하므로, session-end는 worklog와 잔여 파이프라인만 처리합니다. failures가 있으면 자동 troubleshooting draft가 보조로 생성될 수 있으나, 세션작성본(active)이 우선입니다.)

## 3. 결과 확인

출력된 worklog, troubleshooting 초안, architecture generated 문서 요약을 확인합니다.
`recommendation: promote`가 보이면 `/architecture-promote`로 정식 문서 승격을 검토합니다.

규칙:

- 현재 task의 검증 기록이 부족하면 먼저 검증 명령을 실행하고 나서 close 합니다.
- 실패가 있었다면 troubleshooting draft가 생성되었는지 확인합니다.
- close 후 새 작업은 `/task-start`로 시작합니다.
