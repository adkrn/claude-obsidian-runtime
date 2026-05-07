# Manus 흡수 — 핵심 설계 원칙 (검증 가능 형태)

**문서 ID**: MANUS-DERIVED-PRINCIPLES
**상위 문서**: [PRINCIPLES.md](../PRINCIPLES.md) (위배 금지)
**입력**: [docs/MANUS_AI_ANALYSIS.md](./MANUS_AI_ANALYSIS.md)
**용도**: 본 문서를 입력으로 **세부 설계서(DESIGN_*.md)**를 작성하고, 작성된 설계서가 본 문서의 원칙·체크리스트에 부합하는지 자기검증한다.

---

## 1. 메타데이터

```yaml
- 문서 ID: MANUS-DERIVED-PRINCIPLES
- 작성일: 2026-05-07
- 작성 기준: docs/MANUS_AI_ANALYSIS.md (작성일 시점)
- 검증 대상: 본 문서 §3, §4, §6의 원칙/체크리스트
- 검증 대상 아님: 구현 코드, Wave별 일정, 변경 파일 목록 (분석 문서/세부 설계서 영역)
- 상위 문서: PRINCIPLES.md (SSOT, 위배 금지)
- 폐기 조건: PRINCIPLES.md가 본 문서와 모순되게 갱신될 경우 본 문서 폐기 (PRINCIPLES.md 우선)
```

---

## 2. 적용 범위 (In-Scope / Out-of-Scope)

### In-Scope — 본 문서 원칙이 적용되는 영역

- 분석 문서 §3-2(HIGH)·§3-3(MED)·§4-3(예방책)에서 **흡수하기로 결정된 항목**의 세부 설계서
- 즉 분석 문서에 🟢 HIGH 또는 🟡 MED로 표시된 항목 (B, E, F, H, §4-A, §4-B, A+G, C, D, I)
- 위 항목들의 변경이 닿는 컨텍스트 주입·retrieval·event 직렬화·worklog 자동화 영역

### Out-of-Scope — 본 문서가 다루지 않음

- 분석 문서 §3-4의 **SKIP 항목** (Linux 샌드박스, 27개 도구, Wide Research, CodeAct, Datasource module)
- 본 프로젝트의 **기존 4-Layer 메모리 / 2-track / Draft-first / 3축 스코어링** 자체 (PRINCIPLES.md §2~§6 영역)
- **분석 문서 §11 Open Questions** (운영 데이터로 30일 후 결정)
- 본 프로젝트의 init/doctor/managedRoots 같은 인프라 (HANDOFF.md D-1~D-15 영역)

위 경계에 해당하면 검증 시 즉답: **"이 원칙은 본 영역에 적용 안 됨. PRINCIPLES.md 또는 HANDOFF.md를 보라."**

---

## 3. 상위 원칙 5개 (P-M1 ~ P-M5)

Manus 흡수의 **횡단 관통 원칙**. 모든 세부 설계서가 동시에 만족해야 한다.

선정 기준: 흡수 항목 다수에 공통 적용 + 컨텍스트 텍스트 inspect로 위배 판정 가능 + PRINCIPLES.md와 명백 중복 아님.

### P-M1: 컨텍스트 주입은 "최근"이 아니라 "현재 작업과의 의미 매칭"으로 결정한다

**근거**: 분석 §3-2 B "단순 시간 기반 top-N은 무관 에러로 컨텍스트 오염 + few-shot 함정 자체 유발". §3-3 C "구조 균일 → 패턴 모방 → 취약".

**적용 시점**: session-start 컨텍스트 블록을 만드는 모든 설계서, retrieval 게이트를 도입하는 모든 설계서.

**위배 신호** (검증 가능):
- [ ] 설계서가 "최근 N개"만으로 주입 항목을 결정한다 (시간만 사용)
- [ ] 설계서가 작업/스코프와 무관한 항목을 무조건 주입한다 (관련성 게이트 부재)
- [ ] retrieval에 jaccard·token 매칭 등 의미 신호 단계가 없다
- [ ] 주입 결과가 동일 task에서 매 세션 다른 항목으로 바뀐다 (안정성 부재)

**예외 조건**: 데이터 부족(예: 항목 < 5개)일 때 **명시적 fallback**으로 시간 기반 top-N 사용 OK. 단 fallback임을 설계서에 명기.

---

### P-M2: 에러는 폐기 자원이 아니라 retrievable 학습 자원이다

**근거**: 분석 §3-2 B "실패 trace의 LLM 재주입 정책 부재", Manus 7원칙 ⑤ "true agency = 에러 복구", 분석 §3-2 E "verify→fix→alternative→escalate 4단계".

**적용 시점**: 에러 처리·hook 실패·retry 정책을 다루는 모든 설계서, errors.jsonl 또는 L4 Reflective 연결을 다루는 설계서.

**위배 신호** (검증 가능):
- [ ] 설계서가 실패 trace를 events.jsonl 외 어디에도 쓰지 않고 다음 세션에 잊혀지게 한다
- [ ] 자동 재시도가 **동일 도구·동일 인자**로 반복된다 (인자 수정/대안 단계 없음)
- [ ] retry cap이 명시되지 않는다 (무한 루프 가능)
- [ ] 4단계(verify / fix / alternative / escalate) 중 하나 이상 누락
- [ ] 에러 retrieval이 L4 Reflective와 cross-link되지 않는다 (사람이 점프 못 함)

**예외 조건**: 없음. 에러는 항상 retrievable + 4단계 + cap.

---

### P-M3: Append-only + 결정론적 직렬화로 캐시 안정 prefix를 보호한다

**근거**: 분석 §1-11 "3대 핵심 규칙 — Append-only / Chronological / Deterministic serialization", §3-3 D "session_id가 첫 줄에 오면 그 뒤 모든 prefix 매칭 깨짐", Manus 7원칙 ① "캐시 hit/miss 10배 비용 차이".

**적용 시점**: events.jsonl·worklog·session-start `additionalContext` 등 직렬화 산출물을 만드는 모든 설계서, JSON 출력을 emit하는 모든 헬퍼 설계서.

**위배 신호** (검증 가능):
- [ ] 설계서가 과거 event/worklog 항목을 **수정 또는 재정렬**한다 (append 외 동작)
- [ ] JSON 출력에 키 정렬 보장이 없다 (객체 생성 순서 의존)
- [ ] array 출력 순서가 비결정적이다 (정렬 키 없이 dump)
- [ ] 동적 정보(session_id, 타임스탬프)가 정적 prefix **앞에** 배치된다
- [ ] 동일 task에서 두 번 호출 시 출력 prefix가 일치하지 않는다

**예외 조건**: 명시적으로 "이 섹션은 매 세션 변동 의도" 라벨이 붙은 영역(예: `## Session Volatile`)은 prefix 안정성 평가에서 제외.

---

### P-M4: Full은 영속 파일에, 컨텍스트엔 reference만 (Dual Representation)

**근거**: 분석 §1-8 "context window는 RAM, file system은 disk", §1-11 "Recent → Stale → Summary 3단계 lifecycle, stale 이후엔 path reference만", §3-3 I.

**적용 시점**: 큰 observation을 다루는 설계서, events.jsonl payload·worklog summary·session-start 주입 텍스트를 다루는 설계서.

**위배 신호** (검증 가능):
- [ ] 큰 raw payload(읽은 파일 본문, 웹페이지 등)가 컨텍스트 텍스트에 그대로 들어간다
- [ ] 컨텍스트엔 path reference가 있는데 **원본 파일이 영속 위치에 없다** (lossless 위배)
- [ ] reference만 보고 다시 원본을 읽을 방법이 없다 (path 누락 또는 hash mismatch)
- [ ] Stale 또는 Summary 단계에서 full text가 컨텍스트로 끌려 들어온다

**예외 조건**: 1줄 요약 또는 schema 필드(modifiedFileCount 등)는 reference 없이 컨텍스트 직접 OK. 단 schema 정의가 설계서에 명시될 것.

---

### P-M5: Scope-gated 주입 — 무조건 주입 금지, 조건 충족만 컨텍스트 진입

**근거**: 분석 §1-3 "Knowledge module은 scope 정의 + 내용. 조건 충족 시에만 채택", §3-2 F "lesson frontmatter `applicable_when`을 retrieval 게이트로 격상".

**적용 시점**: lesson·error·decision 등 **조건부 자료**를 컨텍스트에 주입하는 모든 설계서, retrieval-scoring을 호출하는 설계서.

**위배 신호** (검증 가능):
- [ ] 설계서가 모든 항목을 동등하게 주입한다 (scope/path/keyword 게이트 부재)
- [ ] `applicable_when`이 정의돼 있는데 retrieval 시점에 평가되지 않는다
- [ ] 게이트 통과 기준(`path_glob` / `trigger_keywords` / `scope_id`)이 설계서에 명시되지 않는다
- [ ] 빈 `applicable_when`에 대한 backward-compat 정책이 없다 (마이그레이션 부담 폭발)

**예외 조건**: 빈 `applicable_when` = "always applicable" 정책은 backward-compat용으로 허용. 신규 작성은 강제.

---

## 4. 흡수 항목별 원칙

분석 문서의 흡수 결정 항목 11개. 각 항목은 P-M1~P-M5 상위 원칙 일부에 매핑되며, 자체 위배 신호를 추가로 가진다.

> **변경 파일 목록은 본 문서에 옮기지 않는다** — 분석 문서/세부 설계서가 SSOT.

### 항목 B: 작업 관련(context-relevant) 에러 주입

**분석 문서 출처**: §3-2 B
**상위 원칙 매핑**: P-M1 (관련성), P-M2 (에러 학습), P-M5 (scope-gated)

**원칙**:
- 에러는 raw event(L1)와 **별도로** retrievable index(예: errors.jsonl)에 정규화한다
- 주입 신호는 시간이 아니라 **현재 task의 scope ∪ readFirst tokens ∪ prompt tokens**이다
- 매칭은 retrieval-scoring 3축(Recency + Importance + Relevance)을 재사용한다
- 데이터 부족(에러 < 5개)일 때 시간 기반 top-N **fallback** 명시 (fallback임을 설계서에 명기)
- 주입된 에러는 L4 Reflective 경로와 **cross-link** (사람 점프 가능)

**위배 신호** (검증 가능):
- [ ] errors.jsonl 또는 동급 retrievable layer가 정의되지 않는다
- [ ] 주입 결정이 시간 기반 top-N만 사용한다 (3축 스코어링 미사용)
- [ ] 데이터 부족 fallback 정책이 없거나 fallback이 아닌 default로 동작한다
- [ ] 에러 발생 시점의 active scope가 errors.jsonl에 보존되지 않는다 (사후 추론으로 채움)
- [ ] 주입 포맷이 raw trace 본문을 포함한다 (P-M4 위배, 1줄 요약+경로 원칙 어김)

**검증 시 보아야 할 산출물**:
- errors.jsonl 스키마 정의 (필드명·타입)
- session-start의 "Related Past Failures" 주입 블록 포맷
- L4 Reflective `linkedReflectionPath` 필드 처리 로직

**의존성 / 시너지**: F 항목과 `applicable_when` 게이트 인프라 공유 (분석 §3-2 F).

---

### 항목 E: 에러 처리 4단계 프로토콜

**분석 문서 출처**: §3-2 E + Manus rules §1-6
**상위 원칙 매핑**: P-M2 (에러 학습)

**원칙**:
- 에러 발생 시 순서: **verify(인자/이름) → fix(메시지 해석) → alternative(대안 도구) → escalate(사용자 ask)**
- 동일 도구 + 동일 인자 재시도 **금지** (인자 수정 또는 대안만)
- retry cap = **3회**. 초과 시 자동 escalate + L4 Reflective draft 생성
- runtime episodic event에 `recovery_attempts: N` 필드 기록

**위배 신호** (검증 가능):
- [ ] 4단계 중 하나라도 누락 (verify / fix / alternative / escalate)
- [ ] 동일 도구·동일 인자 재시도가 가능한 흐름이 존재한다
- [ ] retry cap이 명시되지 않거나 3회보다 크다
- [ ] cap 초과 시 사용자 escalate(`[ASK]` 패턴) 또는 reflection draft 생성 단계가 없다
- [ ] events.jsonl의 `recovery_attempts` 필드 누적이 정의되지 않는다

**검증 시 보아야 할 산출물**:
- `templates/agents/_lead.md`의 "에러 마주치면" 섹션 텍스트
- episodic-writer의 `recovery_attempts` 필드 처리

**의존성 / 시너지**: B 항목 (recovery_attempts가 errors.jsonl `recoveryAttempts` 필드의 source).

---

### 항목 F: `applicable_when`을 retrieval 게이트로 격상

**분석 문서 출처**: §3-2 F
**상위 원칙 매핑**: P-M5 (scope-gated)

**원칙**:
- frontmatter `applicable_when`은 **lead 경고 대상이 아니라 retrieval 게이트**로 격상
- 게이트 항목 3개: `path_glob` / `trigger_keywords` / `scope_id`
- 게이트 미통과 항목은 score 계산에서 **제외 또는 강한 패널티**
- 빈 `applicable_when` = "always applicable" (backward-compat). 신규 작성만 채움 강제

**위배 신호** (검증 가능):
- [ ] retrieval-scoring이 `applicable_when` 평가 단계 없이 모든 항목을 동등 처리한다
- [ ] 3개 게이트(`path_glob`/`trigger_keywords`/`scope_id`) 중 하나 이상 누락
- [ ] backward-compat 정책이 명시되지 않는다 (기존 lesson 마이그레이션 폭발 위험)
- [ ] 신규 lesson 작성 시 빈 `applicable_when`이 허용된다 (lead 경고 부재)

**검증 시 보아야 할 산출물**:
- `core/memory/retrieval-scoring.mjs`의 `scoreItem` 게이트 평가 단계
- `templates/vault/08_Lessons/_TEMPLATE.md`의 frontmatter 스키마

**의존성 / 시너지**: B 항목과 게이트 로직 재사용. C 항목(MMR)과 호출 위치 동일.

---

### 항목 H: notify vs ask 이분법

**분석 문서 출처**: §3-2 H + Manus §1-5
**상위 원칙 매핑**: 단독 (단순 컨벤션)

**원칙**:
- lead가 사용자에게 출력하는 모든 메시지는 **`[NOTIFY]`(non-blocking) 또는 `[ASK]`(blocking)** prefix를 가진다
- `[ASK]`는 "essential한 결정/입력 필요 시"만 사용 (사용자 방해 최소화 원칙)
- `[NOTIFY]`는 진행 보고·승격 후보 알림 등 reply 기대 안 함

**위배 신호** (검증 가능):
- [ ] lead 출력 가이드에 prefix 컨벤션이 없다
- [ ] `[ASK]` 사용 기준이 "essential한 결정/입력"으로 명시되지 않는다
- [ ] 진행 보고·정보 전달이 `[ASK]`로 잘못 사용되는 예시가 가이드에 있다

**검증 시 보아야 할 산출물**:
- `templates/agents/_lead.md`의 메시지 컨벤션 섹션

---

### 항목 §4-3-A: task-close 검증 게이트 (Hallucinated success 예방)

**분석 문서 출처**: §4-3-A
**상위 원칙 매핑**: P-M2 (실패 보존, draft-first 강화)

**원칙**:
- `task-close`는 **`--verify`가 기본 ON**. doctor 일부 체크 자동 실행
- 검증 실패 시 worklog 상단에 **`⚠️ unverified` 배지** + L4 Reflective draft 자동 생성
- modifiedFiles 존재만으로 "성공" 판정 **금지**

**위배 신호** (검증 가능):
- [ ] task-close가 검증 단계 없이 worklog를 "성공"으로 표시한다
- [ ] `--verify` 기본값이 OFF이다
- [ ] 검증 실패 시 unverified 배지 또는 reflection draft 생성 단계 누락
- [ ] 어떤 doctor 체크를 실행하는지 설계서에 열거되지 않는다 (검증 범위 모호)

**검증 시 보아야 할 산출물**:
- `commands/task-close.mjs` 의 verify 분기 로직
- worklog 상단 배지 포맷

---

### 항목 §4-3-B: frontmatter 백업/검증 (Destroyed metadata 예방)

**분석 문서 출처**: §4-3-B
**상위 원칙 매핑**: P-M3 (append-only — 자동 갱신이 사람 영역 파괴 금지)

**원칙**:
- A-Mem evolution 등 **frontmatter 자동 갱신 전 원본 hash 저장**
- 갱신 후 11필드 모두 존재 확인 (parser 검증)
- 누락 시 **자동 rollback** + L4 Reflective draft

**위배 신호** (검증 가능):
- [ ] evolution 전 hash 저장 단계가 없다
- [ ] 갱신 후 11필드 검증 단계가 없다 (parser 통과만으로 OK 처리)
- [ ] 검증 실패 시 rollback 동작이 없다 (파괴된 상태 그대로 commit)
- [ ] rollback 후 reflection draft 생성이 없다 (사일런트 실패)

**검증 시 보아야 할 산출물**:
- `core/memory/memory-evolution.mjs`의 hash 저장 + 검증 + rollback 분기

---

### 항목 A+G: Current_Todo.md (번호 pseudocode + live recitation) — 분리안 확정

**분석 문서 출처**: §3-3 A+G
**상위 원칙 매핑**: P-M3 (append-only — 자동 영역과 사람 영역 분리), Draft-first(D-5)

**원칙**:
- **분리안 확정** — `Current_Focus.md`(사람 수동) + `Current_Todo.md`(자동, 시스템 전용) 2파일
- Current_Todo.md는 **번호 pseudocode + status** 포맷 (자유 텍스트 금지)
- frontmatter `auto_managed: true` + 파일 상단 "수동 편집 금지" 경고 명기
- PostToolUse hook의 자동 체크는 **항목 description의 명시 키워드(파일 경로/함수명) 일치 시만** (보수적 매칭)
- task 없을 때 빈 상태 또는 archive (자동 누적 금지)

**위배 신호** (검증 가능):
- [ ] Current_Focus.md를 자동 갱신 대상으로 포함시킨다 (사람 영역 침범)
- [ ] Current_Todo.md 포맷이 번호 pseudocode가 아니다 (자유 텍스트 또는 prose)
- [ ] frontmatter `auto_managed: true` 또는 수동 편집 금지 경고가 누락
- [ ] 자동 체크 매칭 기준이 모호하다 (description 키워드 외에도 매칭)
- [ ] task 미존재 시 동작이 정의되지 않는다

**검증 시 보아야 할 산출물**:
- Current_Todo.md 템플릿 + frontmatter 스키마
- PostToolUse hook의 매칭 키워드 규칙
- task-start의 초기 list 생성 + task-close의 carry-over 로직

**의존성 / 시너지**: §4-3-B (자동 frontmatter 영역 분리 원칙 공통).

---

### 항목 C: readFirst diversity penalty (MMR) + cache-friendly 정렬

**분석 문서 출처**: §3-3 C
**상위 원칙 매핑**: P-M1 (관련성·few-shot 함정 회피), P-M3 (cache-friendly 정렬)

**원칙**:
- top-N 선정 시 이미 선택된 항목과 **jaccard 유사도 ≥ 0.7이면 score 패널티** (MMR 변형)
- manifest `retrievalWeights.diversityLambda` 추가, 시작값 0.2~0.3
- 선정은 score 기준, **출력은 path 사전순** (score 변동 시에도 출력 순서 안정 → cache hit ↑)
- 기본값은 보수적으로 시작, 30일 운영 후 χ² 튜닝(§11 Open Questions)

**위배 신호** (검증 가능):
- [ ] top-N 선정에 diversity penalty가 없다 (균일 컨텍스트 그대로 유지)
- [ ] 출력 순서가 score 그대로다 (score 변동 시 prefix 깨짐)
- [ ] `diversityLambda`가 manifest 확장 필드로 노출되지 않는다 (튜닝 불가)

**검증 시 보아야 할 산출물**:
- `retrieval-scoring.mjs` 또는 readfirst-builder의 MMR 단계
- manifest `retrievalWeights` 스키마

**의존성 / 시너지**: D 항목과 cache-friendly 정렬 인프라 공유.

---

### 항목 D Phase 1-3: KV-cache 친화 prefix 안정화

**분석 문서 출처**: §3-3 D Phase 1-3
**상위 원칙 매핑**: P-M3 (append-only + 결정론적 직렬화), P-M4 (정적/동적 분리)

**원칙**:
- `[Runtime Session Context]` 출력 구조: **`Project Identity` → `Task Context` → `Session Volatile` → `Recent Failures`** 순서 (Static-first, Dynamic-last)
- session_id·타임스탬프 등 **반드시 변하는 정보**는 `## Session Volatile` 섹션에 격리
- 모든 array 출력은 **결정론적 정렬** (사전순 또는 score → path tiebreak)
- 모든 JSON 출력은 **키 사전순 정렬** (`stableStringify` 헬퍼 도입)
- task 없으면 `Task Context` 섹션 통째로 omit (조건부 누락이 prefix 변경보다 깨끗)

**위배 신호** (검증 가능):
- [ ] 출력 첫 줄에 session_id 또는 timestamp가 온다 (P-M3 위배 핵심 패턴)
- [ ] 정적·준정적·동적 정보가 한 섹션에 혼재한다
- [ ] array 정렬이 비결정적이다 (Map iteration 순서, 객체 키 순서 의존)
- [ ] JSON 직렬화가 sorted-key 보장 없이 `JSON.stringify` 직접 사용
- [ ] 동일 task 두 번째 호출 시 prefix가 첫 번째와 일치하지 않는다

**검증 시 보아야 할 산출물**:
- `commands/session-start.mjs`의 `buildAdditionalContext` 출력 구조
- `core/cache-stable-stringify.mjs` (또는 동급 헬퍼) 사양
- 동일 task 두 번 호출 시 출력 prefix 일치를 검증하는 테스트

**의존성 / 시너지**: B 항목(Recent Failures 섹션이 D의 출력 구조 안에 들어감), C 항목(cache-friendly 정렬), I 항목(large observation 요약 표시 위치).

---

### 항목 D Phase 4: cache hit rate 측정·가시화

**분석 문서 출처**: §3-3 D Phase 4
**상위 원칙 매핑**: P-M3 (가설 검증)

**원칙**:
- `cache_read_input_tokens` / `(cache_read + cache_creation + input)` 비율을 **세션별 측정**
- 임계: Phase 1-3 적용 후 **hit rate ≥ 70%** 목표
- Claude Code transcript usage 메타데이터 노출 여부 **spike 선행** (노출 안 되면 PostToolUse hook 등 wrapper 도입)

**위배 신호** (검증 가능):
- [ ] 측정 가능성 spike 없이 dashboard 설계로 진입 (가능성 미확인)
- [ ] hit rate 계산식이 정의되지 않는다
- [ ] 임계 70%가 명시되지 않는다 (효과 검증 기준 부재)
- [ ] spike 결과가 부정적일 때 대안(Phase 1-3만 무측정 적용)이 정의되지 않는다

**검증 시 보아야 할 산출물**:
- transcript usage 노출 여부 spike 결과 보고
- `commands/cache-stats.mjs` 또는 동급 측정 진입점

**의존성 / 시너지**: Phase 1-3가 선행. 측정만 별도 spike.

---

### 항목 I: Stale → Reference 압축 (Dual Representation)

**분석 문서 출처**: §3-3 I
**상위 원칙 매핑**: P-M4 (Dual Representation 핵심)

**원칙**:
- events.jsonl payload가 **임계 N KB 이상**이면 별도 파일(`runtime/events/blobs/<hash>.txt`)로 off-load
- events.jsonl엔 `payload_ref: "blobs/<hash>.txt"` reference만 유지
- 압축 임계는 manifest 확장으로 조정 가능
- session-start 주입에 직전 큰 observation은 `last_observation: <type> @ <path> (size=N KB)` 형태로 표시 (full text 금지)
- 압축은 **lossless** — reference로 원본 read 가능해야 함
- jsonl 파싱(eval, retrieval, replay)이 모두 `payload_ref`를 처리하도록 일관성 확보

**위배 신호** (검증 가능):
- [ ] off-load 임계가 명시되지 않는다 (manifest 노출 부재)
- [ ] payload_ref만 있고 원본 파일 위치 보장이 없다 (lossless 깨짐)
- [ ] eval/retrieval/replay 중 payload_ref를 인식하지 못하는 경로가 있다
- [ ] session-start 주입에 large observation의 raw text가 포함된다

**검증 시 보아야 할 산출물**:
- `core/event-aggregator.mjs` 또는 `episodic-writer.mjs`의 off-load 분기
- jsonl 파싱 로직(eval/retrieval/replay)에서 `payload_ref` 해석

**의존성 / 시너지**: D Phase 1-3와 session-start 주입 위치 공유. Wave C로 분류 (시급도 낮음, 운영 데이터 누적 후).

---

## 5. 기존 PRINCIPLES.md와의 관계

본 문서 신규/강화 원칙이 기존 PRINCIPLES.md와 정렬/강화/신규 어디인지.

| 흡수 항목 / 원칙 | PRINCIPLES.md 대응 섹션 | 관계 | 비고 |
|----------------|---------------------|------|------|
| P-M1 (관련성 ≫ 시간) | §6 3축 retrieval 스코어링 | **강화** | 에러로 retrieval 대상 확장. 3축 인프라 재사용 |
| P-M2 (에러 = 학습 자원) | §4 L4 Reflective | **강화** | retrievable index(errors.jsonl) + 4단계 프로토콜 추가 |
| P-M3 (append-only + 결정론) | §4 L1 Episodic | **강화** | 직렬화 정렬·prefix 안정화 명시 추가 |
| P-M4 (Dual Representation) | §2 2-track | **정렬** | "Runtime compact / Obsidian curated" 자체가 dual. event 내부에도 적용 확장 |
| P-M5 (scope-gated 주입) | §6 3축 + §3 Draft-first | **강화** | `applicable_when`을 게이트로 격상하는 구체화 |
| 항목 B (errors.jsonl) | §4 L1+L4 | **강화** | L1.5 retrievable layer 명명 |
| 항목 E (4단계 프로토콜) | §14 위배 증상 표 | **신규** | retry/escalate 표준 자체가 신규 |
| 항목 F (게이트 격상) | §6, §7 lead 큐레이터 | **강화** | lead "경고만"에서 retrieval 게이트로 진화 |
| 항목 H (notify vs ask) | §7 lead 능동 큐레이터 | **신규** | 메시지 prefix 컨벤션 자체가 신규 |
| §4-3-A (task-close verify) | §3 Draft-first | **강화** | hallucinated success 예방 명분 + 구체 게이트 |
| §4-3-B (frontmatter 검증) | §5 A-Mem 진화 + §14 | **강화** | 자동 갱신이 사람 영역 파괴 금지 명시 |
| 항목 A+G (Current_Todo) | §3 4-channel + Draft-first | **강화** | 자동/사람 영역 2파일 분리 명시 |
| 항목 C (MMR + 정렬) | §6 3축, §11 Open | **강화** | diversity 축 + cache-friendly 정렬 추가 |
| 항목 D Phase 1-3 (prefix 안정화) | §4 L1 Episodic | **신규** | KV-cache 보호를 위한 prefix 구조 자체가 신규 |
| 항목 D Phase 4 (측정) | §11 Open Questions | **신규** | cache hit rate 측정 자체가 신규 |
| 항목 I (Stale 압축) | §2 2-track + §4 L1 | **강화** | event 내부 dual 압축 추가 |

**신규 4건** (E, H, D Phase 1-3, D Phase 4) — 5건 미만이므로 PRINCIPLES.md 학술 표준 기반 유지에 부합.
**강화 11건** — 기존 원칙의 구체화·확장.
**정렬 1건** — 이미 같은 메시지 (P-M4 ↔ §2 2-track).

---

## 6. 검증 체크리스트

**다른 세션이 작성한 세부 설계서를 검증할 때 사용하는 단일 체크리스트.**

위에서 아래로 훑으면 위배 여부 판정 가능. 각 체크박스는 예/아니오 답이 가능해야 한다.

### 6-A. 횡단 원칙 (P-M1 ~ P-M5) — 모든 설계서 적용

#### P-M1 관련성 ≫ 시간
- [ ] 주입 항목 결정에 **현재 작업과의 의미 신호**(jaccard / token / scope 매칭)가 포함되는가?
- [ ] 시간만으로 결정하는 흐름이 아닌가? (시간 사용 시 fallback 라벨 부착됐는가?)
- [ ] 데이터 부족 시 fallback 정책이 **명시적으로 fallback임을 표기**하는가?

#### P-M2 에러 = 학습 자원
- [ ] 실패 trace가 다음 세션에 retrievable한가? (events.jsonl 외 인덱스 또는 L4 link)
- [ ] 자동 재시도가 **동일 도구·동일 인자 금지** 규칙을 가지는가?
- [ ] retry cap(권장 3)이 명시됐는가?
- [ ] 4단계(verify / fix / alternative / escalate) 모두 정의되는가?

#### P-M3 Append-only + 결정론
- [ ] 과거 event/worklog 항목 수정 또는 재정렬이 없는가?
- [ ] JSON 출력이 sorted-key를 보장하는가? (`stableStringify` 또는 동급)
- [ ] array 출력 순서가 결정적인가? (정렬 키 명시)
- [ ] 정적 정보가 동적 정보 **앞**에 배치되는가?

#### P-M4 Dual Representation
- [ ] 큰 raw payload가 컨텍스트에 직접 들어가지 않는가?
- [ ] reference만 있는 항목의 **원본 영속 위치**가 보장되는가? (lossless)
- [ ] reference로 원본 다시 read 가능한가? (path 누락 없음)

#### P-M5 Scope-gated 주입
- [ ] 조건부 자료의 게이트(`path_glob` / `trigger_keywords` / `scope_id`)가 retrieval 시점에 평가되는가?
- [ ] 빈 `applicable_when`에 대한 backward-compat 정책이 있는가?
- [ ] 게이트 통과 기준이 설계서에 명시되는가?

---

### 6-B. 항목별 — 해당 항목에만 적용

#### 설계서 대상이 B (작업 관련 에러 주입)이면
- [ ] errors.jsonl(또는 동급) 스키마 필드가 정의되는가? (id / timestamp / tool / scope / tokens / recoveryAttempts / linkedReflectionPath)
- [ ] 주입 신호가 task scope ∪ readFirst tokens ∪ prompt tokens인가?
- [ ] retrieval-scoring 3축이 재사용되는가? (별도 알고리즘 도입 금지)
- [ ] 에러 < 5개일 때 시간 기반 top-3 fallback이 명시되는가?
- [ ] 주입 포맷이 1줄 요약 + 경로인가? (raw trace 본문 금지)
- [ ] L4 Reflective `linkedReflectionPath` cross-link이 명시되는가?

#### 설계서 대상이 E (4단계 프로토콜)이면
- [ ] verify → fix → alternative → escalate 4단계 모두 정의되는가?
- [ ] 동일 도구·동일 인자 재시도가 명시적으로 금지되는가?
- [ ] retry cap = 3회가 명시되는가?
- [ ] cap 초과 시 `[ASK]` 패턴 사용자 escalate + L4 Reflective draft 생성이 정의되는가?
- [ ] events.jsonl `recovery_attempts` 필드 누적이 정의되는가?

#### 설계서 대상이 F (applicable_when 게이트)이면
- [ ] retrieval-scoring `scoreItem`에 게이트 평가 단계가 추가되는가?
- [ ] 3개 게이트(`path_glob` / `trigger_keywords` / `scope_id`) 모두 정의되는가?
- [ ] 미통과 항목의 처리 방식(제외 / 강한 패널티)이 명시되는가?
- [ ] 빈 `applicable_when` = "always applicable" 정책이 backward-compat 명시되는가?
- [ ] 신규 lesson에는 `applicable_when` 채움이 강제되는가? (lead 경고 또는 doctor 체크)

#### 설계서 대상이 H (notify vs ask)이면
- [ ] `[NOTIFY]` / `[ASK]` prefix 컨벤션이 lead 가이드에 명시되는가?
- [ ] `[ASK]` 사용 기준이 "essential한 결정/입력"으로 한정되는가?
- [ ] `[NOTIFY]`/`[ASK]` 잘못된 사용 예시가 가이드에 있는가? (혼란 예방)

#### 설계서 대상이 §4-3-A (task-close verify)이면
- [ ] `--verify` 기본값이 ON인가?
- [ ] 어떤 doctor 체크를 실행하는지 열거되는가? (검증 범위 명시)
- [ ] 검증 실패 시 worklog 상단 `⚠️ unverified` 배지 추가가 정의되는가?
- [ ] 검증 실패 시 L4 Reflective draft 자동 생성이 정의되는가?
- [ ] modifiedFiles 존재만으로 "성공" 판정하지 않는가?

#### 설계서 대상이 §4-3-B (frontmatter 백업/검증)이면
- [ ] evolution 전 원본 hash 저장이 정의되는가?
- [ ] 갱신 후 11필드 모두 존재 확인이 정의되는가?
- [ ] 누락 시 자동 rollback이 정의되는가?
- [ ] rollback 후 L4 Reflective draft 생성이 정의되는가?

#### 설계서 대상이 A+G (Current_Todo.md)이면
- [ ] Current_Focus.md(사람) + Current_Todo.md(자동) **2파일 분리**가 유지되는가?
- [ ] Current_Todo.md 포맷이 **번호 pseudocode + status**인가? (자유 텍스트 금지)
- [ ] frontmatter `auto_managed: true` + 수동 편집 금지 경고가 명시되는가?
- [ ] PostToolUse 자동 체크 매칭이 description 명시 키워드(파일 경로/함수명)에 한정되는가?
- [ ] task 미존재 시 동작(빈 상태 또는 archive)이 정의되는가?
- [ ] task-close에서 미완 항목 carry-over + 초기화가 정의되는가?

#### 설계서 대상이 C (MMR + cache-friendly 정렬)이면
- [ ] top-N 선정에 diversity penalty(jaccard ≥ 0.7 시 점수 감점)가 적용되는가?
- [ ] manifest `retrievalWeights.diversityLambda`가 노출되는가?
- [ ] 출력 순서가 path 사전순(또는 결정적 tiebreak)인가? (score 변동 무관)
- [ ] 시작값 0.2~0.3으로 보수적 도입이 명시되는가?

#### 설계서 대상이 D Phase 1-3 (prefix 안정화)이면
- [ ] 출력 구조가 `Project Identity` → `Task Context` → `Session Volatile` → `Recent Failures` 순서인가?
- [ ] session_id·timestamp가 `## Session Volatile` 섹션에 격리되는가?
- [ ] 모든 array에 결정론적 정렬 키가 명시되는가?
- [ ] `stableStringify` 또는 동급 sorted-key JSON 헬퍼가 도입되는가?
- [ ] task 없을 때 `Task Context` 섹션 통째 omit이 정의되는가?
- [ ] 동일 task 두 번 호출 시 prefix 일치 검증 테스트가 있는가?

#### 설계서 대상이 D Phase 4 (cache 측정)이면
- [ ] Claude Code transcript usage 노출 여부 **spike가 선행**되는가?
- [ ] hit rate 계산식이 정의되는가? (`cache_read / (cache_read + cache_creation + input)`)
- [ ] 임계 70% 목표가 명시되는가?
- [ ] spike 부정적일 때 대안(Phase 1-3만 무측정 적용)이 정의되는가?

#### 설계서 대상이 I (Stale 압축)이면
- [ ] off-load 임계(N KB)가 manifest 확장으로 노출되는가?
- [ ] `payload_ref` 필드 스키마가 정의되는가?
- [ ] 원본 파일 영속 위치(`runtime/events/blobs/<hash>.txt` 또는 동급)가 보장되는가? (lossless)
- [ ] eval/retrieval/replay 모든 jsonl 파싱 경로가 `payload_ref`를 인식하는가?
- [ ] session-start 주입의 large observation 표시가 1줄 요약 + 경로인가?

---

## 7. Closed Decisions (재논의 금지)

분석 문서 §0 TL;DR + §6 결정사항 + 사용자 확정 결과를 통합.

### CD-M1. Wave B-1 형식: **분리안** (Current_Focus 사람 + Current_Todo 자동, 2파일)
- **근거**: Draft-first(D-5) 정합 + 메타데이터 파괴 위험 회피 + 4-channel writeback 정합 + 사용자 멘탈 모델 명확
- **출처**: 분석 §3-3 A+G "분리안 확정"

### CD-M2. Manus의 "멀티 에이전트"는 실제 미구현
- **근거**: leak 분석가 결론 "multi-agent functionality is not implemented"
- **본 프로젝트 함의**: D-8 Subagents 한정 결정과 정렬 (위배 아님)
- **출처**: 분석 §1-10

### CD-M3. D 항목은 HIGH 우선순위 (Step 10 보류 → Wave A로 격상)
- **근거**: Anthropic 공식 "cache hit rate를 SEV처럼 모니터링", 비용 10배 차이
- **출처**: 분석 §3-3 D 격상 조항

### CD-M4. 흡수 안 함: Datasource module / Linux 샌드박스 / 27개 도구 / Wide Research / CodeAct
- **근거**:
  - Linux 샌드박스/27개 도구 = Claude Code 중복 (책임 분리 위배)
  - Wide Research = leak으로 미구현 확인 + D-8 충돌
  - CodeAct = Draft-first(D-5) 위배 (자동 코드 실행 금지)
  - Datasource module = 본 프로젝트 본업 아님
- **출처**: 분석 §3-4

### CD-M5. backward-compat 정책: 빈 `applicable_when` = "always applicable"
- **근거**: 기존 lesson 마이그레이션 부담 회피
- **적용 범위**: 항목 F 게이트 격상 시 기존 lesson에만 해당. 신규 lesson은 채움 강제
- **출처**: 분석 §3-2 F + §6 결정 항목 2

### CD-M6. 에러 < 5개일 때 시간 기반 top-3 fallback
- **근거**: 프로젝트 초반 데이터 부족 시 retrieval 의미 약함
- **적용 범위**: 항목 B
- **출처**: 분석 §3-2 B 리스크 완화 + §6 결정 항목 2

### CD-M7. §4-1 신뢰성 수학(5단계=59%, 10단계=35%)을 PRINCIPLES.md §3 Draft-first **강화 근거**로 인용
- **근거**: 자율 chain의 본질적 한계 — Draft-first가 정확히 이 함정 회피책
- **적용 범위**: 신규 자동화 도입 시 "이 chain이 몇 단계인가?" 체크 의무화
- **출처**: 분석 §4-1 + §6 결정 항목 4

### CD-M8. D Phase 4 (cache 측정)은 transcript usage 노출 여부 spike 선행
- **근거**: 측정 가능성 미확인 상태에서 dashboard 진입 금지
- **fallback**: 노출 안 되면 Phase 1-3만 가설 검증 없이 무위험 적용
- **출처**: 분석 §3-3 D Phase 4 + §6 결정 항목 5

### CD-M9. Wave C(C / D-Phase4 / I)는 PRINCIPLES.md §11 Open Questions 항목 추가만 + 30일 후 재평가
- **근거**: 운영 데이터 부재 상태에선 튜닝 결정 불가
- **출처**: 분석 §6 결정 항목 6

---

## 8. 변경 이력

| 버전 | 날짜 | 변경 | 작성자 |
|-----|------|------|-------|
| 1.0 | 2026-05-07 | 최초 작성. 입력: docs/MANUS_AI_ANALYSIS.md (2026-05-07 시점) | 노예1호 (원칙 작성 세션) |
