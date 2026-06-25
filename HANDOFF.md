# HANDOFF — 새 세션을 위한 인수인계 문서

**목적**: 이 프로젝트에 대해 **아무것도 모르는 Claude 세션**이 1분 안에 현재 상태를 파악하고, 기획 의도/사용법/레시피 중 필요한 걸 찾아갈 수 있게 하는 엔트리포인트.

**이 문서를 먼저 읽어라**. 그 다음 상황별로 분기해.

---

## 0. TL;DR (5줄)

1. **이 프로젝트**: `claude-obsidian-runtime` v3.3.4 — Claude Code와 Obsidian을 연동해 프로젝트별 장기기억·학습축적·자동 문서화를 제공하는 **공유 런타임 패키지**.
2. **핵심 철학**: "알고리즘은 shared, 데이터는 project-local" + "Runtime compact / Obsidian curated" + "lead 가 PM 으로 라우팅"
3. **현재 상태**: 초기 v3.0 (Wave 1~3) 위에 P0~P3 (lead PM·Governance·Reflection·Routing metrics) + retrieval/메모리 보강 (applicable_when gate · KV-cache stable prefix · MMR · payload_ref · errors.jsonl · task-close --verify · frontmatter safeguard · Current_Todo 자동) 통합. **436/436 tests passing.**
4. **실전 적용 현황**: talkSim 은 v3 마이그레이션 완료, S1~S4 보강 반영. TalkUp 본체는 별도 task 로 분리 중. Unity kind 는 PLAN 단계 (`docs/PLAN_UNITY_KIND.md`).
5. **이 문서 이후 읽을 것**: 질문 유형에 따라 [PRINCIPLES.md](./PRINCIPLES.md) (왜?) / [docs/INSTALL.md](./docs/INSTALL.md) (설치) / [docs/QUICKSTART.md](./docs/QUICKSTART.md) (사용) / [docs/FLOW.md](./docs/FLOW.md) (내부 동작).

---

## 1. 이 프로젝트가 뭔가 (30초 설명)

Claude는 세션 간 영속 메모리가 없음. 매번 같은 파일 탐색, 같은 실수 반복. 프로젝트 커질수록 "이미 결정한 걸 다시 결정하는 비용"이 기하급수 증가.

**해결 구조** — 2-track 메모리:

| Track | 담당 | 수명 |
|-------|------|------|
| **Runtime** (`.claude/runtime/`) | JSONL 초경량 인덱스, task 상태, 이벤트 | Claude가 즉시 읽음 |
| **Obsidian Vault** | 04_Architecture / 07_Decisions / 08_Lessons / 06_Troubleshooting / 10_Worklogs | 사람이 검토하고 승격 |

**자동 추적**: Claude Code 세션 시작 → `[Runtime Context]` 자동 주입 → 수정 이벤트 자동 기록 → 세션 종료 시 worklog/lesson/reflection draft 자동 생성.

**다중 프로젝트**: 이 패키지를 `$CLAUDE_RUNTIME_HOME`에 두고 여러 프로젝트가 `init` 1회로 동일 runtime 확보. 엔진 개선은 `git pull` 하나로 전파.

---

## 2. 완료 vs 남은 것

### ✅ 완료된 것 (시간 순)

| 마일스톤 | 산출물 | 증거 |
|----------|--------|------|
| **v3.0 기반** (Wave 1~3, ~2026-04-23) | core/memory · core/eval · doctor 12체크 · learning-curate · init-project · install-hooks · 5 eval CLIs · golden-task-runner · lead 템플릿 v1 | 264 tests |
| **P0** lead PM 격상 + manifest 확장 | `projectKinds`/`agentFanoutCap`/`forgetting`/`promotion`/`reflection` 5필드 | `d3bade2` |
| **P1** `/agents-bootstrap` + Agent Catalog + lead Capability Routing | web/cli kind + 6 agent 템플릿 | `872f4d6` |
| **P2** Governance Layer | `delegations.jsonl` + Maker-Checker + data/library kind 6 템플릿 + context `agentScope` | `e6be07c` |
| **P3** Reflection Agent + Routing metrics 4 | `/reflection-run` + `eval-routing` + reflection 자동 트리거 | `e4fad9f` |
| **MANUS S1** retrieval 게이트 | `applicable_when` + `errors.jsonl` injection | `992094e` |
| **MANUS S2** KV-cache + 다양성 + payload_ref | stable-stringify + MMR + event-reader payload_ref | `3fe72c8` |
| **MANUS S3** error protocol + verify gate | `task-close --verify` + lead notify/ask 컨벤션 | `a4a3813` |
| **MANUS S4** frontmatter safeguard + Current_Todo 자동 | memory-evolution safeguard + `00_Home/Current_Todo.md` 자동 관리 | `e39b7de` |
| **세션 hook contract 변경** | session-end / stop hook 비활성화. `/task-close` slash 가 종료 책임 | `f836e06` |
| **obsidian-sync 보강** | quarantine prune 데이터 손실 방지 | `62100de` |

### 🔄 실전 적용 진행중

| 프로젝트 | 상태 |
|---------|------|
| **talkSim** | v3 마이그레이션 완료 후 S1~S4 보강 동기화. 9 managed roots + lead.md + golden-tasks |
| **TalkUp 본체** | 이번 흐름 제외. 별도 task |
| **productSurveyEngine** | init 실행 상태. 실제 사용 대기 |
| **AresParSimVR (Unity)** | `unity` kind 신설 PLAN 작성 (`docs/PLAN_UNITY_KIND.md`). 6개 mandatory agent 템플릿 추가됨 (`templates/agents/_recommended/unity/`) — 통합은 다음 phase |

### 📋 남은 작업 (우선순위 순)

1. **Unity kind 통합 phase** — `_lead.md` / `agents-bootstrap.md` / runtime-manifest 의 unity 분기 검증 + 옵션 카탈로그(URP/XR/Netcode/Profiler) 설계
2. **eval-routing 운영 데이터 누적** — Routing metrics 4 (delegation correctness / bouncing / loop / recovery) 임계값 30일 후 튜닝
3. **TalkUp 본체 마이그레이션** — preserveHooks 8개 주의
4. (미래) 벡터 검색/임베딩 도입 — lesson 100+ 시점 재평가
5. (미래) Agent Teams v2.1.32+ 승격 — shared task list / mailbox 필요 시

---

## 3. 다음 세션이 읽을 순서

질문 유형에 따라 분기해.

### 🤔 "왜 이렇게 만들었나?" / 철학 / 기획 의도

→ [PRINCIPLES.md](./PRINCIPLES.md)

거기서 답 안 나오면:
- 기획서 원본: `C:/Users/adkrn/.claude/plans/eventual-jingling-adleman.md` (v3.1, 1100줄 SSOT)
- §1-1 ~ §1-7 (핵심 기획 의도 7섹션)
- PRINCIPLES §10 Closed Decisions §12-1 ~ §12-14 (재논의 금지)
- PRINCIPLES §6-bis / §6-tris / §7 / §7-bis~quinquies (P0~P3, MANUS S1~S4 사유)

### 📦 "어떻게 설치해?" / "처음 써보는데"

→ [docs/INSTALL.md](./docs/INSTALL.md) (설치 가이드 8섹션)

→ [docs/QUICKSTART.md](./docs/QUICKSTART.md) (5분 시작 + 체크리스트)

### 🔧 "내부 동작은?" / "코드 어디 있어?"

→ [docs/FLOW.md](./docs/FLOW.md) (세션 라이프사이클, 4-Layer 메모리, 파일 위치 치트시트)

실제 구현 파일:
- `core/` — 엔진 (33개 파일, `core/memory/` `core/eval/` 포함)
- `commands/` — CLI (25개, `eval-routing` 포함)
- `templates/agents/_recommended/<kind>/` — sub-agent 카탈로그 (web/cli/data/library, unity 예정)
- `templates/commands/*.md` — slash command 정의 (8개)
- `templates/hooks/*.sh` — hook 정의 6개 (활성 4개. session-end/stop 비활성)
- `bin/cli.mjs` — 엔트리포인트

### 🔴 "에러 나는데?" / "doctor FAIL" / "~이럴 때"

→ docs/QUICKSTART.md §6 (자주 나는 에러 6종)

→ doctor 실행: `node "$env:CLAUDE_RUNTIME_HOME/commands/doctor.mjs" --full --json`

### 📝 "설계 문서 보고 싶어" / "왜 A를 선택하고 B는 안 했나"

→ `C:/Users/adkrn/.claude/plans/` 아래:
- `eventual-jingling-adleman.md` — 기획서 v3.1
- `DESIGN_A_step4_4.5.md` — Wave 1/2 구현 설계
- `DESIGN_B_step5.md` — doctor 12체크 설계
- `DESIGN_C_step5.5_eval.md` — 평가 프레임 설계
- `PATCH_Phase1.md` — manifest 통일 + --dry-run 패치
- `EXEC_D_migration_checklist.md` + `EXEC_D_PATCH.md` — 마이그레이션
- `WAVE{1,2,3}_{A,B,C}{1,2,3}_REPORT.md` — Wave 구현 보고서 9개

---

## 4. 주요 결정 로그 (이것만은 알아둬)

이 프로젝트에서 내린 굵직한 결정. 재논의하지 말 것.

| # | 결정 | 이유 | 근거 |
|---|------|------|------|
| D-1 | **"알고리즘 shared, 데이터 project-local"** | 엔진 개선이 한 곳에서 모든 프로젝트로 전파 + 프로젝트 데이터 오염 방지 | 기획서 §1-5 |
| D-2 | **Runtime compact / Obsidian curated 이중 저장소** | 토큰 효율(Runtime) + 사람 읽을 수 있는 서사(Obsidian) 양립 | 기획서 §1-2 |
| D-3 | **4-Layer 메모리** (Episodic/Semantic/Procedural/Reflective) | 학술 모범 사례(Park 2023, A-Mem, Memp, Reflexion) | 기획서 §1-6 |
| D-4 | **Zettelkasten atomic lesson** + frontmatter 11필드 | 재사용성 + A-Mem evolution 지원 | 기획서 §1-6 |
| D-5 | **Draft-first, 수동 승격** | retrieval precision 유지 + 사람 최종 결정권 | 기획서 §1-4 |
| D-6 | **3축 스코어링** (Recency + Importance + Relevance) | Park 2023 공식. default α=(1.0, 1.0, 1.5) | 기획서 §1-6 |
| D-7 | **A-Mem 진화는 자카드 유사도만** (LLM 없음) | 비용 회피. 임계 0.7, top-3 | 기획서 §1-6 A-Mem |
| D-8 | **Subagents 모드 한정** (Agent Teams 미사용) | v2.1.32+ 실험적. 필요 시 Step 10에서 승격 | 기획서 §1-7 |
| D-9 | **managedRoots 9개 기본값** | 8_Reflections + 9_Templates/Procedures 신설 (L3/L4) | 기획서 §12-5 |
| D-10 | **manifest 6축 필수 + 확장 4축 optional** | 프로젝트 주권 경계 | 기획서 §12-6 |
| D-11 | **task-start --dry-run은 내부 툴링용** | doctor probe + golden-task-runner가 사용. 사용자 직접 호출 스코프 밖 | 기획서 §12-7 |
| D-12 | **preserveHooks는 프로젝트 로컬 정의** | 글로벌 기본값 없음. TalkUp 8개는 TalkUp 본체에서만 | 기획서 §12-2 |
| D-13 | **벡터 검색은 Step 10 미래** | 현재는 키워드+자카드. lesson 100+ 시점 재평가 | 기획서 §12 Open |
| D-14 | **Golden Task 10개로 시작** (DeepEval 150 대신) | 경량 시작. 운영 데이터로 확장 | 기획서 §5-②-E |
| D-15 | **eval-run ↛ doctor 단방향** | 순환 참조 방지. doctor가 eval-run spawn만 | Design-C §4-D |
| D-16 | **lead 가 PM 으로 격상 (P0)** | sub-agent 라우팅 책임 + projectKinds/agentFanoutCap/forgetting/promotion/reflection 5필드 manifest 확장 | PRINCIPLES §7, §12-8 |
| D-17 | **모든 위임은 `delegations.jsonl` (P2)** | Maker-Checker 강제. 자기검증 금지. 평가 가능성 확보 | PRINCIPLES §7-bis, §12-9 |
| D-18 | **session-end / stop hook 비활성화** | Claude Code v2.1.128+ 가 hook 쉘에 `CLAUDE_SESSION_ID` 미주입. 빈 id 로 parallel-task pointer 손상. `/task-close` slash 가 종료 책임 | PRINCIPLES §12-10 |
| D-19 | **retrieval 게이트 = `applicable_when` (S1)** | 점수 앞단 게이트. 부적합 lesson(다른 언어/계층) 자동 차단 | PRINCIPLES §6-bis, §12-11 |
| D-20 | **KV-cache 보호 = stable-stringify + MMR + payload_ref (S2)** | 같은 task 의 session-start prefix 를 byte-identical 로 유지. cache hit rate 보호 | PRINCIPLES §6-tris, §12-12 |
| D-21 | **error protocol + verify gate (S3)** | `events/errors.jsonl` 별도 채널 + `task-close --verify` 종료 직전 invariant 점검 | PRINCIPLES §12-13 |
| D-22 | **Unity 는 5번째 kind (PLAN)** | Scene/Prefab/SO/UTF/XR 등은 web/cli/data/library 어디에도 안 맞음. 6 mandatory agent + 옵션 카탈로그 분리 | `docs/PLAN_UNITY_KIND.md` |
| D-23 | **lesson 은 세션 Claude 가 직접 작성 (휴리스틱·API 둘 다 폐기)** | 실측: 휴리스틱 산출물 63개 중 1개(1.6%)만 쓸모, 98%가 보일러플레이트. 작업을 수행한 세션 Claude 가 맥락을 그대로 갖고 있으므로 "무엇을 왜 배웠나"를 직접 써서 `commands/learn-write.mjs`(얇은 CLI, stdin lesson JSON → frontmatter+jsonl 저장)에 넘긴다. 별도 LLM API 호출 불필요(비용 0, 키 불필요, 맥락 손실 0). `lesson-extractor` 의 summary/rules 생성부 제거. 재사용할 교훈 없으면 lesson 생성 skip(쓰레기 0). session-end hook 은 더 이상 lesson 을 만들지 않음(troubleshooting/decision/architecture/worklog 만) | `commands/learn-write.mjs`, `core/learning-curate.mjs::writeSessionLesson`, `templates/commands/task-close.md` |

| D-24 | **task-start 의 session-id 환경변수 fallback 변수명 수정** | `task-start.mjs` 가 빈 `--session-id` 일 때 환경변수에서 복구를 시도하는데, 변수명이 `SESSION_ID`(오타)라 항상 빈 값 → 매번 fallback id 생성 → `/task-close` 첫 시도가 "no active task"(D-18 race 방어가 글로벌 pointer 거부). `CLAUDE_SESSION_ID` 를 우선 읽도록 수정 + `.trim()` 으로 `--session-id ""` 도 환경변수 재조회. hook 쉘에 실제로 `CLAUDE_SESSION_ID` 가 주입되면 fallback 없이 진짜 id 사용 → close 1회 성공. race 방어(D-18)는 불변 | `commands/task-start.mjs:243` |
| D-25 | **decision 도 세션 Claude 가 create/update/skip 직접 작성 (휴리스틱 폐기, D-23 미러링)** | 진단: decision 은 전부 똑같은 고정 2문장("Keep runtime memory...")이고 92% skipped. 세션이 "무엇을 왜 결정했나"를 직접 써서 `decision-write.mjs` 에 넘김. create/update/skip 판단도 세션이 직접(코드의 토큰겹침 추측 폐기) — `list-artifacts.mjs` 로 기존 조회 후 없으면 create / 충분하면 skip / 보완이면 기존 읽고 전체 재작성 update(같은 id 교체). **세션 작성 decision 은 바로 `status: active`**(사람 승격 폐기 — D-5 전환). session-end 의 휴리스틱 decision 자동생성 제거 | `commands/decision-write.mjs`, `commands/list-artifacts.mjs`, `core/learning-curate.mjs::writeSessionDecision/listSessionArtifacts`, `templates/commands/task-close.md` |

| D-26 | **lesson update/skip 판단 추가 + troubleshooting·architecture 세션작성 확장 (2-B 완료, D-25 미러링)** | (1) lesson: `writeSessionLesson` 이 항상 create 라 같은 주제 lesson 이 중복 생기던 것을 mode(create/update)+id override 로 교체. `findDuplicateCandidate` 호출 제거(세션이 판단), 세션작성 lesson 도 `status: active`/`generated_by: session-claude` 로 승격. (2) troubleshooting: `writeSessionTroubleshooting` 신설 — 기존 휴리스틱(failures 게이트 + manual 섹션 CURATOR_TODO 마커)을 세션이 증상/원인/수정/재발방지/검증 6섹션 직접 채우는 active 문서로 흡수. (3) architecture: `writeSessionArchitecture` 신설 — surfacePatterns 자동감지가 0개 만들던 것을 세션이 summary+body(markdown) 전체작성(부분교체 불필요). `KNOWLEDGE_INDEX_FILES.architecture='architecture.jsonl'` 신규, 경로 `04_Architecture/Generated/`. CLI 2개(`troubleshoot-write.mjs`/`architecture-write.mjs`, decision-write 복제), `list-artifacts.mjs` VALID_KINDS 에 architecture 추가. **465 tests green**(450+15). 격리 e2e(OBSIDIAN_VAULT_ROOT) 로 3산출물 실전 검증 | `core/learning-curate.mjs::writeSessionLesson/writeSessionTroubleshooting/writeSessionArchitecture`, `commands/{learn,troubleshoot,architecture}-write.mjs`, `commands/list-artifacts.mjs`, `templates/commands/task-close.md` §1~§1.7 |

| D-27 | **세션 구분을 session_id → taskId 기반으로 전환 (session_id 외부의존 우회)** | 문제: Claude Code v2.1.128+ 가 hook/슬래시에 `CLAUDE_SESSION_ID` 미주입 → task-start 가 fallback id 생성 → task 가 `sessionIds:["fallback-*"]` 로 묶여 `/task-close --session-id` 가 "no active task"(세션이 수동으로 포인터 뒤짐). 조사(Explore 2 + Plan 1): **task-start 가 hook 아니라 슬래시/직접호출이라 self-identity 입력채널 자체가 없음** → session_id/transcript_path 복구 모두 동시세션 교차오집 못 막음. **전환**: session_id 되살리지 않고 **taskId(`createTaskId`, 양쪽이 독립적으로 아는 유일 안정키)로 직접 세션 구분.** session_id 의 "닫을 task 찾는 간접키" 역할이 사라져 글로벌 포인터 경합 자체가 소멸. **흐름**: `/task-start` 가 taskId 노출→세션 Claude 가 기억→`/task-close` 가 `--task-id` 우선 전달(session-end 의 --task-id 경로는 D-24 후속으로 이미 구현). 코드변경 0(엔진 기존 지원), **지시문 2개만**(task-start.md taskId 기억 명시 + task-close.md §2 --task-id 우선 + 도입부 taskId 안내). 멀티세션 동시 close 테스트 추가(**469 green**). 격리 e2e: session-id 없이 task-start→fallback→`--task-id` close→completed 확인. **D-18 race 방어 불변**(close 글로벌포인터 거부 안 건드림, --task-id 는 프로젝트내부+미마감 가드). session_id 체계 유지(Claude Code 가 env 복원 시 자동 활용, taskId 는 1차키). **한계**: 세션이 taskId 를 기억해야 함(컨텍스트 압축 시 포인터 폴백→멀티세션이면 부정확 가능). 과거 fallback task 11개는 자동 reconcile 불가(진짜 id 미보존), --task-id 로 개별 닫기만 | `templates/commands/task-start.md`, `templates/commands/task-close.md` §2, `commands/__tests__/session-isolation.test.mjs`, (엔진: `commands/session-end.mjs` --task-id 기존) |

> **D-23 주의:**
> - 검토 과정에서 "task-close hook 이 API 로 LLM 호출" 안을 구현했다가 **폐기**함 — hook 은 node 프로세스라 세션 맥락에 접근 못 해서 API 가 필요했지만, 애초에 세션 Claude 가 직접 쓰면 그 비용·복잡도가 전부 사라짐. `/task-close` 지시문이 세션 Claude 에게 lesson 작성을 시키는 구조로 전환.
> - D-7(A-Mem 진화는 자카드만)은 여전히 유효 — D-23 은 lesson *작성* 만 바꾼 것. 메모리 *진화* 판정·검색(D-13 키워드)은 그대로. Phase 2(검색 임베딩)는 별도.

> **D-24 주의:** 이 수정은 hook 쉘이 `CLAUDE_SESSION_ID` 를 프로세스 env 에 *실제로* 주입할 때만 fallback 을 없앤다. env 에도 없으면(Claude Code 버전 의존) 여전히 fallback id 생성 → close 시 그 fallback id 를 수동 전달해야 함. 그 경우 `--task-id` 명시 close 경로 추가가 다음 후보(미구현).

---

## §확장 가이드 — 다음 세션이 이어받을 일 (산출물 생성 정상화, Phase 2)

**배경 진단(3프로젝트: Talkup 200 lesson / talkSim 57 / Pasim62 61):** 검색을 고치기 전에 산출물 자체가 무용지물임이 드러남.
| 산출물 | 실태 | 처리 |
|---|---|---|
| lesson | 옛것 60% 보일러플레이트·92~94% draft 방치 | **D-23 + D-26 해결**(세션작성 + create/update/skip, active) |
| decision | 고정 2문장·92% skipped | **D-25 해결**(세션 create/update/skip, active) |
| troubleshooting | 95% 멀쩡(failures≥1 + 사람 manual) | **D-26 해결**(세션작성 6섹션 직접, active). 자동 draft 는 보조로 잔존 |
| architecture | 3개월째 자동 0(surfacePatterns 비면 감지 0) | **D-26 해결**(세션작성 full body, active). detectArchitectureChanges 자동감지 코드수정은 2-C 잔여 |
| procedure | 전 프로젝트 0개(감지조건 과도) | 코드수정(repeatThreshold 3→2 등) — **2-C 잔여** |
| worklog | Talkup 0 / Pasim62 45(`--close` 의존) | 코드수정 — **2-C 잔여** |

**검증 끝난 세션작성 패턴(D-25/D-26) — 새 산출물 추가 시 이걸 미러링:**
- `core/learning-curate.mjs`: `buildXxxCandidate` 에 `override` 인자 + `status: active`/`generated_by: session-claude`(override 경로), `writeSessionXxx`(mode create/update, 중복판정 우회·항상 publish), `listSessionArtifacts(kind)` 재사용. `KNOWLEDGE_INDEX_FILES` 에 kind→jsonl 매핑 추가.
- `commands/xxx-write.mjs` = `decision-write.mjs` 복제(mode 전달). `list-artifacts.mjs` `VALID_KINDS` 에 kind 추가.
- `templates/commands/task-close.md` 에 해당 산출물 단계 추가(create/update/skip 판단 지시) → `node scripts/build-template-manifest.mjs` 로 SHA resync.
- 테스트 = `core/__tests__/write-session-decision.test.mjs` 복제.

**검증 시 필수(D-26 에서 확정):**
- **CLI e2e 는 `OBSIDIAN_VAULT_ROOT` 를 sandbox 안으로 박을 것.** `obsidian-config.mjs:58-59` 가 config 없으면 글로벌 `C:\Obsidian`(실볼트)을 잡아 오염시킨다. 단위 테스트(captureVault 가짜 writer)는 이 누수를 못 잡으므로 CLI e2e 가 별도 필요.
- **project-local task-close.md 사본은 실제로 존재함**(앞선 "0건"은 glob 경로 실수). slash command 는 `.claude/commands/` 물리 파일이라야 인식 → init 시 templates/ 에서 **복사**됨. 따라서 엔진/CLI(`$CLAUDE_RUNTIME_HOME` shared 참조=자동 동기)와 달리 **지시문 사본은 수동 갱신 전까지 옛 버전 고정.** D-26 후 5개(Pasim62/musicGame/talkSim/productSurveyEngine/magicDraft) 127L 새 버전 교체 완료(.bak 보존). **Talkup/Talkup_test1(29L)은 다른 옛 포맷**(`scripts/runtime/` 로컬 경로, $CLAUDE_RUNTIME_HOME 미사용 — 연동 불완전)이라 제외. **백로그**: slash command 사본 자동 동기 메커니즘 미구현.

**D-26 후속 버그 수정(실전 검증으로 발견·해결):**
- **lesson rules 보일러플레이트 혼입**: `buildLessonCandidate` 가 세션작성(override) 경로에서도 `buildLessonRules`(legacy 휴리스틱, task.guardrails 포함 — `context-resolver.mjs:247` 이 'read read_first notes...' 를 guardrail 로 주입)를 rules 뒤에 합쳐, 세션 lesson 끝에 보일러플레이트 1줄이 섞였음. D-23 "보일러플레이트 0" 위배. **수정**: override 경로면 `legacyRules=[]`(files 폴백은 유지 — 실데이터). 회귀 466 green + guardrails 심은 가짜통과 방지 테스트 추가. Pasim62 실볼트의 오염 lesson 1건은 mode:update 로 재작성해 정리(세션 rule 4개 보존, 오염 1줄만 제거).
- **§1.7 architecture 게이트가 너무 좁음**: "구조를 *바꿨나*"만 물어서, 코드를 안 바꾸는 **분석·계획 task**(비효율 진단/리팩토링 계획/책임 분산 파악)의 구조 발견을 skip 하게 유도. architecture 의 본질은 "변경"이 아니라 "이 시스템이 어떻게 생겼는지의 지도"인데 분석 task 야말로 그 지도를 그리는 활동. **수정**: §1.7 게이트를 "구조를 바꿨거나 / 기존 구조를 새로 이해·문서화했나(분석·계획 task 포함, 코드 미변경도 해당)"로 확장 + 과잉 방지 가드. 5개 사본 동기 + manifest resync. Pasim62 의 놓친 ParticipantManager 좌석 배치 구조는 architecture-write 로 사후 작성(`04_Architecture/Generated/`). **교훈: 게이트 문구가 "변경"에 치우치면 분석 task 의 가치를 놓친다.**

**D-26 2차 실전 검증(두 번째 task close)으로 발견·해결 — 보일러플레이트 근원 차단 + session-id 보강:**
- **guardrail 보일러플레이트가 worklog·lesson·troubleshooting 으로 누수**: `context-resolver.mjs::buildGuardrails` 가 모든 task 에 `read read_first notes before writing a plan` 를 무조건 주입(세션 시작 가이드로는 의미 있음) → task 레코드에 저장 → 산출물 곳곳으로 샘(worklog "건드리면 안 되는 것"=`session-end.mjs:264`, lesson 휴리스틱 rules=`buildLessonRules:159`, troubleshooting Guardrails 섹션). **근원 차단**: `context-resolver.mjs` 에 `READ_FIRST_GUARDRAIL` 상수 + `isBoilerplateGuardrail()` export, 산출물 3곳에서 필터. task-start 컨텍스트 주입(세션 가이드)에는 그대로 둠. (참고: `runtime-doctor.mjs:68`/`rebuild-lessons.mjs:79` 도 이 문자열을 빈-lesson 마커로 사용 중.) 기존 worklog 테스트가 "이 보일러플레이트가 나와야 한다"고 박제돼 있던 걸 "진짜 guardrail 만 나오고 보일러플레이트는 제외"로 정정.
- **session-end `--task-id` 미구현 → fallback task 못 닫음(D-24 잔여)**: hook 쉘이 `CLAUDE_SESSION_ID` 를 안 주입하면 task 가 fallback 세션에 묶여, 진짜 session-id 로는 close 불가(세션이 수동으로 포인터 뒤져 닫음). `session-end.mjs:378` 주석의 "--task-id 별도 보강 예정"을 **구현**: session/findBySession 실패 시 `--task-id` 로 직접 로드(단 현재 프로젝트 내부 + status 미마감일 때만 — D-18 race 방어 불변). 회귀방지 테스트 2개(fallback close / 이미닫힌 task 거부) 추가. **단 근본(hook 의 CLAUDE_SESSION_ID 미주입)은 Claude Code 측 외부 요인이라 미해결** — `--task-id` 는 우회책. **→ D-27 에서 이 우회책을 정식 1차 경로로 격상**: 지시문이 taskId 기억→`--task-id` 종료를 표준 흐름으로 만들어 session_id 외부의존을 통째로 우회. session_id 복구는 시도하지 않기로 결정(동시세션 교차오집 못 막음).
- **worklog "한 일"이 recall 노트로 채워짐 — 3차 검증으로 진단 정정(두 층위 분리)**: 앞서 "외부 한계로 복구 불가"라 적었으나, 3차 task(47c12f97) 이벤트 로그를 까보니 정정 필요. `buildSection1Items`(session-end.mjs)가 section1("이번 세션에서 한 일")을 **3소스 혼합**으로 채움: `taskRecord.files`→`changed:`(실수정), `knowledgeHits`→`참고:`(recall), `readFirst`→`읽음:`(recall). 두 독립 문제가 섞임:
  - **문제 A (표현 결함 — 우리 코드, 고칠 수 있음·미수정)**: 실수정이 0이면 recall 노트(`참고:/읽음:`)만 남아 "한 일"을 도배. recall 한 건 "한 일"이 아니다. **수정안**: section1 을 `changed`(실작업)와 recall(참고 컨텍스트)로 **분리**, 실수정 0이면 "기록된 변경 없음" 명시하고 recall 은 별도 "참고한 컨텍스트" 섹션으로. fallback 여부와 무관하게 분석 task 면 항상 옳은 방향.
  - **문제 B (데이터 손실 — 외부 요인, 별개)**: fallback session-id 묶임 시 실수정이 있어도 추적 0 가능. 단 **47c12f97 은 해당 없음** — 이벤트 로그가 `task_started/session_end_skipped/task_closed` 3개뿐, **파일 수정 이벤트 0개 = 진짜로 코드 안 바꾼 분석 task**(사용자가 착수 직전 중단). 즉 이 worklog 의 빈 "한 일"은 손실이 아니라 사실. B 의 근본(hook 의 CLAUDE_SESSION_ID 미주입)은 여전히 Claude Code 외부 요인.
  - **결론**: "복구 불가"는 부정확했음 — A 는 표현 수정으로 해결 가능(다음 과제), B 만 외부 의존이며 이번 케이스엔 B 영향 없음. 우선순위: **2-C 와 함께 section1 표현 분리.**
- **architecture body `## 개요` 중복**: `buildArchitectureCandidate` 가 `## 개요\n- {summary}` 를 자동 추가하는데 세션이 body 에 또 `## 개요` 를 넣으면 중복. **수정**: 자동 `## 개요` 블록 제거(summary 는 frontmatter 에만), body 전체를 세션이 책임(전체재작성 철학과 일치).
- **468 tests green**(466+2). Pasim62 의 오염 worklog 1건은 보일러플레이트 줄 직접 제거+정상화. 2번째 task 의 lesson/architecture 본체는 품질 양호(보일러플레이트 0 재확인, 반례 중심 rules, 5단계 흐름 추적).

**2-C 후보(이번 범위 밖, 발견된 것):**
- **toDateStamp 날짜 +1 밀림**: task `updatedAt` 이 UTC 자정 직후(KST 자정 근처)면 로컬타임존(KST+9) 변환으로 파일명/frontmatter date 가 하루 밀림. 동작엔 무해(파일명 일관성만).
- **trigger_keywords surrogate 손상**: Pasim62 일부 lesson 의 trigger_keywords 에 깨진 유니코드(surrogate `\udcec`)가 있음. 검색 품질 저하 가능. jsonl 재인코딩 시 Python 에서 터짐(Node 는 OK).
- procedure repeatThreshold 3→2, worklog `--close` 의존 완화, architecture detectArchitectureChanges 자동감지, 기존 draft 방치분 active 재인덱싱.

**다음 단계 우선순위:** ~~(2-B) lesson update/skip + architecture/troubleshooting 세션작성~~ **← D-26 완료**. (2-C) procedure/worklog/architecture-detect 코드로직 + 기존 draft 방치분 active 재인덱싱 + toDateStamp 버그. (3) 검색 경량개선(trigger_keywords 가중+BM25/IDF+char n-gram, 임베딩 seam 예약 — `task-start.mjs:80 buildLessonReadFirst`, relevance `retrieval-scoring.mjs:226`, knowledgeHits `context-resolver.mjs:121` 별도). **재료(산출물)가 멀쩡해진 뒤라야 검색이 의미 있음.**

---

## 5. "다음 세션이 알아야 할 운영 교훈"

### 🎯 교훈 1: init 1회 후 Claude Code 재시작 필수
- Claude Code 세션은 프로젝트 단위로 작동
- `claude-obsidian-runtime` 자기 자신에는 init 하지 않음 (패키지 저장소 오염)
- 각 프로젝트에서 init 후 **Claude Code 재시작**해야 hook 활성화
- 새 init 은 `.claude/settings.local.json` 에 `CLAUDE_RUNTIME_HOME` 을 자동 주입함 (commit `84effc8`)

### 🎯 교훈 2: 구버전 업그레이드는 `--preserve` 모드
- 이미 runtime 설치된 프로젝트는 `init --preserve --no-doctor`
- 기존 manifest/hooks/runtime 데이터 보존 + 누락 폴더만 추가

### 🎯 교훈 3: 빈 프로젝트에 doctor fail 일부는 정상
- Presence 12체크 중 C07/C08 WARN, C12 WARN 은 코드가 아직 없으니 정상
- 실제 코드 생기면 `memory-refresh` 1회로 해소

### 🎯 교훈 4: 세션 종료는 무조건 `/task-close`
- session-end / stop hook 은 **의도적으로 비활성화** (D-18)
- Claude Code v2.1.128+ 가 hook 쉘에 `CLAUDE_SESSION_ID` 를 안 넘겨서 자동 hook 이 빈 id 로 parallel-task pointer 를 망가뜨림
- 사용자가 명시적으로 `/task-close` 슬래시 호출해야 정상 종료. `--verify` 플래그로 invariant 점검 추가 가능

### 🎯 교훈 5: lesson 작성 시 `applicable_when` 채워라
- 비어있으면 모든 task 에 후보로 노출 → noise
- 최소 `language` / `layer` / `task_type` 중 하나는 채울 것 (PRINCIPLES §6-bis)

### 🎯 교훈 6: sub-agent 위임은 lead 만 한다
- Maker-Checker 깨면 평가 자체가 깨짐 (PRINCIPLES §7-bis)
- `delegations.jsonl` 에 누락된 위임은 `eval-routing` 에서 metric 0 으로 잡힘 (D-17)

---

## 6. 지금 새 세션이 자주 받을 질문 TOP 5 + 즉답

### Q1. "이 프로젝트 뭐하는 거야?"
→ §1 + `PRINCIPLES.md` §1 (2-track 메모리)

### Q2. "내 프로젝트에 어떻게 설치해?"
→ `docs/INSTALL.md` §4 + `docs/QUICKSTART.md` §2

핵심 명령어:
```powershell
$env:CLAUDE_RUNTIME_HOME = "C:/JSProj/claude-obsidian-runtime"
cd <your-project>
node "$env:CLAUDE_RUNTIME_HOME/commands/init-project.mjs" --project-id <id> --vault-root <path>
```

### Q3. "doctor가 FAIL 뜨는데?"
→ 빈 프로젝트면 정상 (코드 없어서 C07/C08 WARN). `memory-refresh` 실행 후 재시도.
→ `--json` 모드로 구체 검사:
```powershell
node "$env:CLAUDE_RUNTIME_HOME/commands/doctor.mjs" --full --json --project-dir "$PWD"
```

### Q4. "기존 talkSim 같은 v2 프로젝트 업그레이드?"
→ `--preserve --no-doctor` 플래그로 init 재실행. 기존 데이터 전부 보존.

### Q5. "왜 저장소 구조가 이렇게 복잡해?"
→ `PRINCIPLES.md` §2 (4-Layer 메모리 학술 근거) + §3 (4-channel writeback)

### Q6. "lead 가 뭘 하는 에이전트야?"
→ PM(라우팅) + 큐레이터. PRINCIPLES §7. 모든 sub-agent 위임은 `delegations.jsonl` 에 한 줄 (§7-bis). agentFanoutCap 으로 동시 위임 상한 (§7-tris).

### Q7. "Unity 프로젝트는 어떻게?"
→ 현재 PLAN 단계. `docs/PLAN_UNITY_KIND.md` 참조. 6 mandatory agent 템플릿은 이미 있음 (`templates/agents/_recommended/unity/`). lead 와 `/agents-bootstrap` 에 unity 분기는 들어가 있고, 옵션 카탈로그는 다음 phase.

---

## 7. 건드리면 안 되는 것

| 영역 | 이유 |
|------|------|
| `core/*.mjs` | shared 엔진. 프로젝트 로컬에서 수정 금지 (D-1) |
| `templates/_manifest.json` | 빌드 타임 생성물 (`scripts/build-template-manifest.mjs`에서만) |
| `templates/hooks/runtime-session-end.sh`, `runtime-stop.sh` | **재활성화 금지** (D-18). 안에 `exit 0` 외 추가하면 parallel-task pointer 손상 재발 |
| `delegations.jsonl` 직접 편집 | 평가 metric 신뢰 붕괴. lead 만 append, 사람은 read-only |
| lesson frontmatter `applicable_when` 임의 비우기 | retrieval 게이트 무력화 (§6-bis 위배) |
| 다른 프로젝트의 `.claude/runtime/` | D-1 위배 |
| 다른 프로젝트의 볼트 | D-1 위배 |
| Claude Code 내부 hook 스펙 | Claude Code 팀 담당 |
| Agent Teams (v2.1.32+) | Subagents 모드로 한정 (D-8) |

---

## 8. 환경 전제

- Node.js ≥ 20
- git ≥ 2.40
- Windows: PowerShell 5.1+ (환경변수는 `$env:CLAUDE_RUNTIME_HOME`)
- macOS/Linux: bash (환경변수는 `$CLAUDE_RUNTIME_HOME`)
- Obsidian 앱 (선택. 볼트 편집 시)
- Claude Code v2.x (어느 버전이든 hook만 있으면 동작)

**영구 환경변수 설정** (Windows PowerShell):
```powershell
[System.Environment]::SetEnvironmentVariable(
  'CLAUDE_RUNTIME_HOME',
  'C:/JSProj/claude-obsidian-runtime',
  'User'
)
```
VS Code 완전 재시작 필요.

---

## 9. 이 문서 갱신 주기

- Wave 추가/Step 진행 시 §2 완료 상태 갱신
- 새 Closed Decision 발생 시 §4 추가
- 실전 교훈 누적 시 §5 추가
- 다음 세션 자주 받는 질문 바뀌면 §6 갱신

---

## 10. 버전

| 필드 | 값 |
|------|-----|
| Package | claude-obsidian-runtime v3.3.4 |
| 문서 갱신 | 2026-05-08 |
| 기반 기획서 | eventual-jingling-adleman.md v3.1 + P0~P3 + MANUS S1~S4 |
| 총 테스트 | 436 pass / 0 fail |
| 구현 CLI (commands/) | 25개 |
| core 모듈 (core/, core/memory/, core/eval/) | 33개 |
| 볼트 managed roots | 9개 (기본) |
| hook 정의 | 6개 (활성 4개. session-end/stop 비활성 — D-18) |
| slash commands | 8개 (`/task-start`, `/task-close`, `/agents-bootstrap`, `/reflection-run`, `/architecture-promote`, `/memory-refresh`, `/obsidian-sync`, `/obsidian-health`) |
| sub-agent 카탈로그 | web/cli/data/library 기존 + unity PLAN. `_common/test-writer` + `_common/reflection-agent` 공통 2개. 총 19개 템플릿 |

---

**끝. 이제 분기해서 필요한 문서로 가.**
