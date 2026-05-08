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
