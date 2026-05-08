# 시작 가이드 (Quick Start)

설치가 끝났다면 이 문서로 시작해. 5분 안에 첫 task 실행 → 자동 추적 → 세션 종료까지 경험할 수 있어.

**전제**: [INSTALL.md](./INSTALL.md)의 섹션 1~5 완료 상태.

---

## 0. 동작 원리 1분 요약

Claude Code 세션에서 당신이 타이핑할 때마다, **4개 활성 hook**이 자동 실행됨:

```
1. 세션 시작        → session-start    (현재 진행 중 task / errors / lead 컨텍스트 주입)
2. sub-agent 위임   → subagent-start   (위임 페이로드 검증 + delegations.jsonl append)
3. 프롬프트 입력    → prompt-context   (관련 문서/코드/교훈 찾아서 주입)
4. 파일 수정       → post-edit        (수정 이벤트 + frontmatter safeguard + Current_Todo 갱신)
```

> 이전 버전에는 `session-end` / `stop` hook 도 있었지만, Claude Code v2.1.128+ 가 hook 쉘에 `CLAUDE_SESSION_ID` 를 안 넘기는 변경 이후 빈 id 로 parallel-task pointer 가 손상되는 문제가 있어 **의도적으로 비활성화** 됨. 세션 종료는 `/task-close` slash 명령어로 명시 호출.

**수동 조작 포인트** (slash 커맨드 8개):

| 커맨드 | 언제 |
|--------|------|
| `/task-start <설명>` | 새 task 시작할 때 |
| `/task-close [--verify]` | task 마무리 (반드시) |
| `/agents-bootstrap [--kind <kind>]` | 새 프로젝트에서 sub-agent 카탈로그 설치 |
| `/reflection-run` | 실패 분석 reflection draft 수동 생성 |
| `/architecture-promote` | Generated 후보 → 정식 문서 승격 |
| `/memory-refresh` | 코드/지식 인덱스 재빌드 |
| `/obsidian-sync` | 볼트 ↔ mirror 동기화 |
| `/obsidian-health` | 볼트 무결성 점검 |

볼트(Obsidian)에는:
- 매 세션마다 `10_Worklogs/Auto/<date>_<taskId>.md`로 handoff
- 의미 있는 변경은 `08_Lessons/Drafts/`에 lesson draft (`applicable_when` 자동 추정)
- 실패 이벤트 발생 시 `08_Reflections/Drafts/`에 reflection draft (P3 자동 트리거)
- 30일 내 같은 패턴 3회 반복 감지 시 `09_Templates/Procedures/Drafts/`에 procedure 후보
- `00_Home/Current_Todo.md` 는 post-edit/session-end 가 자동 관리 (직접 편집해도 다음 세션에 덮어쓰일 수 있음)

---

## 1. 첫 task 시작

### 1-A. Claude Code 세션 열기

관리 중인 프로젝트 디렉토리에서 Claude Code 열기.

```bash
cd <projectDir>
# Claude Code 세션 시작 (VS Code에서 사이드바 / 터미널 `claude` 등)
```

세션 시작 순간 `SessionStart` hook이 자동 실행. 아래와 같은 `additionalContext`가 시스템에 주입됨 (Claude가 내부적으로 봄):

```
[Runtime Session Context]
- session_id: <uuid>
- active_task: (없음 또는 이전 task 정보)
- recent_worklog: 10_Worklogs/Auto/<최근 파일>
- recent_errors: events/errors.jsonl 의 최근 N건 (S1)
- lead_pointer: .claude/agents/<projectId>-lead.md
```

> 직렬화는 stable-stringify (객체 키 정렬) 로 출력되므로 같은 task 의 같은 상태에서는 byte-identical → KV-cache prefix 보존 (S2).

### 1-A-bis. lead 첫 세션 — `projectKinds` 질문

`runtime-manifest.json:projectKinds` 가 빈 배열인 첫 세션이면 lead 가 한 번 묻는다:

```
이 프로젝트 유형을 알려주세요. 복수 선택 가능:
web / cli / data / library / unity / unknown
```

답변하면 lead 가 `projectKinds` 에 기록(사용자 승인 후) → 다음부턴 안 물음. unity 같은 신설 kind 는 PLAN 단계라 권장 sub-agent 카탈로그가 일부만 들어있음 (`docs/PLAN_UNITY_KIND.md` 참조).

이어서 `/agents-bootstrap --kind <선택>` 한 번 실행 → kind 별 sub-agent 6개 내외가 `.claude/agents/` 에 설치된다.

### 1-B. task 시작 (slash 커맨드)

Claude Code 입력창에:

```
/task-start 결제 모듈 버그 수정
```

또는 수동으로 직접 호출:
```bash
node $CLAUDE_RUNTIME_HOME/commands/task-start.mjs \
  --task "결제 모듈 버그 수정" --project-dir "$PWD"
```

**출력 (stdout 마지막 라인, JSON)**:
```json
{
  "taskId": "20260423-1500-결제-모듈-버그-수정",
  "readFirst": [
    {"path": "00_Home/Current_Focus.md", "why": "current priorities"},
    {"path": "04_Architecture/Payment.md", "why": "payment domain map"}
  ],
  "codeHits": [
    {"path": "backend/src/services/paymentService.js", "scope": "backend", "score": 12}
  ],
  "knowledgeHits": [
    {"id": "lesson-xyz", "kind": "lesson", "title": "결제 실패 재시도 로직..."}
  ],
  "guardrails": ["check payment logs before editing", ...],
  "matchedScopes": ["backend"],
  "matchedGroups": [{"id": "payment", "label": "Payment domain", "score": 5}],
  "currentTaskPath": "...current-task.json",
  "lastContextPath": "...last-context.json"
}
```

Claude는 이 정보를 받아 **먼저 `readFirst` 파일들 Read** → 맥락 파악 후 작업 시작.

### 1-C. 작업 진행

당신이 Claude에게 대화로 지시 → Claude가 파일 Read/Edit/Write → Bash 실행.

**매 도구 호출마다 `PostToolUse` hook 실행**:
- `Edit`/`Write` → `events/<scope>.jsonl`에 `file_modified` 이벤트 append
- `Read` (볼트 `.md` 파일) → `file_read` 이벤트 (60초 dedup)
- `Bash` (예: `npm test`) → `verification_run` 또는 `verification_failed` 이벤트

당신이 따로 기록할 필요 없음. 자동으로 쌓임.

### 1-D. task 종료 (반드시 명시 호출)

```
/task-close
```

또는 invariant 점검 게이트를 같이 돌리고 싶으면:

```
/task-close --verify
```

직접 호출하려면:
```bash
node $CLAUDE_RUNTIME_HOME/commands/session-end.mjs --close --session-id "${CLAUDE_SESSION_ID}"
```

> 이전 버전처럼 자동 hook 으로 호출되지 **않는다**. Claude Code v2.1.128+ 가 hook 쉘에 `CLAUDE_SESSION_ID` 를 안 주입해서, 자동으로 돌리면 빈 id 로 parallel-task pointer 가 손상됨. session-end / stop hook 은 의도적으로 `exit 0` 만 들어있고 실제 마무리는 이 slash 가 담당.

`/task-close` 가 아래 순서로 실행:

1. **이벤트 수집** — 이번 task 의 `events/*.jsonl` 로드
2. **lesson draft 생성** — `08_Lessons/Drafts/<date>_<slug>.md` + frontmatter safeguard 검증 (S4)
3. **reflection draft 생성** (실패 있었으면) — `08_Reflections/Drafts/<date>_<taskId>_reflection.md` (P3)
4. **troubleshooting draft 생성** (실패 있었으면) — `06_Troubleshooting/Drafts/<date>_<slug>.md`
5. **architecture 변경 감지** — public surface 변경 있으면 후보 기록
6. **worklog 생성** — `10_Worklogs/Auto/<date>_<taskId>.md` (Handoff 5섹션)
7. **procedural distillation** (배치) — 30일 내 3회 반복 패턴 감지 시 `09_Templates/Procedures/Drafts/`
8. **`Current_Todo.md` 자동 갱신** (S4)
9. **`--verify` 가 붙으면 invariant 게이트** (S3): manifest 6축 / managed roots / delegations.jsonl 무결성 등을 점검. 실패면 `/task-close` 가 non-zero exit + 사람에게 ask

---

## 2. 30초 E2E 실습

설치 후 실제 동작 확인:

```bash
# 임시 테스트 프로젝트
TMPDIR=$(mktemp -d)
cd $TMPDIR

# init
claude-runtime init --project-id smoketest --vault-root "$TMPDIR/vault" --no-doctor --skip-hooks

# 확인
ls .claude/agents/                       # smoketest-lead.md 존재
ls "$TMPDIR/vault/"                      # 9 managed roots
cat .claude/runtime-manifest.json | head # projectTag: "smoketest"

# task-start dry-run (부수효과 없이 JSON 출력만)
node $CLAUDE_RUNTIME_HOME/commands/task-start.mjs \
  --dry-run --task "smoke test" --project-dir "$PWD" | tail -1 | node -e "
const j=JSON.parse(require('fs').readFileSync(0));
console.log('9필드:', ['taskId','readFirst','codeHits','knowledgeHits','guardrails',
                      'matchedScopes','matchedGroups','currentTaskPath','lastContextPath']
                      .every(k => k in j));
"
# → 9필드: true

# eval-run 실행
cp $CLAUDE_RUNTIME_HOME/templates/eval/golden-tasks.json .claude/runtime/eval/
node $CLAUDE_RUNTIME_HOME/commands/eval-run.mjs \
  --task GOLDEN-01 --project-dir "$PWD" \
  --noRetrieval --noLessonReuse --noPerformance 2>&1 | tail -1
# → REPORT=<...>/eval/reports/<date>_smoketest.json

# 정리
cd .. && rm -rf $TMPDIR
```

---

## 3. slash 커맨드 8개 + 보조 CLI

### 3-A. `/task-start <설명>` — 새 task 시작 (lead 컨텍스트 + readFirst 주입)

위 §1-B 참조. `--dry-run` 은 doctor / golden-task-runner 내부 전용.

### 3-B. `/task-close [--verify]` — 세션 마무리

위 §1-D 참조. **세션 종료할 땐 반드시 호출**. 안 부르면 worklog/lesson draft 생성 안 됨 + parallel-task pointer 가 다음 세션까지 흘러감.

### 3-C. `/agents-bootstrap [--kind <kind>]` — sub-agent 카탈로그 설치

새 프로젝트에 sub-agent 를 한 번에 설치. 옵션:

```
/agents-bootstrap                    # projectKinds 모두 처리
/agents-bootstrap --kind web         # web kind 만
/agents-bootstrap --kind unity       # unity 6 mandatory agent (PLAN 단계)
/agents-bootstrap --dry-run          # 실제 파일 안 쓰고 후보만 출력
```

kind 별 권장 sub-agent (`templates/agents/_recommended/<kind>/`):
- **web**: frontend-reviewer · api-designer · docs-writer · test-writer
- **cli**: cli-designer · docs-writer · test-writer
- **data**: data-schema-reviewer · migration-writer · query-optimizer
- **library**: api-designer · docs-writer · test-writer · semver-auditor
- **unity** (PLAN): csharp-reviewer · unity-test-writer · scene-reviewer · addressables-strategist · repo-hygienist · unity-docs-writer
- **공통**: `_common/test-writer` · `_common/reflection-agent` (kind 무관)

### 3-D. `/reflection-run` — reflection draft 수동 생성

`task-close` 가 자동으로 만들지만, "지금 한번 분석 돌려"라고 명시하고 싶을 때.

### 3-E. `/architecture-promote` — Generated 후보 → 정식 문서 승격

`04_Architecture/Generated/` 후보를 사람이 검토 → 정식 `04_Architecture/<name>.md` 로 이동.

### 3-F. `/memory-refresh` — 코드/지식 인덱스 재빌드

대량 커밋 후 한 번 돌리면 다음 `task-start` 의 추천 정확도 개선.

### 3-G. `/obsidian-sync` — 볼트 ↔ mirror 동기화

`<vaultRoot>/` 의 실제 볼트 ↔ `<projectDir>/document/obsidian_context/` mirror 동기화. Obsidian 에서 편집한 내용을 런타임이 읽게 하려면 필요. quarantine 디렉토리는 자동 prune (data loss 방지 보호장치 포함).

### 3-H. `/obsidian-health` — 볼트 무결성 점검

managed roots / 깨진 frontmatter / 고아 mirror 등 점검.

### 3-I. 보조 CLI (slash 미설정, 수동 호출)

```bash
claude-runtime doctor --full                                                    # 12체크
claude-runtime doctor --full --json                                             # 기계 판독용
node $CLAUDE_RUNTIME_HOME/commands/task-usage.mjs --project-dir "$PWD"          # 토큰 사용량
node $CLAUDE_RUNTIME_HOME/commands/eval-run.mjs --golden --all --project-dir "$PWD"     # 10 golden tasks 벤치
node $CLAUDE_RUNTIME_HOME/commands/eval-routing.mjs --project-dir "$PWD"        # P3 Routing metrics 4
node $CLAUDE_RUNTIME_HOME/commands/eval-retrieval.mjs --project-dir "$PWD"      # retrieval P@k / R@k / MRR / NDCG
node $CLAUDE_RUNTIME_HOME/commands/eval-compare.mjs --baseline a.json --candidate b.json   # 회귀 비교
```

---

## 4. 볼트 구조 알아두기

### 4-A. 자동 생성되는 곳 (손대지 말 것)
- `10_Worklogs/Auto/` — 매 세션 worklog
- `08_Lessons/Drafts/` — Auto lesson
- `08_Reflections/Drafts/` — 실패 후 반성 (P3 자동)
- `06_Troubleshooting/*/Drafts/` — 트러블슈팅
- `07_Decisions/Drafts/` — 결정 후보
- `04_Architecture/Generated/` — 자동 감지된 아키텍처 후보
- `09_Templates/Procedures/Drafts/` — 반복 패턴 procedure
- `00_Home/Current_Todo.md` — post-edit/session-end 가 자동 관리 (S4)

### 4-B. 사람이 편집하는 곳
- `00_Home/<projectId>_Index.md` — 볼트 홈. 자유 편집
- `00_Home/Current_Focus.md` — 현재 우선순위 (lead 에이전트가 읽음)
- `00_Home/Reading_Order.md` — 신규 세션 진입 순서
- `04_Architecture/<공식 문서>.md` — draft에서 승격된 정식 문서
- `09_Templates/*.md` (Procedures 제외) — 프로젝트 고유 템플릿
- `08_Lessons/<scope>/<slug>.md` — draft 에서 사람이 승격한 lesson. **frontmatter `applicable_when` 빼먹지 말 것** (S1 게이트가 무력화됨)

### 4-C. 승격 흐름

```
Auto draft (08_Lessons/Drafts/...)
    ↓ 사람이 검토 + 승격 결정
정식 문서 (08_Lessons/<스코프>/<slug>.md)
    ↓ 다음 task-start에서 knowledge_hits로 추천됨
```

현재 승격은 수동. lead 에이전트가 제안만 함.

---

## 5. 첫 실전 task 체크리스트

- [ ] `doctor --full` 실행 → 12/12 PASS
- [ ] `<projectId>-lead.md` 파일 한 번 읽어보기 (`.claude/agents/`)
- [ ] 첫 세션에서 lead 가 묻는 `projectKinds` 답변 → manifest 기록 확인
- [ ] `/agents-bootstrap --kind <답변값>` 1회 실행 → sub-agent 6개 내외 설치
- [ ] `00_Home/Current_Focus.md` 3줄로 작성 (지금 무엇에 집중?)
- [ ] `runtime-manifest.json`의 `surfacePatterns`, `scopeFolderMap` 채움
- [ ] `obsidian_paths.json`의 `indexTargets`, `scanRoots` 채움
- [ ] `/memory-refresh` 1회 실행
- [ ] Claude Code 세션에서 `/task-start <작업 설명>` 시도
- [ ] 작업 완료 후 `/task-close` (또는 `/task-close --verify`)
- [ ] `10_Worklogs/Auto/`에 방금 세션의 파일 생성 확인
- [ ] `08_Lessons/Drafts/` 에 lesson 있으면 한 번 열어보기 — `applicable_when` 채워졌는지 확인

---

## 6. 안 되는 게 있으면

### A. hook이 안 잡힌다
- Claude Code 세션 완전히 재시작
- `.claude/settings.json`에 `hooks` 섹션 있는지 확인
- `ls .claude/hooks/` 에 `runtime-*.sh` 6개 존재 확인

### B. readFirst 추천이 항상 빈 배열
- `document/obsidian_context/_meta/context_routes.json`의 `groups` 배열이 비어있음
- `00_Home/Current_Focus.md`에 키워드 1~2개 추가 후 재시도

### C. knowledge_hits 추천이 항상 빈 배열
- 아직 lesson draft 1개도 없음 (첫 task 완료 전엔 정상)
- `knowledge/lessons.jsonl` 파일 확인: `cat .claude/runtime/knowledge/lessons.jsonl | wc -l`

### D. Claude가 task-start 결과를 무시하는 듯
- `additionalContext` 전달은 Claude Code 내부 처리. Claude가 받긴 받음
- 단, Claude가 "먼저 readFirst 읽어줘" 같은 지시 없으면 그냥 작업만 함
- `<projectId>-lead.md`의 `## Context loading` 섹션을 Claude에게 명시 지시하는 게 확실

### E. doctor C09 FAIL: "task-start CLI missing"
- `$CLAUDE_RUNTIME_HOME/commands/task-start.mjs` 파일 존재 확인
- `CLAUDE_RUNTIME_HOME` 환경변수 재설정

### F. events/*.jsonl이 안 쌓임
- Claude Code 세션 재시작 (hook 갱신)
- `echo $CLAUDE_PROJECT_DIR` 확인 (Claude Code가 자동 설정)

### G. "/task-close 안 부르고 닫으면 어떻게 돼?"
- worklog/lesson draft 미생성 + parallel-task pointer 가 `current-task.json` 에 그대로 흘러감
- 다음 세션에서 lead 가 "이전 task 가 아직 열려있음" 으로 인식
- 복구: 다음 세션에서 `/task-close <이전 taskId>` 명시 호출하거나 `current-task.json` 수동 정리 후 `/task-start` 새로 시작

### H. lead 가 sub-agent 에 위임 안 하고 본인이 다 처리
- 정상일 수 있음. 단순 task 면 위임 안 함
- 위임이 발생하면 `.claude/runtime/delegations.jsonl` 에 한 줄 추가됨. `tail .claude/runtime/delegations.jsonl` 로 확인

### I. eval-routing 점수가 0.0
- delegations.jsonl 이 비어있음 → 위임이 한 번도 일어나지 않음
- 또는 routing-goldens.json 의 기대 위임 경로가 실제와 다름
- `templates/eval/routing-goldens.json` 의 `expected.delegations` 와 실제 `delegations.jsonl` 비교

---

## 다음 단계

동작 원리와 흐름을 더 깊이 알고 싶으면 [흐름 설명](./FLOW.md) 읽어.
