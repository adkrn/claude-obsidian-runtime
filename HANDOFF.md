# HANDOFF — 새 세션을 위한 인수인계 문서

**목적**: 이 프로젝트에 대해 **아무것도 모르는 Claude 세션**이 1분 안에 현재 상태를 파악하고, 기획 의도/사용법/레시피 중 필요한 걸 찾아갈 수 있게 하는 엔트리포인트.

**이 문서를 먼저 읽어라**. 그 다음 상황별로 분기해.

---

## 0. TL;DR (5줄)

1. **이 프로젝트**: `claude-obsidian-runtime` v3.0.0 — Claude Code와 Obsidian을 연동해 프로젝트별 장기기억·학습축적·자동 문서화를 제공하는 **공유 런타임 패키지**.
2. **핵심 철학**: "알고리즘은 shared, 데이터는 project-local" + "Runtime compact / Obsidian curated"
3. **현재 상태**: **설계·구현·검증 전부 완료**. 264/264 tests passing. 실전 배포 가능.
4. **실전 적용 현황**: talkSim은 `--preserve` 모드로 v3 마이그레이션 완료. TalkUp 본체는 대기 중 (Step 8 별도 task).
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

### ✅ 완료된 것

| 단계 | 산출물 | 증거 |
|------|--------|------|
| 기획 | `eventual-jingling-adleman.md` v3.1 (7-section 기획 의도) | SSOT 1100줄 |
| 설계 Phase 1 | Design-A (Wave 1 구현계) + Design-B (doctor) + PATCH_Phase1 | 합격 |
| 설계 Phase 2 | Design-C (4축 평가 프레임) | 합격 |
| 설계 Phase 3 | Exec-D + EXEC_D_PATCH (마이그레이션 체크리스트) | 합격 |
| Wave 1 | `core/memory/` 6개 + `core/eval/` 4개 + doctor/manifest/rollback + learning-capture file_read | 141 tests |
| Wave 2 | 10 commands 승격 + task-start --dry-run + 5 learning-curate builders + doctor.mjs + golden-task-runner | +72 tests (213) |
| Wave 3 | init-project + templates/agents/_lead + install-hooks + 5 eval CLIs + compare-engine | +51 tests (264) |
| 문서화 | docs/INSTALL.md / QUICKSTART.md / FLOW.md | 1,240줄 |

### 🔄 실전 적용 진행중

| 프로젝트 | 상태 |
|---------|------|
| **talkSim** | v3 마이그레이션 완료 (`--preserve` init, 2026-04-23). 9 managed roots + lead.md + golden-tasks 추가됨. legacy scripts 경로는 유지 중 (`legacyScriptsRelativePath: "../runtime/scripts"`) |
| **TalkUp 본체** | **이번 흐름 제외**. Step 8 별도 task로 분리 결정 |
| **Talkup_test1 워크트리** | Exec-D Step 7 대상 (아직 실행 X) |
| **productSurveyEngine** | 빈 프로젝트에 init만 실행된 상태 (코드 0줄). 실제 사용 대기 |

### 📋 남은 작업 (우선순위 순)

1. **Exec-D Step 6**: talkSim에서 3일 관찰 (매일 eval-run 실행, 4축 지표 수집)
2. **Exec-D Step 7**: Talkup_test1 워크트리 검증 (eval-compare vs talksim.json)
3. **Step 8**: TalkUp 본체 마이그레이션 (별도 task. preserveHooks 8개 주의)
4. git commit Wave 1~3 통합 (C3 보고서가 언급한 pending)
5. (미래) Agent Teams v2.1.32+ 승격 (Step 10)
6. (미래) 벡터 검색/임베딩 도입 (Step 10)

---

## 3. 다음 세션이 읽을 순서

질문 유형에 따라 분기해.

### 🤔 "왜 이렇게 만들었나?" / 철학 / 기획 의도

→ [PRINCIPLES.md](./PRINCIPLES.md)

거기서 답 안 나오면:
- 기획서 원본: `C:/Users/adkrn/.claude/plans/eventual-jingling-adleman.md` (v3.1, 1100줄 SSOT)
- §0-1 v2 재검토 결과 (외부 표준 대비)
- §1-1 ~ §1-7 (핵심 기획 의도 7섹션)
- §12-1 ~ §12-7 (Closed Decisions — 재논의 금지)

### 📦 "어떻게 설치해?" / "처음 써보는데"

→ [docs/INSTALL.md](./docs/INSTALL.md) (설치 가이드 8섹션)

→ [docs/QUICKSTART.md](./docs/QUICKSTART.md) (5분 시작 + 체크리스트)

### 🔧 "내부 동작은?" / "코드 어디 있어?"

→ [docs/FLOW.md](./docs/FLOW.md) (세션 라이프사이클, 4-Layer 메모리, 파일 위치 치트시트)

실제 구현 파일:
- `core/` — 엔진 (23개 파일)
- `commands/` — CLI (25개)
- `templates/` — init 시 복사될 뼈대
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

---

## 5. "이 세션에서 진짜 중요했던 교훈" (다음 세션용)

Wave 구현 과정에서 나타난 실전 교훈:

### 🎯 교훈 1: init 1회로 자동 추적 시작
- Claude Code 세션은 프로젝트 단위로 작동
- `claude-obsidian-runtime` 자기 자신에는 init 하지 않음 (패키지 저장소 오염)
- 각 프로젝트에서 init 후 **Claude Code 재시작**해야 hook 활성화
- 현재 이 대화(TalkUp)는 TalkUp runtime에 잡히고 있음

### 🎯 교훈 2: `--preserve` 모드로 구버전 업그레이드
- 이미 runtime 설치된 프로젝트(talkSim 같은)는 `init --preserve --no-doctor`
- 기존 manifest/hooks/runtime 데이터 보존 + 누락 폴더만 추가
- legacy scripts 경로(`legacyScriptsRelativePath`)는 나중에 별도 청산

### 🎯 교훈 3: 빈 프로젝트에 doctor fail 일부는 정상
- Presence 12체크 중 C07/C08 WARN, C12 WARN은 **코드가 아직 없으니 정상**
- 실제 코드 생기면 `memory-refresh` 1회로 해소
- `doctor --full --since-init`이 fail 2건 나와도 기본값 상태라 허용

### 🎯 교훈 4: 병렬 Wave 실행의 가치
- Wave 1 (3세션 동시) → Wave 2 (A2 단독 + B2/C2 병렬) → Wave 3 (3세션 동시)
- 총 7세션으로 구현 완료 (순차였으면 25~30시간)
- 각 세션에 "담당 파일 + 수정 금지 파일" 명시가 충돌 0건의 비결

### 🎯 교훈 5: 검증 가능한 설계서 작성법
- 각 설계서에 **Z-1 기획 의도 매핑 + Z-2 AC 검증 + Z-3 가정/미결정** 강제
- 검증자(Claude 또는 사람)가 Z 섹션만 교차 확인으로 판정 가능
- 이 덕에 Blocking 이슈 조기 발견 (PATCH_Phase1, EXEC_D_PATCH)

### 🎯 교훈 6: 실측 검증 > 보고서 신뢰
- "보고서에 X라고 써있다" ≠ "X가 실제로 동작한다"
- Wave 완료마다 `node --test` + E2E 실행 필수
- 실측 증거: `/tmp` 프로젝트 init → 9 roots 생성 → doctor 12체크 실행까지

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

---

## 7. 건드리면 안 되는 것

| 영역 | 이유 |
|------|------|
| `core/*.mjs` | shared 엔진. 프로젝트 로컬에서 수정 금지 (D-1) |
| `templates/_manifest.json` | 빌드 타임 생성물 (`scripts/build-template-manifest.mjs`에서만) |
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
| Package | claude-obsidian-runtime v3.0.0 |
| 문서 생성 | 2026-04-23 |
| 기반 기획서 | eventual-jingling-adleman.md v3.1 |
| 총 테스트 | 264 pass / 0 fail |
| 구현 CLI | 25개 |
| core 모듈 | 23개 |
| 볼트 managed roots | 9개 (기본) |
| hook core | 6개 |

---

**끝. 이제 분기해서 필요한 문서로 가.**
