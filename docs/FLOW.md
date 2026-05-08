# 진행 흐름 설명 (Flow)

claude-obsidian-runtime이 실제로 **무슨 일을 어떤 순서로 하는지** 구현 코드 기반으로 설명해.

[INSTALL.md](./INSTALL.md)와 [QUICKSTART.md](./QUICKSTART.md)를 먼저 읽었다는 전제.

---

## 0. 전체 구조 한 눈에

```
┌─────────────────────────────────────────────────────────────┐
│              사용자 (Claude Code 세션)                          │
│              + lead 에이전트 (PM, sub-agent 라우팅)             │
└─────────────────────────────────────────────────────────────┘
              ↓ 세션 이벤트                ↓ slash 커맨드 (8개)
┌─────────────────────────────────────────────────────────────┐
│   .claude/hooks/*.sh (6개 정의 / 활성 4개)                       │
│     활성:  session-start · prompt-context · subagent-start ·  │
│           post-edit                                          │
│     비활성: session-end · stop  (CLAUDE_SESSION_ID 미주입       │
│           이슈로 exit 0. 마무리는 /task-close slash 가 담당)    │
│   각 shell wrapper가 $CLAUDE_RUNTIME_HOME/commands/*.mjs 호출 │
└─────────────────────────────────────────────────────────────┘
                           ↓ spawn
┌─────────────────────────────────────────────────────────────┐
│              $CLAUDE_RUNTIME_HOME (shared 패키지)             │
│                                                              │
│   commands/*.mjs — CLI 레이어 (25개. eval-routing 포함)         │
│       ↓ import                                              │
│   core/*.mjs — 엔진 레이어 (33개)                             │
│     ├─ memory/ (L1~L4 + retrieval-scoring + mmr +             │
│     │           memory-evolution + safeguard)                │
│     ├─ eval/ (golden / retrieval / lesson-reuse /             │
│     │         performance / compare / routing-evaluator)     │
│     ├─ delegation-schema (Governance, P2)                    │
│     ├─ task-close-verify (S3 invariant gate)                 │
│     ├─ todo-writer (S4 Current_Todo 자동 관리)                │
│     ├─ cache-stable-stringify (S2 prefix 안정화)              │
│     ├─ error-indexer (S1 errors.jsonl)                       │
│     └─ doctor / manifest-schema / rollback / learning 등      │
└─────────────────────────────────────────────────────────────┘
                           ↓ 읽고 씀
┌─────────────────────────────────────────────────────────────┐
│                      프로젝트 로컬 데이터                       │
│                                                              │
│   <projectDir>/.claude/runtime/        ← runtime 상태         │
│     current-task.json / tasks/ / events/*.jsonl /            │
│     events/errors.jsonl  ← S1 별도 채널                        │
│     delegations.jsonl    ← P2 lead 위임 로그                   │
│     retrieval/last-context.json / code-index/ /              │
│     knowledge/ / architecture/ / eval/                       │
│                                                              │
│   <projectDir>/document/obsidian_context/  ← 볼트 mirror      │
│     _meta/obsidian_paths.json / context_routes.json /        │
│     (mirror of vault managed roots, _quarantine 자동 prune)   │
│                                                              │
│   <vaultRoot>/                          ← Obsidian 볼트       │
│     00_Home/Current_Todo.md (S4 자동 관리) /                   │
│     04_Architecture/ / 08_Lessons/ / 08_Reflections/ /        │
│     ... / 10_Worklogs/                                        │
└─────────────────────────────────────────────────────────────┘
```

**핵심 원칙**: 알고리즘은 shared (`$CLAUDE_RUNTIME_HOME`), 데이터는 project-local. lead 가 PM 으로 라우팅 + 모든 위임은 `delegations.jsonl` 기록 (Governance).

---

## 1. 설치 흐름

### 1-A. `claude-runtime init` 이 실제로 하는 일 (`commands/init-project.mjs`)

**함수**: `runInit(opts)` — 순수 함수 (doctor/hooks 부수효과 제외).

1. **9개 managed vault roots 생성** — `DEFAULT_MANAGED_ROOTS_9` 상수 기반
   - `00_Home`, `04_Architecture`, `06_Troubleshooting`, `07_Decisions`, `08_Lessons`, `08_Reflections`, `09_Templates`, `09_Templates/Procedures`, `10_Worklogs`
   - 각 아래에 `Drafts/`, `Auto/`, `Generated/` 서브디렉토리 추가 (필요한 곳만)

2. **볼트 `00_Home/*.md` 3개 파일 복사 + `{{PROJECT_ID}}` / `{{VAULT_ROOT}}` 치환**
   - `<vaultRoot>/00_Home/<projectId>_Index.md`
   - `<vaultRoot>/00_Home/Current_Focus.md`
   - `<vaultRoot>/00_Home/Reading_Order.md`

3. **`document/obsidian_context/_meta/` 2개 config 생성**
   - `obsidian_paths.json` (vaultRoot, managedRoots 등)
   - `context_routes.json` (always, groups, writeBack)

4. **`.claude/runtime/` 7개 subdir 생성** — tasks, events, retrieval, code-index, knowledge, architecture, eval

5. **`.claude/runtime-manifest.json` 치환 복사** — 프로젝트 매니페스트 (6축 + 확장 4축)

6. **`.claude/commands/*.md` slash 커맨드 템플릿 복사** — `/task-start`, `/task-close` 등

7. **`.claude/agents/<projectId>-lead.md` 생성** — `templates/agents/_lead.md` 치환 복사

8. **`.claude/runtime/eval/golden-tasks.json` 복사** — 평가용 10 task 정의

**이후 (main 흐름)**:

9. **`install-hooks` 자동 호출** (`--skip-hooks` 없으면)
10. **`doctor --full --since-init` 자동 호출** (`--no-doctor` 없으면)

### 1-B. `install-hooks` 실제 동작 (`commands/install-hooks.mjs`)

**두 모드 자동 분기**:

**Template copy mode** (`--from-manifest`, `--preserve`, `--dry-run`, `--force` 중 하나 설정 시 or 매니페스트 없음)
- `templates/hooks/*.sh` 6개를 `.claude/hooks/`로 복사
- 기존 파일 + preserve 목록 → skip
- `--force` → 덮어쓰기
- `--dry-run` → 계획만 stdout

**Manifest mode** (기본, runtime-manifest.json 존재 시)
- `CORE_HOOKS` 6개 + `POST_TOOL_USE_CORE` 조합 처리
- shell wrapper 자동 생성 (`$CLAUDE_RUNTIME_HOME` 참조 + legacy fallback)
- `.claude/settings.json`의 `hooks` 섹션 patch
- `.claude/runtime-version.json` 기록

**6개 core hook → 호출 대상 CLI** (활성 4개 / 비활성 2개):

| Hook 이벤트 | Shell wrapper | 호출 CLI | 활성 |
|-------------|--------------|----------|------|
| SessionStart | runtime-session-start.sh | `commands/session-start.mjs` | ✅ |
| UserPromptSubmit | runtime-prompt-context.sh | `commands/prompt-context.mjs` | ✅ |
| SubagentStart | runtime-subagent-start.sh | `commands/subagent-start.mjs` | ✅ |
| PostToolUse (Edit/Write/Bash) | runtime-post-edit.sh | `commands/post-edit.mjs` | ✅ |
| Stop, SubagentStop | runtime-stop.sh | `commands/stop.mjs` | ❌ `exit 0` |
| SessionEnd | runtime-session-end.sh | `commands/session-end.mjs` | ❌ `exit 0` |

**왜 2개가 비활성인가** (commit `f836e06`): Claude Code v2.1.128+ 가 hook 쉘에 `CLAUDE_SESSION_ID` 환경변수를 안 주입함. 자동 hook 으로 호출되면 빈 id 로 `current-task.json` parallel-task pointer 가 손상. 사용자가 `/task-close` slash 로 명시 종료 → `$ARGUMENTS` 로 id 전달 → `commands/session-end.mjs --close --session-id "${CLAUDE_SESSION_ID}"`.

---

## 2. 세션 라이프사이클 흐름

Claude Code 세션 1회 동안 어떤 순서로 일어나는지.

### 2-A. 세션 시작 시점 (SessionStart)

```
Claude Code 세션 시작
  ↓
.claude/hooks/runtime-session-start.sh 실행
  ↓ bash
$CLAUDE_RUNTIME_HOME/commands/session-start.mjs
  ↓ 읽음
.claude/runtime/current-task.json  (있으면 active task 정보)
.claude/runtime/tasks/<taskId>.json
.claude/runtime/events/errors.jsonl  ← 최근 N건 주입 (S1)
Obsidian 10_Worklogs/Auto/ 최신
.claude/agents/<projectId>-lead.md   ← 포인터만 (본문 X)
  ↓ stable-stringify (객체 키 정렬, S2)
{type: "additionalContext", additionalContext: "[Runtime Session Context]\n..."}
  ↓ Claude Code가 시스템 컨텍스트로 주입
Claude가 "진행 중인 task + 최근 실패 + lead" 인식 가능 상태
```

**stable-stringify 의 의미** (S2, `core/cache-stable-stringify.mjs`): 같은 task 의 같은 상태에서는 출력 토큰 시퀀스가 byte-identical. → KV-cache prefix 가 안 깨짐 → 다음 prompt-context 에서도 prefix hit. `commands/__tests__/session-start-prefix.test.mjs` 가 invariant 검증.

**`projectKinds` 가 빈 배열인 첫 세션**: lead 가 추가 분기 — 사용자에게 kind 질문 → 응답 받으면 manifest 갱신. `templates/agents/__tests__/lead-notify-ask.test.mjs` 가 notify(알림만) vs ask(승인 필요) 컨벤션 검증.

### 2-B. 프롬프트 입력 시점 (UserPromptSubmit)

```
사용자가 Claude Code에 메시지 입력
  ↓
.claude/hooks/runtime-prompt-context.sh 실행
  ↓
commands/prompt-context.mjs
  ↓ 읽음
.claude/runtime/retrieval/last-context.json  (이전 task-start 결과)
.claude/runtime/knowledge/*.jsonl  (lessons, reflections, procedures 등)
.claude/runtime/code-index/*.jsonl  (scope별 surface 목록)
document/obsidian_context/_meta/context_routes.json  (routes.groups)
  ↓ ① applicable_when 게이트 (S1)  ── core/memory/retrieval-scoring.mjs :: passesApplicableWhen()
       context.language / .layer / .task_type 모두 매칭 통과만 다음 단계
  ↓ ② 3축 스코어링            ── scoreItem(item, ctx)
       α_recency × exp(-0.05 × days)
       + α_importance × (importance/10)
       + α_relevance × jaccard(promptTokens, itemTokens)
  ↓ ③ MMR (S2)                 ── core/memory/mmr.mjs :: rerankMMR()
       λ=0.7. 점수 1~2위가 거의 동일 lesson 일 때 다양성 확보
  ↓ ④ payload_ref 확장 (S2)    ── core/eval/event-reader.mjs
       큰 payload 는 별도 파일로 빼고 ref 만 인덱스에 → 이벤트 라인 짧게 유지
  ↓ stable-stringify
{type: "additionalContext", additionalContext: "[Runtime Context]\n- code_hits: ...\n- read_first: ...\n- knowledge_hits: ..."}
  ↓
Claude가 관련 코드/문서/교훈 자동 인식
```

**핵심 변경 (v3.3)**: 점수 계산 앞단에 `applicable_when` 게이트가 들어왔다. lesson frontmatter 의 `applicable_when.language / layer / task_type` 이 현재 task context 와 모두 매칭되어야 후보로 통과. 빈 게이트(필드 없음)는 자동 통과 — 즉 기존 lesson 도 호환 동작.

### 2-C. 작업 수행 시점 (PostToolUse)

Claude가 Read/Edit/Write/Bash 도구 호출할 때마다.

```
Claude: Edit tool 호출 (예: backend/src/services/paymentService.js)
  ↓
.claude/hooks/runtime-post-edit.sh 실행 (background)
  ↓ stdin으로 {tool_name, tool_input: {file_path, ...}} 받음
commands/post-edit.mjs
  ↓ 분기
  - Edit/Write → captureLearningEvent(file_modified)
  - Read + vault .md 경로 → captureFileRead(file_read)
  - Bash (npm test 등) → captureLearningEvent(verification_run/failed)
  - Bash tool_error 있음 → tool_failed
  ↓ append
events/<scope>.jsonl   ← 한 줄 JSON row
  ↓
(Claude 흐름은 영향 받지 않음. 추적만)
```

**dedup 로직** — file_read는 같은 sessionId + 같은 path는 60초 내 중복 제거 (`core/learning-capture.mjs`).

### 2-C-bis. post-edit 의 추가 책임 (S4)

`commands/post-edit.mjs` 가 도구 결과 분기 외에 두 가지를 더 한다:

| 책임 | 코드 | 동작 |
|------|------|------|
| **frontmatter safeguard** | `core/memory/memory-evolution.mjs :: safeguardFrontmatter()` | lesson/decision auto write 시 frontmatter 검증 게이트. `applicable_when` / `trigger_keywords` / `confidence` 필수 필드 누락이면 write 차단 + warning |
| **Current_Todo 자동 갱신** | `core/todo-writer.mjs` | task 의 진행 상태가 변할 때마다 `00_Home/Current_Todo.md` 를 lead 가 보는 형태로 자동 재작성 |

`core/memory/__tests__/memory-evolution-safeguard.test.mjs` + `core/__tests__/todo-writer.test.mjs` 가 검증.

### 2-D. 세션 종료 시점 (`/task-close` slash 만)

```
사용자: /task-close [--verify]
  ↓ Claude Code가 슬래시 명령어 실행
commands/session-end.mjs --close --session-id "${CLAUDE_SESSION_ID}"
  ↓
core/session-end-engine.mjs :: runSessionEndHooks(projectDir, {sessionId, taskId})
  ↓ 고정 순서 훅 실행 (manifest.memoryLayers / sessionEndPipeline flag로 skip 가능)
```

> **자동 hook 으로 들어오지 않음**. `runtime-session-end.sh` / `runtime-stop.sh` 는 `exit 0` 만 들어있다 (D-18). 사용자가 명시 호출해야 마무리 발생.

**세션 종료 훅 순서**:

1. **capture_events** — 이번 task의 events.jsonl 로드 (errors.jsonl 포함)
2. **lesson_draft** (evolutionEnabled 기본 true)
   - `core/learning-curate.mjs :: buildLessonDraft(task, events)` 호출
   - v3 Zettelkasten 스키마 (trigger_keywords, applicable_when, confidence, importance, last_accessed_at, access_count, evolved_at, linked_reflection 등 11 필드)
   - frontmatter safeguard 통과 후만 write (S4)
   - `08_Lessons/Drafts/<date>_<slug>.md` 생성
3. **lesson_upsert** — `core/memory/semantic-store.mjs :: upsertLesson()`
   - `.claude/runtime/knowledge/lessons.jsonl`에 row append
   - A-Mem evolution 자동 실행: 새 lesson과 자카드 유사도 ≥ 0.7 인 기존 lesson 찾아 `evolved_at` 갱신
4. **reflection_draft** (reflectionsEnabled 기본 true + failures ≥ 1)
   - `buildReflectionDraft(task)` 호출 (실패 없으면 null 반환)
   - `08_Reflections/Drafts/<date>_<taskId>_reflection.md` 생성
   - `linked_lesson` 필드로 동 task의 lesson과 페어링
   - reflection-agent 템플릿(`templates/agents/_recommended/_common/reflection-agent.md`)이 lead 에 의해 위임될 수도 있음 (P3)
5. **reflection_upsert** — `core/memory/reflective-store.mjs :: upsertReflection()`
6. **troubleshooting_draft** (failures ≥ 1)
   - `buildTroubleshootingDraft(task, failures)` — auto-fill 4섹션 + manual-fill 4섹션 (TODO 마커)
   - `06_Troubleshooting/Drafts/<date>_<slug>.md` 생성
7. **troubleshooting_write** — 파일 쓰기
8. **architecture_detect** — public surface 변경 감지 → `04_Architecture/Generated/*.md` 후보
9. **worklog** (항상)
   - `core/session-end-engine.mjs :: buildHandoffWorklog()` — 5섹션 Handoff markdown
   - `10_Worklogs/Auto/<date>_<taskId>.md` 생성
10. **procedural_distill** (proceduralEnabled 기본 true, 배치)
    - `distillProceduralMemory(taskHistory, vault)` — 30일 내 동일 surfacePattern 3회 이상 감지 시 `09_Templates/Procedures/Drafts/<scope>_<pattern>.md` 생성
11. **procedural_upsert** — `core/memory/procedural-store.mjs :: upsertProcedure()`
12. **current_todo_sync** (S4) — `core/todo-writer.mjs` 가 `00_Home/Current_Todo.md` 갱신
13. **verify_gate** (S3, `--verify` 플래그가 있을 때만)
    - `core/task-close-verify.mjs :: verifyClose(projectDir)`
    - manifest 6축 / managed roots / `delegations.jsonl` 무결성 / `Current_Todo` 형식 등 invariant 점검
    - 실패 시 non-zero exit + 사람에게 ask. 자동 복구 X.

### 2-E. sub-agent 위임 시점 (SubagentStart, P2)

lead 가 sub-agent 에 위임을 시도할 때마다.

```
lead: Task tool 호출 (subagent_type=<reviewer>, prompt=...)
  ↓
.claude/hooks/runtime-subagent-start.sh 실행
  ↓
commands/subagent-start.mjs
  ↓ 검증
core/delegation-schema.mjs :: validateDelegationPayload()
  → from / to / agentScope / task / expected 필수 필드
  → agentScope 가 from 의 권한 범위 안인지
  → Maker-Checker: 같은 sub-agent 가 자기 산출물을 자기가 검증하는 구조 차단
  ↓ append
.claude/runtime/delegations.jsonl  ← 한 줄 JSON row
  ↓
실제 sub-agent 실행 진행
```

이 채널이 `eval-routing` 의 4 metrics (delegation correctness / bouncing / loop / recovery)의 입력. 깨지면 평가 자체가 깨짐.

### 2-F. 실패 발생 시점 (errors.jsonl, S1)

post-edit 가 `verification_failed` / `tool_failed` 이벤트를 적재하는 외에, **실패 패턴 인덱스**를 별도로 관리한다.

```
verification_failed / tool_failed 이벤트
  ↓
core/error-indexer.mjs :: appendError()
  ↓ append
.claude/runtime/events/errors.jsonl
  ↓
다음 SessionStart 가 자동으로 최근 N건 주입
  ↓
Claude 가 "최근 같은 종류의 실패가 있었음" 인지 → 재실패 차단
```

실측 검증: `commands/__tests__/session-start-errors.test.mjs`.

---

## 3. 핵심 기능 흐름 5가지

### 3-A. 코드 탐색 (task-start)

```
/task-start "결제 버그 수정"
  ↓
commands/task-start.mjs :: runTaskStart()
  ↓
core/task-start-engine.mjs :: createAndStartTask(args, config)
  ↓ 1. syncVault (obsidian-sync 훅으로 위임)
  ↓ 2. resolveContext
       → core/context-resolver.mjs :: loadContextRoutes(), selectContextNotes()
       → resolveKnowledgeHits() — knowledge/*.jsonl 스코어링
       → buildReadFirst() — path + why만 (본문 X)
       → buildGuardrails() — matchedGroups.guardrails 수집
  ↓ 3. taskId 생성 (prompt slug + timestamp)
  ↓ 4. taskRecord 조립
  ↓ 5. 파일 쓰기 (dry-run 아니면)
       current-task.json, tasks/<taskId>.json, last-context.json
  ↓ 6. learning-capture 로 task_created 이벤트 append
  ↓ stdout
9-필드 JSON 출력 (마지막 라인)
```

**`--dry-run` 모드** (doctor C09, eval-run이 사용):
- 모든 파일 쓰기 skip
- obsidian-sync skip
- stdout만 출력

### 3-B. 학습 축적 (4-Layer 메모리)

| Layer | 저장소 | 트리거 | 생성 함수 |
|-------|--------|--------|----------|
| L1 Episodic | `events/<scope>.jsonl` | 모든 도구 호출 | `captureLearningEvent()`, `captureFileRead()` |
| L2 Semantic | `08_Lessons/` + `knowledge/lessons.jsonl` | task 종료 | `buildLessonDraft()` + `upsertLesson()` |
| L3 Procedural | `09_Templates/Procedures/` + `knowledge/procedures.jsonl` | 30일 3회 반복 | `distillProceduralMemory()` + `upsertProcedure()` |
| L4 Reflective | `08_Reflections/` + `knowledge/reflections.jsonl` | failures ≥ 1 | `buildReflectionDraft()` + `upsertReflection()` |

**A-Mem evolution** (`core/memory/memory-evolution.mjs`):
- 새 lesson 생성 시 자동 트리거
- 기존 lessons와 tokens 자카드 유사도 계산
- ≥ 0.7 & top-3 이웃 → `proposeEvolution()` → rule-based 판정
- 확정 시 기존 lesson frontmatter의 `evolved_at` 배열에 `{at, from_lesson}` append

### 3-C. 코드 인덱싱 (memory-refresh)

```
claude-runtime memory-refresh
  ↓
commands/memory-refresh.mjs
  ↓ 병렬
  1. core/code-index-build.mjs :: buildCodeIndex()
     → scopeFolderMap + indexTargets 기반 파일 스캔
     → public surface 감지 (patterns + surfaceType)
     → code-index/<scope>.jsonl 생성
  2. commands/knowledge-index-build.mjs
     → 볼트 6개 루트 (Lessons, Reflections, Troubleshooting, Decisions, Procedures, + ...) 스캔
     → frontmatter 파싱 → 5 kind로 분류
     → knowledge/{lessons,reflections,troubleshooting,decisions,procedures}.jsonl 생성
```

매 task-start 시 자동 실행 **안 함**. 수동 호출 또는 주기적 크론.

### 3-D. 평가 (4축 프레임)

```
claude-runtime doctor --full --eval
  ↓ 12/12 PASS 확인 후
$CLAUDE_RUNTIME_HOME/commands/eval-run.mjs --golden --all
  ↓
core/eval/golden-task-loader.mjs :: loadGoldenTasks()
  → .claude/runtime/eval/golden-tasks.json (10 task)
  ↓ 각 task마다
core/eval/golden-task-runner.mjs :: runGoldenTask()
  → spawnSync('node', ['task-start.mjs', '--dry-run', '--task', task.prompt, ...])
  → 30초 timeout + 부수효과 감지 (mtime/size 스냅샷 비교)
  → 9필드 JSON 파싱
  → GoldenRun record
  ↓ 3축 평가 spawn
  - eval-retrieval.mjs → Precision@5, Recall@10, MRR, NDCG@10
  - eval-lesson-reuse.mjs → 재매칭률, confidence 분포, χ²
  - eval-performance.mjs → tokenWma7d, monotoneDecreasing3d, perDaySeries
  ↓
core/eval/report-writer.mjs :: writeReport(report)
  → .claude/runtime/eval/reports/<YYYYMMDD-HHmm>_<projectId>.json
  → stdout 마지막 라인: REPORT=<absolute path>
```

**두 프로젝트 비교**:
```
claude-runtime eval-compare --reports A.json B.json
  ↓
core/eval/compare-engine.mjs :: compareReports()
  → schemaMatch (rawSchemaKeys 교집합/합집합)
  → distributionSkew (readFirstCount, codeHitsCount, guardrailsCount, matchedScopesCount)
  → quality diff
  → performance tokenDeltaPercent, wallTimeDeltaPercent
  → verdict: pass | warn | fail
  ↓ stdout (text or json)
```

### 3-E. 건강 체크 (doctor 12체크)

`commands/doctor.mjs` → `core/doctor-checks.mjs :: ALL_CHECK_IDS` 순회.

| ID | 체크 | 대상 |
|----|------|------|
| C01 | CLAUDE_RUNTIME_HOME | env + 경로 존재 |
| C02 | manifest 6축 | 필수 필드 검증 (projectTag, defaultScope, surfacePatterns, scopeFolderMap, preserveHooks, sessionEndPipeline) |
| C03 | obsidian_paths | vaultRoot reachable |
| C04 | managedRoots | 9개 폴더 존재 |
| C05 | hook wrappers | 6 core + preserve list |
| C06 | `<projectId>-lead.md` | 에이전트 파일 + frontmatter |
| C07 | code-index | `*.jsonl` 파싱 |
| C08 | knowledge-index | 5 kind jsonl 파싱 |
| C09 | task-start dry-run | spawnSync + 9필드 JSON 검증 |
| C10 | Prerequisites | Node ≥ 20, git ≥ 2.40 |
| C11 | Template integrity | `templates/_manifest.json` SHA256 + 필수 파일 존재 |
| C12 | Performance | `last-context.json` < 1MB, task-usage 토큰 편차 |

**--since-init 플래그 있으면**: fail 1건 이상 시 자동 롤백 프롬프트 (`core/doctor-rollback.mjs :: promptRollback()`). `y` → `.claude.backup-<ts>/`에서 복원 후 exit 2.

### 3-F. 라우팅 평가 (P3, eval-routing)

```
node $CLAUDE_RUNTIME_HOME/commands/eval-routing.mjs --project-dir "$PWD"
  ↓
core/eval/routing-evaluator.mjs :: evaluateRouting()
  ↓ 입력
.claude/runtime/delegations.jsonl       ← 실제 위임 로그
templates/eval/routing-goldens.json     ← 기대 위임 경로
  ↓ 4 metrics 계산
  - delegation_correctness  : (실제 ∩ 기대) / 기대  — 정확도
  - bouncing                : "A→B→A" 반복 비율    — 반복 감지
  - loop                    : "A→B→C→A" 같은 사이클  — 데드록 감지
  - recovery                : 실패 후 다른 경로로 회복한 비율
  ↓ 출력
.claude/runtime/eval/reports/routing_<date>.json
```

낮은 점수가 나오면 lead 가 부적합한 sub-agent 에 위임하고 있다는 신호. lead 에이전트의 `## Capability Routing` 섹션 (`templates/agents/_lead.md`) 을 조정해야 함.

### 3-G. Governance — 모든 위임을 한 줄로

| 필드 | 의미 |
|------|------|
| `at` | timestamp |
| `from` | 위임자 (보통 lead) |
| `to` | 수임 sub-agent 이름 |
| `agentScope` | 수임자가 만질 수 있는 디렉토리·파일 패턴 |
| `task` | 위임 내용 요약 |
| `expected` | 기대 결과 / 검증 가능한 산출물 |

**Maker-Checker**: 같은 sub-agent 가 자기 산출물을 검증하지 않는다. lead 가 별도 reviewer 에이전트(`code-reviewer` 등)에게 검증을 위임 → `delegations.jsonl` 에 maker / checker 두 줄이 짝지어 남는다.

`core/delegation-schema.mjs` 가 schema 검증, `commands/subagent-start.mjs` 가 hook 진입점, `core/eval/routing-evaluator.mjs` 가 후속 평가.

---

## 4. 데이터 흐름 예시 (1 task)

실제 task 1회 동안 어떤 파일이 어떻게 쓰이는지.

### 4-A. 시점별 변화

**t0: 세션 시작**
- Claude Code 세션 시작
- hook → session-start.mjs → `[Runtime Session Context]` 주입
- 파일 변경: 없음

**t1: `/task-start "결제 버그 수정"`**
- `commands/task-start.mjs` 실행
- 파일 생성/수정:
  - `.claude/runtime/current-task.json` — 활성 task 포인터
  - `.claude/runtime/tasks/20260423-1500-...json` — task record
  - `.claude/runtime/retrieval/last-context.json` — prompt → readFirst/codeHits 결과 스냅샷
  - `.claude/runtime/events/<scope>.jsonl` — `task_created` row 1개 append

**t2: 사용자 프롬프트 "paymentService.js 버그 찾아줘"**
- hook → prompt-context.mjs → `[Runtime Context]` 주입 (code_hits, read_first, knowledge_hits)
- 파일 변경:
  - `.claude/runtime/retrieval/hit-counts.json` — 매칭된 knowledge/code row의 hit count +1

**t3: Claude가 Read(paymentService.js) 호출**
- hook → post-edit.mjs
- vault 밖 경로라 `isReadableDocPath` false → file_read 이벤트 X
- 파일 변경: 없음

**t4: Claude가 Read(04_Architecture/Payment.md) 호출**
- hook → post-edit.mjs
- vault 하위 `.md` → `captureFileRead` 호출 (60초 dedup 통과)
- 파일 변경:
  - `events/<scope>.jsonl` — `file_read` row append

**t5: Claude가 Edit(paymentService.js) 호출**
- hook → post-edit.mjs → `captureLearningEvent('file_modified')`
- 파일 변경:
  - `events/<scope>.jsonl` — `file_modified` row append

**t6: Claude가 Bash(npm test) 호출 → 성공**
- hook → post-edit.mjs → `captureLearningEvent('verification_run')`
- 파일 변경:
  - `events/<scope>.jsonl` — `verification_run` row append

**t7: `/task-close`**
- hook → stop.mjs → session-end-engine.runSessionEndHooks()
- 파일 생성/수정:
  - `08_Lessons/Drafts/20260423-결제-버그-수정.md` — lesson draft (confidence=medium, importance=6, trigger_keywords=[결제,버그,paymentService])
  - `knowledge/lessons.jsonl` — lesson row append
  - (실패 없었으니 reflection/troubleshooting skip)
  - `04_Architecture/Generated/*.md` — 변경된 surface 있으면 후보 쓰기
  - `10_Worklogs/Auto/2026-04-23_20260423-1500-...md` — Handoff 5섹션 worklog
  - `.claude/runtime/current-task.json` → 삭제 or status: 'completed'

**t8: 다음 세션 시작**
- session-start.mjs → 이전 worklog 참조 → `[Runtime Session Context]`에 포함

### 4-B. 실제 lesson frontmatter 예시 (buildLessonDraft 출력)

```yaml
---
id: lesson-20260423-결제-버그-수정
type: lesson
scope: backend
title: "paymentService 결제 재시도 로직 수정"
summary: "timeout 후 재시도 시 중복 결제 위험. idempotency key 필수."

trigger_keywords: [결제, 버그, paymentService, idempotency, timeout, 재시도, backend]
applicable_when: "hook 변경 시 + post-edit 이벤트 적재 흐름"
confidence: medium
importance: 6
last_accessed_at: "2026-04-23T15:30:00Z"
access_count: 0
evolved_at: []
linked_reflection: null

created_at: "2026-04-23T15:30:00Z"
updated_at: "2026-04-23T15:30:00Z"
status: draft
related_task: 20260423-1500-결제-버그-수정
related_files:
  - backend/src/services/paymentService.js
tokens: [결제, 버그, payment, service, idempotency, timeout]
---

# What happened
결제 요청 timeout 후 클라이언트가 재시도했을 때 서버가 같은 결제를 두 번 처리함.

# Why
`paymentService.process()` 가 idempotency key를 검사하지 않아서 중복 요청 구분 불가.

# How to apply next time
결제 관련 endpoint는 반드시 idempotency key 미들웨어 적용. 신규 결제 경로 추가 시 `backend/src/middleware/idempotency.js` 사용 확인.

# Related
- 관련 lesson: [[...]]
- 관련 files: backend/src/services/paymentService.js
```

### 4-C. Worklog Handoff 5섹션 예시 (buildHandoffWorklog 출력)

```markdown
---
type: worklog
taskId: 20260423-1500-결제-버그-수정
sessionId: <uuid>
hookEventName: SessionEnd
date: 2026-04-23
modifiedFileCount: 3
failureCount: 0
scopes: [backend]
---

## 이번 세션에서 한 일
- backend/src/services/paymentService.js — idempotency key 검사 추가
- backend/src/middleware/idempotency.js — 신규 미들웨어
- commit: a7b2c... feat(payment): idempotency key 검증
- verification: npm test PASS (12/12)

## 남은 일 (다음 세션 먼저 할 것)
- [ ] idempotency 미들웨어 통합 테스트 작성
- [ ] 프론트 결제 플로우 재시도 UX 업데이트

## 건드리면 안 되는 것
- preserveHooks: []
- readOnly 경로: deploy/**, database/**

## 핵심 가정 (깨지면 재설계)
- matched scopes: backend
- decisions: idempotency key 검증은 미들웨어 레벨에서만

## 한 줄 메모
"다음 세션 진입점: idempotency 통합 테스트 작성부터"
```

---

## 5. 파일 위치 치트시트

| 목적 | 위치 |
|------|------|
| 현재 활성 task | `<projectDir>/.claude/runtime/current-task.json` |
| 모든 task 이력 | `<projectDir>/.claude/runtime/tasks/*.json` |
| 이벤트 로그 | `<projectDir>/.claude/runtime/events/<scope>.jsonl` |
| 실패 이벤트 (S1) | `<projectDir>/.claude/runtime/events/errors.jsonl` |
| 위임 로그 (P2) | `<projectDir>/.claude/runtime/delegations.jsonl` |
| 마지막 task-start 스냅샷 | `<projectDir>/.claude/runtime/retrieval/last-context.json` |
| 코드 인덱스 | `<projectDir>/.claude/runtime/code-index/<scope>.jsonl` |
| 지식 인덱스 (5 kind) | `<projectDir>/.claude/runtime/knowledge/{lessons,reflections,troubleshooting,decisions,procedures}.jsonl` |
| 평가 리포트 (4축) | `<projectDir>/.claude/runtime/eval/reports/<date>_<projectId>.json` |
| 평가 리포트 (Routing) | `<projectDir>/.claude/runtime/eval/reports/routing_<date>.json` |
| 매니페스트 | `<projectDir>/.claude/runtime-manifest.json` |
| 볼트 경로 설정 | `<projectDir>/document/obsidian_context/_meta/obsidian_paths.json` |
| 컨텍스트 라우트 | `<projectDir>/document/obsidian_context/_meta/context_routes.json` |
| lead 에이전트 | `<projectDir>/.claude/agents/<projectId>-lead.md` |
| 권장 sub-agent 카탈로그 | `$CLAUDE_RUNTIME_HOME/templates/agents/_recommended/<kind>/*.md` |
| Hook shell wrapper | `<projectDir>/.claude/hooks/runtime-*.sh` |
| Slash command | `<projectDir>/.claude/commands/*.md` (또는 `$CLAUDE_RUNTIME_HOME/templates/commands/*.md`) |
| Auto worklog | `<vaultRoot>/10_Worklogs/Auto/<date>_<taskId>.md` |
| Auto lesson | `<vaultRoot>/08_Lessons/Drafts/<date>_<slug>.md` |
| Auto reflection | `<vaultRoot>/08_Reflections/Drafts/<date>_<taskId>_reflection.md` |
| Auto troubleshooting | `<vaultRoot>/06_Troubleshooting/Drafts/<date>_<slug>.md` |
| Auto architecture 후보 | `<vaultRoot>/04_Architecture/Generated/<date>_<slug>.md` |
| Auto procedure 후보 | `<vaultRoot>/09_Templates/Procedures/Drafts/<scope>_<pattern>.md` |
| Current_Todo (S4 자동) | `<vaultRoot>/00_Home/Current_Todo.md` |

---

## 6. "왜 이런 구조?" 요약

### shared vs local 분리
- shared (`$CLAUDE_RUNTIME_HOME`): 알고리즘만. 여러 프로젝트가 공유. `git pull`로 엔진 개선 전파.
- local (`<projectDir>/.claude/`, `<vaultRoot>/`): 프로젝트별 고유 지식/상태. 다른 프로젝트에 새어나가지 않음.

### runtime (compact) vs Obsidian (curated) 분리
- runtime: JSONL + current-task 같은 초경량 인덱스. Claude가 즉시 읽음.
- Obsidian: 사람이 읽는 서사 문서. lesson 본문은 Claude가 자동으로 읽지 않음 (readFirst는 경로+why만). Claude가 명시적으로 Read해야 로드됨.

### 4-Layer 메모리
| Layer | 목적 |
|-------|------|
| L1 Episodic | 원시 이벤트 (무엇을 했는가) |
| L2 Semantic | 추출된 지식 (Zettelkasten atomic, A-Mem evolution) |
| L3 Procedural | 재사용 워크플로우 (Memp, LCS distillation) |
| L4 Reflective | 실패 후 반성 (Reflexion, lesson 페어링) |

### Draft-first
- 모든 자동 생성물은 `Drafts/`에. 정식 문서 승격은 사람이 결정.
- draft도 retrieval 대상에 포함 → 승격 안 해도 점진 학습.

---

## 7. 어디서 손대야 하나

### 매일 손대는 곳 (사람이 편집)
- `<vaultRoot>/00_Home/Current_Focus.md` — 오늘의 우선순위 3줄
- 세션 마무리 시 `/task-close` (반드시 명시 호출)

### 주 1회 검토
- `<vaultRoot>/08_Lessons/Drafts/` — 최근 lesson 훑어보기. 의미 있는 것만 정식 `08_Lessons/<scope>/*.md`로 이동. **`applicable_when` 필드 채워졌는지 확인**
- `<vaultRoot>/10_Worklogs/Auto/` 최근 5개 — 맥락 복원
- `tail .claude/runtime/delegations.jsonl` — lead 가 위임한 sub-agent 목록 확인

### 월 1회
- `<projectDir>/.claude/runtime-manifest.json` — `surfacePatterns`, `scopeFolderMap`, `projectKinds`, `agentFanoutCap` 갱신
- `/memory-refresh` 실행
- `node $CLAUDE_RUNTIME_HOME/commands/eval-routing.mjs` — 라우팅 metric 추세 확인. 하락하면 lead 의 Capability Routing 섹션 조정

### 문제 있을 때만
- `doctor --full` — 진단
- `rollback` — 복원
- `/task-close --verify` — invariant gate 만 돌리고 싶을 때

### 절대 손대지 말 것
- `templates/hooks/runtime-session-end.sh`, `runtime-stop.sh` 의 `exit 0` (D-18)
- `delegations.jsonl` 직접 편집 (eval-routing 신뢰 붕괴)
- lesson frontmatter `applicable_when` 비우기 (S1 게이트 무력화)

---

**다음 단계**: 실전 task 시작. [QUICKSTART.md §5 체크리스트](./QUICKSTART.md#5-첫-실전-task-체크리스트) 따라가면 돼.
