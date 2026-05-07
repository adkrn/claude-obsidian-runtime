# Manus AI 분석 — claude-obsidian-runtime 적용 가능성 검토

**작성일**: 2026-05-07
**대상**: claude-obsidian-runtime v3.3.0
**목적**: Manus AI의 핵심 기능을 분해하고, 본 프로젝트(2-track 메모리 + 4-Layer + Draft-first) 철학과 충돌 없이 흡수 가능한 부분을 추려낸다.

---

## 0. TL;DR

Manus AI는 **Claude Sonnet 위에 27개 도구 + 3-Module 컨텍스트 주입(Planner/Knowledge/Datasource) + Linux 샌드박스 + Single-tool-per-loop 규칙**으로 자율성을 구현한 에이전트.

본 프로젝트는 **메모리 인프라**가 본업이고 **샌드박스 실행**은 Claude Code가 담당하므로, 흡수 영역은 **컨텍스트 엔지니어링 + 모듈 주입 패턴**으로 좁혀진다.

| 우선순위 | 항목 | 근거 | 위험 |
|---------|------|------|------|
| 🟢 HIGH | **B**. **작업 관련** 에러를 session-start에 주입 (3축 스코어링) | L4 Reflective와 정렬, 효과 명확 | 낮음 (F와 묶음 권장) |
| 🟢 HIGH | **E**. 에러 처리 4단계 프로토콜 (verify→fix→alt→escalate) | 현재 retry/escalate 정책 부재 | 낮음 |
| 🟢 HIGH | **F**. `applicable_when`을 retrieval 게이트로 격상 | Knowledge module scope-gated 패턴, precision 향상 + B의 인프라 공유 | 마이그레이션 부담 |
| 🟢 HIGH | **H**. notify vs ask 이분법 | 단순 컨벤션, 사용자 인지 부하 절감 | 거의 없음 |
| 🟢 HIGH | **§4-A**. task-close 검증 게이트 | Hallucinated success 예방 | 낮음 |
| 🟢 HIGH | **§4-B**. frontmatter 백업/검증 | Destroyed metadata 예방 | 낮음 |
| 🟡 MED | **A+G**. Current_Todo.md (번호 pseudocode) + live recitation | attention anchor, 50+ tool call 세션 효과 | Draft-first 경계 결정 필요 |
| 🟡 MED | **C**. readFirst diversity penalty (MMR) | few-shot 균일성 회피 | 가중치 튜닝 필요 |
| 🟢 HIGH | **D**. KV-cache 친화 prefix 안정화 (Phase 1-3) | 캐시 적중 시 비용 0.1배·지연 80%↓, Claude Code 자체 SEV 대응 영역 | 낮음 (Phase 4 측정만 spike 필요) |
| 🟡 MED | **I**. Stale → Reference 압축 (Dual Representation) | events.jsonl payload off-load + session-start 큰 observation 요약 | 낮음, 시급도 낮음 |
| 🔴 SKIP | Linux 샌드박스 / 27개 도구 | Claude Code 중복 — 책임 분리 위배 | — |
| 🔴 SKIP | Wide Research (멀티 agent 병렬) | leak으로 "실제 미구현" 확인 + D-8 충돌 | — |
| 🔴 SKIP | CodeAct (Python을 액션으로) | Draft-first 위배 | — |
| 🔴 SKIP | Datasource module (사전 승인 API) | 본 프로젝트 본업 아님 | — |
| ⚠️ 경계 | 신뢰성 수학: 5단계=59%, 10단계=35% | 자동 chain의 본질적 한계 — Draft-first 강화 명분 | — |

---

## 1. Manus AI 정확한 구조 (leak 기반)

### 1-1. 모델 베이스

leak으로 명확해진 사실:
- 베이스 모델 = **Claude Sonnet** (단독 모델 아님)
- 일부 보조에 Alibaba Qwen fine-tuned 사용
- "**multi-agent functionality는 실제로 구현되지 않음**" — leak 분석가 결론. 마케팅과 실제 구조 다름
- browser_use 오픈소스를 (가벼운 난독화로) 사용

### 1-2. 시스템 프롬프트 3-파일 구조

| 파일 | 역할 |
|-----|------|
| `prompt.txt` | 역할, 워크플로우, rules, 프롬프트 최적화 |
| `module.txt` | Agent Loop, Event Stream, 3 모듈 정의 |
| `tools.json` | 실행 가능한 함수 정의 (27개) |

### 1-3. 3-Module 컨텍스트 주입 (이게 핵심)

세 가지가 **별도 event type**으로 event stream에 주입:

| 모듈 | 역할 | 주입 형식 |
|-----|------|----------|
| **Planner** | 작업 계획 + 단계별 status | 번호 pseudocode, 단계 완료 시 list에서 제거. "모든 plan step을 완료해 final step에 도달"이 종료 조건 |
| **Knowledge** | 도메인 best practice + 사실 | scope 정의 + 내용. **"조건 충족 시에만 채택" — scope-gated**, 강제 아닌 조건부 |
| **Datasource** | 사전 승인된 API 라이브러리 | "웹 검색보다 datasource API가 우선순위 높음" |

### 1-4. Agent Loop 6-step

```
1. Analyze    (요구사항 + state + knowledge + plan event 이해)
2. Select     (현재 필요에 맞는 도구 선택)
3. Execute    (샌드박스에서, 결과 피드백)
4. Iterate    (작업 단위 반복)
5. Send msg   (notify / ask)
6. Idle       (모든 todo 완료 시)
```

**single-tool 규칙**: "Choose only one tool call per iteration". 병렬 호출 금지. observation 확인 후 다음.

### 1-5. 메시지 도구 이분법

| 도구 | 동작 | 사용 |
|------|------|------|
| `message_notify_user` | **non-blocking**, reply 불필요 | 진행 상태 보고 |
| `message_ask_user` | **blocking**, reply 필수 | "essential 한 경우만, 사용자 방해 최소화" |

### 1-6. 에러 처리 4단계 프로토콜 (rules 섹션 명시)

```
1. Verify tool name + arguments
2. Attempt fix based on error message
3. Try alternative methods
4. Report failure + request assistance (escalate)
```

### 1-7. Linux 샌드박스 (E2B 기반)

- Ubuntu + 인터넷 + sudo + 영속 파일시스템
- 사용자가 disconnect해도 background 실행 지속
- **27개 도구, 8 카테고리** (leak tools.json):

| 카테고리 | 개수 | 예 |
|---------|-----|-----|
| Message | 2 | notify_user, ask_user |
| File | 4 | read, write, str_replace, find_in_content |
| Shell | 5 | exec, view, wait, write_to_process, kill_process |
| Browser | 11 | navigate, click, input, scroll, console_exec, ... |
| Information | 1 | search_web |
| Deployment | 2 | expose_port, apply_deployment |
| Utilities | 2 | make_manus_page, idle |

### 1-8. 파일시스템 = 외부 메모리

- "context window는 RAM, file system은 disk"
- 거대 관찰값(PDF, 웹페이지)은 URL/경로만 컨텍스트에 남기고 본문 file로 off-load
- 모든 압축은 **복원 가능(reversible)** 해야 함 — lossless 원칙

### 1-9. todo.md (attention 조작)

- Plan event(번호 pseudocode)와 **별도로** todo.md 파일이 작업 디렉토리에 생성됨
- 둘 다 "끝부분 재낭독" 메커니즘. plan event는 시스템이, todo.md는 모델이 자발적으로 갱신
- 50+ tool call long horizon에서 lost-in-the-middle 회피

### 1-10. 멀티 에이전트 (실제로는 미구현)

- 마케팅 자료의 "Planner/Retriever/Coder 병렬" 구조
- **leak 분석 결론**: "multi-agent functionality is not implemented"
- 2026 "Wide Research"는 신규 기능 — agent-to-agent 협업 프로토콜 신설

### 1-11. 작업 로그 구조 — 3 계층 분리

Manus는 작업 이력을 **3개 분리된 계층**에 남긴다:

```
┌─────────────────────────────────────────────────────────┐
│ L1: Event Stream (컨텍스트 = LLM이 직접 읽는 영역)         │
│   - 6 event types, 시간순, append-only                    │
│   - Recent → Stale → Summary 3단계 lifecycle              │
└─────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────┐
│ L2: Sandbox File System (장기 저장, 영속)                  │
│   - todo.md (진행 추적)                                    │
│   - artifacts/ (산출물)                                    │
│   - 임시 결과 파일들                                        │
└─────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────┐
│ L3: Cloud Persistent (세션 간 보존)                        │
│   - artifacts + 업로드 + 핵심 설정만                       │
│   - 임시 파일은 폐기                                        │
└─────────────────────────────────────────────────────────┘
```

#### Event Stream 6 event types (leak 기반)

| # | Event Type | 발생 주체 | 발생 시점 |
|---|-----------|---------|---------|
| 1 | **Message** | 사용자 | 사용자 입력 |
| 2 | **Action** | Agent | 도구 호출 (tool_use) |
| 3 | **Observation** | 시스템 | 도구 실행 결과 |
| 4 | **Plan** | Planner Module | 계획 갱신 (번호 pseudocode + status) |
| 5 | **Knowledge** | Knowledge Module | scope-gated 주입 |
| 6 | **Datasource** | Datasource Module | API 문서 주입 |

**3대 핵심 규칙**:
- **Append-only** — 과거 event 절대 수정 X (캐시 안정성)
- **Chronological** — 시간순 누적
- **Deterministic serialization** — JSON 키 순서까지 고정 (KV-cache 보호)

#### 3단계 Lifecycle — Dual Representation 패턴

```
[Recent]  ──>  [Stale]  ──>  [Summary]
 full text     reference     schema-based
```

| Phase | 컨텍스트 내용 | 영속 저장 |
|-------|------------|---------|
| **Recent** | full text (raw observation) | sandbox 파일 |
| **Stale** | **file path reference만** | sandbox 파일 (full 보존) |
| **Summary** | schema-defined summary 필드 | sandbox 파일 |

**핵심 인사이트 — Dual Representation**:
- **Full** = sandbox 파일에 영속 (PDF, 웹페이지 raw)
- **Compact** = 컨텍스트엔 path reference만 (`/home/ubuntu/scrape_result_20260507.json`)
- 필요하면 agent가 path로 다시 read. 필요 없으면 토큰 절약

#### todo.md 작성 규칙 6개 (rules 섹션 leak)

1. Plan 모듈 기반 체크리스트로 todo.md 생성
2. **Task planning이 todo.md보다 우선** (todo.md는 detail용)
3. 각 항목 완료 즉시 text replacement 도구로 마커 갱신
4. Plan이 크게 바뀌면 todo.md 재작성
5. 정보 수집 작업은 반드시 todo.md로 진행 추적
6. 모든 plan step 완료 시 todo.md 검증 + skip 항목 제거

#### Manus 자체 시인한 한계 — todo.md 비용 비대

[Lance Martin 분석](https://rlancemartin.github.io/2025/10/15/manus/):

> "todo.md 갱신에 **전체 액션의 약 1/3**이 낭비됨 → 별도 planner agent로 분리"

→ Plan 모듈(시스템 갱신)과 todo.md(모델 갱신)이 중복이라는 자체 인정. 2026에 planner sub-agent + executor sub-agent 분리로 진화.

#### Session 재개 시 보존/폐기

| 보존됨 | 폐기됨 |
|-------|-------|
| Manus artifacts (최종 산출물) | 중간 코드 |
| 사용자 업로드 | 임시 파일 |
| Slides/WebDev 같은 핵심 파일 | scratch 작업물 |
| 핵심 설정 | scratchpad 텍스트 |

→ "**공식 산출물 vs 작업 부산물**"의 명시적 분리. 본 프로젝트의 [Draft-first(D-5)](../PRINCIPLES.md) 원칙과 동일 패턴.

---

## 2. Manus의 7가지 컨텍스트 엔지니어링 원칙

Manus 공식 블로그 [Context Engineering for AI Agents](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) 발췌:

| # | 원칙 | 효과 |
|---|------|------|
| ① | **KV-cache 적중률을 KPI로** | 캐시 히트 0.30/MTok vs 미스 3.00/MTok = **10배 비용 차이** |
| ② | **도구는 mask, remove 금지** | 도구 정의 변경 = 캐시 무효화 + 과거 호출 참조 깨짐 |
| ③ | **파일시스템을 컨텍스트로 사용** | 컨텍스트 무한 확장 + 토큰 폭발 회피 |
| ④ | **recitation (todo.md)** | attention bias를 자연어로 조작 |
| ⑤ | **에러 흔적을 보존** | 모델이 실수를 인식 → 재발 방지. "true agency = 에러 복구" |
| ⑥ | **few-shot 함정 회피** | 균일한 컨텍스트 → 패턴 모방 → 취약. 구조적 변동 주입 |
| ⑦ | **컨텍스트 엔지니어링 ≫ 모델 교체** | 모델 성능보다 메모리/환경/피드백 설계가 결정적 |

---

## 3. 본 프로젝트 매칭 분석

### 3-1. 이미 정렬된 부분 (흡수 불필요)

| Manus 원칙 | 본 프로젝트 대응 | 위치 |
|-----------|----------------|------|
| 파일시스템 = 외부 메모리 | 2-track (Runtime JSONL + Obsidian Markdown) | [PRINCIPLES.md §2](../PRINCIPLES.md) |
| Event stream | L1 Episodic `runtime/events/*.jsonl` | [PRINCIPLES.md §4](../PRINCIPLES.md) |
| 단계별 todo 추적 | `task-start` readFirst + `Current_Focus.md` | `templates/vault/00_Home/Current_Focus.md` |
| 에러 학습 | L4 Reflective `08_Reflections/` (Reflexion 표준) | [PRINCIPLES.md §4](../PRINCIPLES.md) |
| 절차 재사용 | L3 Procedural `09_Templates/Procedures/` (Memp 표준) | [PRINCIPLES.md §4](../PRINCIPLES.md) |
| 멀티 에이전트 신중론 | D-8 Subagents 한정 결정 | [HANDOFF.md §4 D-8](../HANDOFF.md) |
| Append-only event log | `runtime/events/*.jsonl` (수정 금지, 시간순) | L1 Episodic 본질 |
| 산출물 vs 부산물 분리 | Drafts/ vs 정식 (Draft-first D-5) | [PRINCIPLES.md §3](../PRINCIPLES.md) |

→ **이미 학술 표준(Park 2023, A-Mem, Memp, Reflexion)에 기반한 설계라 Manus 핵심 인사이트는 다 들어와 있음.**

#### 작업 로그 구조 — Manus vs 본 프로젝트 비교

| 항목 | Manus (3 계층) | claude-obsidian-runtime |
|------|---------------|------------------------|
| 컨텍스트 영역 | Event Stream (6 type, append-only) | `[Runtime Session Context]` (session-start hook) |
| 영속 raw 로그 | sandbox 파일시스템 | `runtime/events/*.jsonl` (**L1 Episodic**) |
| 진행 추적 | `todo.md` (모델 자율) | `Current_Focus.md` (사람) — Wave B-1으로 `Current_Todo.md` 추가 예정 |
| 추출된 지식 | (없음 — runtime 메모리만) | **L2 Semantic** `08_Lessons/` |
| 절차 재사용 | (없음 — 매번 todo.md 재작성) | **L3 Procedural** `09_Templates/Procedures/` (Memp 표준) |
| 반성/실패 | event stream raw 보존 | **L4 Reflective** `08_Reflections/` (Reflexion 표준) |
| Session 단위 worklog | 없음 (event stream이 전부) | `10_Worklogs/Auto/*.md` |
| Stale → Reference | **full → path reference 압축** | (현재 없음) ⚠️ 흡수 후보 (§3-3 I) |
| Append-only + deterministic | ✅ 명시 원칙 | 부분적 (Wave A5 D-Phase1-3에서 강화) |
| Session 재개 시 분리 | artifacts vs 임시 명시 분리 | Drafts/ vs 정식 (D-5 Draft-first) |

**본 프로젝트가 더 풍부한 영역**:
- L2/L3/L4 분리 — Manus는 event stream 한 곳에 다 섞여서 추출/재사용 어려움. 본 프로젝트는 학술 표준 4-Layer 분리.
- 사람 큐레이션 게이트 — Manus는 자동 누적만. 본 프로젝트는 Draft-first → 사람 승격 → 정식 문서.
- Worklog 단위 — Manus는 session 경계 모호. 본 프로젝트는 task/session 명시 worklog.

**본 프로젝트가 약한 영역 (1건)** — `Stale → Reference` 압축 패턴. 아래 §3-3 I로 흡수 후보.

### 3-2. 흡수 후보 — HIGH (4건)

#### B. 작업 관련(context-relevant) 에러 흔적을 session-start에 주입 🟢

**현재 상태**: `runtime/events/*.jsonl`이 모든 도구 호출을 기록. 단, **실패 trace의 LLM 재주입 정책**은 없음.

**Manus 인사이트**: 실패한 액션 + 스택 트레이스를 컨텍스트에 남기면 모델이 같은 실수를 반복하지 않음.

**핵심 설계 원칙 — "최근"이 아니라 "관련"**:

단순히 시간 기반 top-N (예: 7일 내 최근 3개)은 다음 함정에 빠진다:
- 현재 작업과 무관한 에러로 컨텍스트 오염
- 다른 모듈의 잡음(noise)을 attention에 주입
- 토큰 낭비 + few-shot 함정(원칙 ⑥) 자체 유발

→ **본 프로젝트의 retrieval 인프라(3축 스코어링)를 에러에도 동일 적용**해서 *현재 작업과 의미상 관련된* 에러만 추출.

**제안 — 에러를 "L1.5 retrievable layer"로 격상**:

1. **에러 인덱싱 (`core/eval/event-reader.mjs` 확장 또는 신규 `error-indexer.mjs`)**
   - episodic event에서 `outcome: "fail"` / `level: "error"` 추출 → `runtime/knowledge/errors.jsonl`로 정규화
   - 각 에러 레코드 필드:
     ```json
     {
       "id": "err-...",
       "timestamp": "2026-05-...",
       "tool": "Edit",
       "errorType": "string-not-found",
       "summary": "<1줄, 토큰화 가능>",
       "filePath": "src/foo.ts",
       "scope": "<defaultScope>",
       "tokens": [...],          // tokenizer 산출, jaccard용
       "recoveryAttempts": N,
       "resolved": true|false,
       "linkedReflectionPath": "08_Reflections/.../<slug>.md"  // 있으면
     }
     ```

2. **session-start의 컨텍스트 신호로 스코어링**
   - 현재 task가 있으면 신호 = `task.matchedScopes ∪ readFirst.tokens ∪ task.prompt 토큰 ∪ task.title 토큰`
   - task가 없으면 신호 = 직전 worklog summary 토큰
   - 각 에러에 대해 [`retrieval-scoring.mjs`](../core/memory/retrieval-scoring.mjs) `scoreItem({ tokens, last_accessed_at: timestamp, importance })` 호출
   - importance는 `recoveryAttempts` 비례(많이 실패할수록 중요) + `resolved=false`이면 가중

3. **필터링 게이트**
   - `applicable_when`(F 항목과 동일 메커니즘) 적용:
     - `path_glob`: 에러의 `filePath`가 현재 readFirst 파일과 같은 디렉토리/모듈인가
     - `scope_match`: 에러의 `scope`가 현재 `defaultScope`와 일치
     - `min_relevance`: jaccard 유사도 ≥ 임계(예: 0.15) 미만이면 제외
   - 모든 게이트 통과한 것 중 score top 3

4. **주입 포맷 (KV-cache 친화 — D 항목 정렬)**
   ```
   ### Related Past Failures (avoid repeating)
   - [tool=Edit] string-not-found in src/foo.ts (3회 시도, 미해결)
       → 회피: 컨텍스트 5줄 더 포함해서 재시도
   - [tool=Bash] ENOENT path 'C:/...' (resolved via 08_Reflections/2026-04-...)
       → 참조: 08_Reflections/2026-04-foo-path.md
   ```
   - 1줄 요약 + 파일 경로만 (lossless 원본은 events.jsonl에 보존)
   - L4 Reflective과 연결돼 있으면 경로 표시 → 사람이 즉시 점프 가능

**L4 Reflective와의 관계**:
- L4 = 원인 분석된 정식 reflection 문서 (사람이 큐레이션)
- 이건 = raw error trace의 retrievable index
- **둘은 보완 관계**: 새 에러 → events.jsonl + errors.jsonl 자동 → 사람이 정리하면 L4 reflection 생성 → linkedReflectionPath로 cross-reference

**리스크**:
- ⚠️ **데이터 부족 시 신호 약함** — 프로젝트 초반엔 에러 수가 적어 retrieval 의미 약함. **해결**: 에러 < 5개면 시간 기반 top-3 fallback. 5개 이상부터 스코어링 적용.
- ⚠️ **scope drift** — 에러의 scope가 부정확하면 무관한 게 매칭. **해결**: events.jsonl에서 에러 발생 시점의 active_task scope를 그대로 복사. 추론 X.
- ⚠️ **토큰 비용** — top 3, 각 1줄 + 경로 → ~150 토큰. 합리적.

**예상 효과**:
- "같은 파일/모듈에서 같은 에러 반복" 패턴이 가장 가치 큰 회피 신호 — 시간 무관 원리적
- 에러가 누적될수록 retrieval 정확도 향상 (3축 스코어링 자체가 lesson에서 검증된 방식)
- F 항목 (applicable_when 게이트)과 인프라 공유로 추가 구현 부담 감소

**변경 파일**:
- `commands/session-start.mjs` — 컨텍스트 신호 수집 + retrieval 호출 + 주입 블록
- `core/error-indexer.mjs` (신규) — episodic event → errors.jsonl 정규화
- `core/eval/event-reader.mjs` — 필요 시 에러 추출 helper 추가

**의존성**: F (`applicable_when` 게이트) 인프라 재사용 — 함께 구현하면 시너지

#### E. 에러 처리 4단계 프로토콜 🟢

**현재 상태**: hook 실패나 도구 에러 발생 시 **재시도/대안 시도/escalate** 정책 표준이 없음. event는 기록되지만 행동 지침 부재.

**Manus 인사이트**: rules 섹션에 명시된 verify → fix → alternative → escalate 4단계 표준.

**제안**:
- `templates/agents/_lead.md`에 "에러 마주치면" 섹션 추가:
  1. 도구 이름/인자 검증 → 자체 수정
  2. 에러 메시지 해석 후 fix 시도
  3. 대안 도구/접근 시도
  4. 3회 실패 시 사용자 escalate (`message_ask_user` 패턴)
- runtime episodic event에 `recovery_attempts: N` 필드 추가
- 4단계 모두 실패 시 자동 L4 Reflective draft 생성

**리스크**: 자동 retry 루프가 Draft-first 위배 위험. **해결**: 동일 도구·동일 인자 재시도 **금지**, 인자 수정/대안만 허용. 3회 cap.

**변경 파일**: `templates/agents/_lead.md`, `core/episodic-writer.mjs`

#### F. `applicable_when`을 retrieval 게이트로 격상 🟢

**현재 상태**: `08_Lessons/*.md` frontmatter 11필드에 `trigger_keywords` / `applicable_when` 항목 존재. 단, **lead 에이전트가 비어있을 때만 경고**하고 채워졌어도 검증 없음. retrieval 시점에 scope 매칭 로직 부재.

**Manus 인사이트**: Knowledge module은 "scope 조건 충족 시에만 채택"이 원칙. 무조건 주입하지 않음.

**제안**:
- `core/memory/retrieval-scoring.mjs`의 scoreItem에 `applicable_when` 평가 단계 추가
- frontmatter에 명세화:
  - `applicable_when.path_glob`: 현 task의 readFirst 파일이 매칭하는지
  - `applicable_when.trigger_keywords`: 사용자 prompt 토큰과 교집합 ≥ 1
  - `applicable_when.scope_id`: 현재 manifest defaultScope과 일치
- 미매칭 lesson은 score에서 제외 (또는 큰 패널티)

**리스크**: 기존 lesson은 빈 상태 → migration 부담. **해결**: 빈 필드 = "always applicable" backward-compat. 신규 작성만 강제.

**예상 효과**: Precision@5 향상 (기획서 §11 임계 0.60 → 0.70 도전 가능)

**변경 파일**: `core/memory/retrieval-scoring.mjs`, `templates/vault/08_Lessons/_TEMPLATE.md`

#### H. notify vs ask 이분법 🟢

**현재 상태**: lead 에이전트가 사용자에게 제안할 때(승격 후보 등) **blocking 여부 명시 없음**. 사용자가 답변해야 하는지 판단 부담.

**Manus 인사이트**: notify (non-blocking) vs ask (blocking) 명확 구분.

**제안**:
- `[NOTIFY]` prefix → 정보 전달, 사용자 reply 기대 안 함
- `[ASK]` prefix → 결정/입력 필요, blocking
- `templates/agents/_lead.md`에 사용 가이드

**리스크**: 거의 없음. 단순 컨벤션.

**변경 파일**: `templates/agents/_lead.md`

### 3-3. 흡수 후보 — MED (4건)

#### A+G. Current_Todo.md (번호 pseudocode) + live recitation 🟡

**현재 상태**: `Current_Focus.md`는 사람이 수동 갱신 + lead agent가 Read 시점에만 참고.

**Manus 인사이트**: todo가 **컨텍스트 끝부분에서 자주 갱신**되어야 attention이 거기 쏠림. Plan event 포맷은 자유 텍스트가 아닌 **번호 pseudocode + status**.

**구조 — 분리안 확정**:

```
templates/vault/00_Home/
├── Current_Focus.md   ← 사람이 수동 작성/편집 (현재와 동일, 손대지 않음)
└── Current_Todo.md    ← 자동 생성/갱신 (신규, 시스템 전용)
```

**확정 근거**:
1. Draft-first 원칙(D-5)에 정확히 맞음 — Current_Todo.md를 명시적 draft 영역으로 분류
2. §4-B 메타데이터 파괴 위험 회피 — 자동 갱신이 사람 영역에 닿지 않음
3. 4-channel writeback 구조와 정합 — 자동 생성물은 항상 별도 위치 원칙
4. 사용자 멘탈 모델 명확 — "이 파일은 사람용, 저 파일은 시스템용"

**Current_Todo.md 포맷 표준**:

```markdown
# Current Todo (auto-managed — do not edit manually)

> 이 파일은 시스템이 자동 갱신합니다. 수동 편집은 다음 갱신에서 덮어씌워집니다.
> 사람 큐레이션은 [Current_Focus.md](./Current_Focus.md)에 작성하세요.

**task**: <taskId> :: <title>
**updated_at**: <ISO timestamp>

1. [ ] <step description>  <!-- status: pending -->
2. [x] <step description>  <!-- status: done, at: <ISO> -->
3. [→] <step description>  <!-- status: in_progress, since: <ISO> -->
4. [!] <step description>  <!-- status: blocked, reason: ... -->
```

**제안 동작**:
- `task-start`가 readFirst와 manifest 기반으로 초기 list 생성 → Current_Todo.md write
- PostToolUse hook이 file_read/edit 매칭 시 해당 항목 `[ ]` → `[x]` 자동 체크
- `task-close`가 미완(`[ ]`, `[→]`, `[!]`) 항목을 worklog에 carry-over + Current_Todo.md 초기화

**리스크 + 완화**:
- ⚠️ 자동 체크 오판 — 의도와 무관한 file_edit이 항목을 체크 처리할 수 있음. **해결**: 매칭은 항목 description의 명시 키워드(파일 경로, 함수명) 일치 시만. 보수적 매칭.
- ⚠️ Obsidian 그래프 노이즈 — 자동 파일이 검색에 섞임. **해결**: Current_Todo.md frontmatter에 `auto_managed: true` + Obsidian search exclude 가이드 (docs/QUICKSTART.md에 추가)
- ⚠️ task 없을 때 — task가 없으면 Current_Todo.md는 빈 상태 유지 (또는 archive 처리)

**예상 효과**: 50+ tool call 세션에서 목표 이탈 빈도 감소

**변경 파일**:
- `templates/vault/00_Home/Current_Todo.md` (신규 템플릿)
- `templates/hooks/post-tool-use.mjs` (file_read/edit 매칭 시 체크)
- `commands/task-start.mjs` (초기 list 생성)
- `commands/task-close.mjs` (carry-over + 초기화)
- `core/todo-writer.mjs` (신규, todo 파싱/갱신 헬퍼)
- `docs/QUICKSTART.md` (Obsidian search exclude 가이드 추가)

#### C. readFirst diversity penalty (MMR) + cache-friendly 정렬 🟡

**현재 상태**: `retrieval-scoring.mjs`의 3축 스코어 top-N이 readFirst로 직주입. 점수 1, 2, 3등이 비슷한 lesson이면 **균일 컨텍스트** 형성.

**Manus 인사이트**: 구조 균일 → 모델이 패턴 모방 → 취약. 일부러 변동성 필요 (원칙 ⑥).

**제안**:

(1) **Diversity penalty (MMR 변형)**:
- top-N 선정 시 이미 선택된 항목과 jaccard 유사도 ≥ 0.7이면 점수 패널티
- manifest `retrievalWeights`에 `diversityLambda` 추가
- λ를 작게(0.2~0.3) 시작

(2) **Cache-friendly 출력 정렬 (D 항목과 시너지)**:
- score로 선정한 N개를 그대로 출력하면 **score 변동 시 순서 변동 → prefix 캐시 무효화**
- 선정은 score, 출력은 **path 사전순**으로 정렬 → task 내에서 readFirst 변동 최소화
- 같은 task에서 두 번째 세션 시작 시 readFirst가 동일 순서로 출력 → cache hit 가능

**리스크**: 가장 관련 있는 lesson 제외 가능 (MMR 측면). **해결**: [§11 Open Questions](../PRINCIPLES.md) 30일 운영 후 χ² 튜닝 묶음

**변경 파일**: `core/memory/retrieval-scoring.mjs`, `core/memory/readfirst-builder.mjs` (있다면) / 또는 호출부

#### D. KV-cache 친화 prefix 안정화 🟢 (HIGH로 격상)

**우선순위 격상 근거 (재조사 결과)**:

조사 전: "Claude Code 캐싱 정책 미확인 → Step 10 보류"였으나, 공식 문서 확인 결과:
- Anthropic Claude Code **공식 블로그 "Prompt caching is everything"**: cache hit rate를 **uptime처럼 모니터링하며 SEV(중대 이슈)로 대응**
- Claude Code 자체가 prefix 깨뜨린 적 있음 (timestamp 삽입, tool order 셔플) — 본 프로젝트도 동일 함정 노출
- 측정은 `cache_read_input_tokens` / `cache_creation_input_tokens` 필드로 명확히 가시화 가능

비용 영향이 **10배** 수준이고, Claude Code가 자체 캐싱에 강하게 의존하므로 **HIGH 우선순위로 재분류**.

**현재 상태**: `[Runtime Session Context]` 블록이 SessionStart hook의 `additionalContext` stdout으로 emit. session_id, 타임스탬프, last_worklog summary 등 **모두 동적**. 매 세션 prefix 변동 가능.

##### 핵심 인사이트 — 가장 중요한 발견

> **"send the updated information as a `<system-reminder>` tag in the next user message" rather than modifying the system prompt.**
> — Anthropic 공식 권장

Claude Code의 `additionalContext`는 다음 turn의 **user message** 안 `<system-reminder>` 태그로 들어감 → **system prompt 캐시는 깨지지 않음**.

→ 이미 본 프로젝트의 SessionStart hook 출력은 user message로 들어가는 구조. **system prompt 자체를 우리가 조작하지 않으므로 큰 위험은 없음**. 다만 **user message 내부**에서도 캐시 효율은 의미 있음 (lookback 20 블록 내 prefix 매칭).

##### Anthropic 캐싱 메커니즘 정리 (공식 문서)

| 사항 | 값 |
|------|---|
| 캐시 계층 | `tools → system → messages` (앞 단계 변경이 뒷 단계 무효화) |
| TTL 기본 | **5분** (2026-03-06 이후, 이전 1시간) |
| TTL 확장 | 1시간 옵션 (`cache_control.ttl: "1h"`, write 비용 2배) |
| 비용 | hit = base의 0.1배, 5m write = base의 1.25배 |
| Lookback window | 20 블록 |
| Breakpoint 한도 | 명시 4개 |
| 최소 토큰 (Opus 4.7) | **4096** ← 이 미만은 조용히 캐시 안 됨 |
| 측정 필드 | `cache_creation_input_tokens`, `cache_read_input_tokens` |

##### 현재 session-start.mjs 출력 분석

`commands/session-start.mjs:28-58`의 `buildAdditionalContext` 출력 예:

```
[Runtime Session Context]
- session_id: abc-123-def-456              ← 매번 다름 (HIGH 변동)
- active_task: 20260507-1430-task-abc :: ...  ← task 단위로 변동 (MED)
- active_scopes: scope-a, scope-b           ← task 단위로 변동 (MED)
- resume_read_first:
  - path1 :: why1                            ← task 내에서 안정 (LOW 변동)
  - path2 :: why2
- active_task_worklog: 10_Worklogs/...      ← task 내에서 안정 (LOW)
- last_worklog: ...                          ← 매 세션 변동 (HIGH)
- last_worklog_summary: modified=N, failures=M, hook=...  ← 매 세션 변동 (HIGH)
```

**문제 패턴**:
1. session_id가 **첫 줄**에 옴 → 그 뒤 모든 텍스트의 prefix 매칭 깨짐
2. 정적 + 동적 정보 혼재 → 어느 줄까지 캐시 가능한지 불명확
3. 정렬되지 않은 array (`scopes`, `readFirst`) — 순서가 비결정적이면 캐시 미스

##### 제안 — "Static-first, Dynamic-last" 재구조화

**Phase 1: Layout 재배치 (즉시, low-risk)**

새 출력 구조:

```
[Runtime Session Context]

## Project Identity (stable across all sessions)
- runtime: claude-obsidian-runtime v3.3.0
- project_id: <projectTag>
- runtime_home: <hash of CLAUDE_RUNTIME_HOME>     ← 절대경로 X (다른 머신에서도 안정)
- managed_roots: 9                                 ← 정적

## Task Context (stable within a task lifetime)
- task_id: <taskId>
- task_title: <title>
- active_scopes: <sorted list, deterministic>
- read_first:
  - <sorted by score, then by path lexicographic>

## Session Volatile (changes every session)
- session_id: <id>
- session_started_at: <ISO>
- last_worklog: <path>
- last_worklog_summary: modified=N, failures=M

## Recent Failures (B 항목, applicable_when 게이트 통과한 것만)
- ...
```

**원칙**:
- 정적 → 준정적 → 동적 순으로 **반드시** 정렬
- 모든 array 출력 시 **결정론적 정렬** (사전순 또는 score → path tiebreak)
- task가 없으면 "Task Context" 섹션 통째로 omit (조건부 누락이 prefix 변경보다 깨끗)

**Phase 2: 결정론적 직렬화 보장 (즉시, low-risk)**

- 모든 JSON 출력 시 키 사전순 정렬 (Node.js `JSON.stringify`는 기본 키 순서 유지하지만 객체 생성 순서에 의존 → 명시적 sort 필요)
- 헬퍼 신설: `core/cache-stable-stringify.mjs` — `stableStringify(obj)` = recursive sorted-key JSON.stringify
- `runtime-lib.mjs`의 `loadCurrentTaskPointer`, `loadLatestWorklogSummary` 등이 emit하는 모든 객체를 통과시킴

**Phase 3: 동적 컨텐츠 명시 분리 (즉시)**

session_id, timestamps 등 **반드시 변하는 정보**는 `## Session Volatile` 섹션에 격리. 그 위 섹션은 task 단위로 안정 → lookback 20 블록 내 hit 가능성 ↑.

##### 측정 + 검증 방법

**Phase 4: cache hit rate 가시화 (별도 작업, eval-run에 통합)**

`eval-run` 또는 새 `commands/cache-stats.mjs`에서:
- 최근 N개 세션의 transcript 메타데이터 (Claude Code가 저장하면) 또는 별도 측정 hook
- `cache_read_input_tokens` / `(cache_read + cache_creation + input)` 비율 = cache hit rate
- 임계: 안정 prefix 적용 후 hit rate ≥ 70% 목표

**측정 가능성 검증**:
- Claude Code가 transcript_path에 usage 메타데이터를 저장하는지 확인 필요 (현재 미확인 — 별도 spike)
- 저장 안 하면 별도 wrapper(예: PostToolUse hook으로 usage 기록) 도입

##### 위험 + 완화

| 위험 | 완화책 |
|------|-------|
| Claude Code가 매 PreToolUse마다 system_reminder 추가하면 user message 내부도 prefix 변동 | 본 프로젝트가 통제 가능한 영역(SessionStart 출력)만 안정화. Claude Code 자체 동작은 외부 변수 |
| stableStringify 도입이 기존 직렬화 산출물과 hash 불일치 | runtime-manifest.json `_manifest.json` SHA256 검증(C11)에는 영향 없음 (manifest 자체는 정렬됨). events.jsonl 등은 append-only라 영향 없음 |
| 4096 토큰 미만이면 캐시 자체가 안 됨 (Opus 4.7) | session-start 출력은 보통 200~500 토큰 → **breakpoint 따로 안 둠**. 그 앞의 system prompt + tools가 4096+ 면 자동 hit |
| 측정이 어려우면 효과 검증 불가 | Phase 4에서 transcript usage 추출 가능성 spike. 안 되면 Phase 1-3만 가설 검증 없이 무위험 적용 |

##### 변경 파일 (Phase별)

**Phase 1-3 (안정화 — 즉시 진행 가능, 무위험)**:
- `commands/session-start.mjs` — `buildAdditionalContext` 재배치 + 결정론적 정렬
- `core/cache-stable-stringify.mjs` (신규) — sorted-key JSON 헬퍼
- `core/runtime-lib.mjs` — emit 객체 정렬 적용 지점들
- 테스트: `commands/__tests__/session-start.test.mjs` — 동일 task 두 번 호출 시 출력 prefix 일치 verify

**Phase 4 (측정 — 별도 spike 후)**:
- `commands/cache-stats.mjs` (신규)
- 또는 `core/eval/event-reader.mjs` 확장으로 cache 메트릭 집계

##### 예상 효과

- **운영비**: hit rate 70%+ 달성 시 Manus 블로그의 "10배 비용 차이"에 근접 (실제는 Claude Code가 system prompt에서 이미 큰 캐시 적중을 가져가므로 한계 효과는 작을 수 있음 — 측정 후 확정)
- **지연**: hit rate ↑ → 첫 토큰 지연 ~80% 감소 (Anthropic 공식 수치)
- **신뢰성**: prefix 결정론은 **재현성** 향상 → 디버깅/golden-task 일관성 ↑

#### I. Stale → Reference 압축 (Dual Representation) 🟡

**현재 상태**: `runtime/events/*.jsonl`이 raw 데이터 그대로 누적. 큰 observation(예: Read 결과 800줄 파일)도 full로 들어감. session-start의 last_worklog summary는 이미 compact이지만, **event stream 자체의 stale 압축은 없음**.

**Manus 인사이트**: Recent → Stale → Summary 3단계 lifecycle. stale 이후엔 컨텍스트엔 path reference만, full은 sandbox 파일에 보존.

**제안**:

본 프로젝트는 이미 **path 기반 인덱스**라 절반은 정렬됨. 추가로:

1. **Event 압축 정책 도입** (`core/event-aggregator.mjs` 확장 또는 신규):
   - events.jsonl 항목 중 payload가 N KB 이상이면 별도 파일(`runtime/events/blobs/<hash>.txt`)로 off-load
   - events.jsonl엔 `payload_ref: "blobs/abc123.txt"` 형태 reference만 유지
   - 압축 임계는 manifest로 조정 가능

2. **session-start 주입 시 large observation 요약**:
   - 직전 session에서 발생한 observation 중 큰 것은 `last_observation: <type> @ <path> (size=N KB)` 형태로 표시
   - 모델이 필요하면 path를 통해 명시적 Read

3. **Worklog summary schema화** (Manus의 Summary phase에 대응):
   - 현재 `loadLatestWorklogSummary`가 이미 schema 기반 (`modifiedFileCount`, `failureCount`, ...)
   - 필드 확장: `largest_artifact_path`, `error_count_by_tool`, `tool_call_total` 등

**리스크**:
- 본 프로젝트는 [§2 2-track](../PRINCIPLES.md) 원칙으로 이미 runtime을 compact로 유지 중. 추가 압축의 한계 효과 검증 필요
- jsonl 파싱 로직(eval, retrieval)이 payload_ref를 처리하도록 일관성 확보 필요

**예상 효과**:
- events.jsonl 파일 크기 안정화 (대량 Read 결과로 jsonl 부풀어오는 것 방지)
- session-start 토큰 폭증 회피 (event 수 많은 task에서 의미)

**변경 파일**:
- `core/event-aggregator.mjs` 또는 `core/episodic-writer.mjs` — payload off-load 로직
- `commands/session-start.mjs` — large observation 요약 표시
- `core/eval/event-reader.mjs` — payload_ref 해석

**우선순위 사유**: 현재 시급도 낮음. 본 프로젝트의 jsonl이 실제로 부풀어오를 정도로 데이터 누적된 이후 도입이 합리적. **Wave C로 분류**.

### 3-4. 흡수 불필요 / 충돌 (4건)

| Manus 기능 | 본 프로젝트 입장 |
|-----------|----------------|
| **Linux 샌드박스 + 27개 도구** | Claude Code가 Read/Edit/Write/Bash 제공. 중복 구현은 [PRINCIPLES.md §9](../PRINCIPLES.md) 위배 |
| **Wide Research (멀티 agent 병렬)** | leak으로 "실제 미구현" 확인. [D-8 Subagents 한정](../HANDOFF.md) 결정과 충돌 |
| **CodeAct (Python을 액션으로)** | 사람-기획-코드 3분리 철학. 자동 코드 실행은 [§3 Draft-first](../PRINCIPLES.md) 위배 |
| **Datasource module** | 외부 데이터 acquisition은 본 프로젝트 본업 아님. Claude Code가 web 도구 제공 |

---

## 4. Manus 실패 모드 — 본 프로젝트의 예방책

Manus 실측 평가 출처: [MIT Tech Review](https://www.technologyreview.com/2025/03/11/1113133/manus-ai-review/), [Rio Times — 14 Failures](https://www.riotimesonline.com/manus-a-i-review-14-failures-in-two-weeks-of-testing/), [Deeper Insights](https://deeperinsights.com/ai-review/manus-ai-review-detailed-analysis-of-benefits-drawbacks/), [aibase — 공식 응답](https://www.aibase.com/news/16138).

### 4-1. 신뢰성 수학 (가장 충격적인 발견)

> "If each step is 90% reliable, **5 steps = 59% reliable, 10 steps = 35% reliable**."

자율 chain이 길어질수록 곱셈으로 신뢰성 폭락. Manus는 50+ tool call long-horizon 시도하므로 누적 실패율이 본질적 한계. 베타 hallucination rate 2.1%.

**본 프로젝트 함의**:
- **Draft-first 원칙(D-5)이 정확히 이 함정 회피책** — 자동 chain은 draft만, 정식 승격은 사람 수동
- 신규 자동화 기능 도입 시 "이 chain이 몇 단계인가? 90%면 누적은?" 체크 의무화
- → [PRINCIPLES.md §3 Draft-first](../PRINCIPLES.md) 강화 인용 후보

### 4-2. 실측 실패 카테고리 vs 본 프로젝트 노출

| 비중 | 실패 모드 | 본 프로젝트 노출 |
|-----|---------|-------------|
| 28% | Hallucinated clicks | 해당 없음 (브라우저 자동화 X) |
| 22% | Browser timeouts | 해당 없음 |
| 18% | Anti-bot blocks | 해당 없음 |
| - | **Hallucinated success reports** | **노출 있음** — task-close 자동 worklog가 거짓 성공 보고 가능 |
| - | **Destroyed metadata** | **노출 있음** — frontmatter 11필드 자동 갱신 위험 |
| - | 41,600 페이지 SEO 사고 | 해당 없음 (대량 변경 자동화 없음) |

### 4-3. 노출된 2가지 + 예방책

#### A. Hallucinated success reports (가짜 성공 보고) 🟢

**Manus 사례**: 작업 실패했는데 "완료" 보고. 사용자가 사후에 발견.

**본 프로젝트 노출**: `task-close` 자동 worklog 생성 시 modifiedFiles만 보고 "성공" 판정 가능. 실제 lint/test 실패 무시.

**예방책 — task-close 검증 게이트**:
- `task-close --verify` 옵션 (기본 ON)으로 doctor 일부 체크 자동 실행
- 실패 시 worklog 상단에 `⚠️ unverified` 배지 + L4 Reflective draft 자동 생성

**변경 파일**: `commands/task-close.mjs`

#### B. Destroyed metadata (메타데이터 파괴) 🟢

**Manus 사례**: 자동 편집이 frontmatter 일부 보존하지 않고 덮어씀.

**본 프로젝트 노출**: A-Mem evolution(`memory-evolution.mjs`)이 lesson frontmatter `evolved_at` append 시 다른 11필드 파싱 실패 시 손실 가능.

**예방책 — frontmatter 백업 + 검증**:
- evolution 전 lesson 원본 hash 저장
- evolution 후 11필드 모두 존재 확인 (parser 검증)
- 누락 발견 시 rollback + L4 Reflective draft

**변경 파일**: `core/memory/memory-evolution.mjs`

### 4-4. 시스템 프롬프트 leak에서 배운 보안 교훈

leak 사건: `/opt/.manus/` 노출 → 시스템 프롬프트 + tools.json 유출. 공식 응답: "샌드박스 내부 코드는 명령 수신용일 뿐, 가벼운 난독화만 적용".

**본 프로젝트 노출 여부**:
- runtime hook은 사용자 머신 로컬. 외부 노출 면 없음
- `templates/agents/_lead.md`가 git public repo에 있으면 lead 페르소나/판정 기준 노출
- → **현재 정책으로 OK** (오픈소스 패키지이므로 의도된 공개)

---

## 5. 적용 우선순위

### Wave A — 무위험, 즉시 진행 후보 (2~3일)

| # | 항목 | 변경 파일 | 의존성 |
|---|------|----------|--------|
| A1 | **E**. 에러 처리 4단계 프로토콜 | `templates/agents/_lead.md`, `core/episodic-writer.mjs` | — |
| A2 | **H**. notify vs ask 이분법 | `templates/agents/_lead.md` | — |
| A3 | **§4-A**. task-close 검증 게이트 | `commands/task-close.mjs` | — |
| A4 | **§4-B**. frontmatter 백업/검증 | `core/memory/memory-evolution.mjs` | — |
| A5 | **D-Phase1-3**. KV-cache prefix 안정화 (재배치 + 결정론적 직렬화) | `commands/session-start.mjs`, `core/cache-stable-stringify.mjs` (신규), `core/runtime-lib.mjs` | — |

### Wave A+ — context-relevant 에러 주입 (B + F 묶음, 2~3일)

B와 F가 `applicable_when` 게이트 + 3축 스코어링 인프라를 **공유**하므로 함께 구현하면 효율적.

| # | 항목 | 변경 파일 | 의존성 |
|---|------|----------|--------|
| A+1 | **F**. `applicable_when` retrieval 게이트 (lesson용) | `core/memory/retrieval-scoring.mjs`, `templates/vault/08_Lessons/_TEMPLATE.md` | — |
| A+2 | **B**. context-relevant 에러 인덱스 + 주입 (errors.jsonl) | `commands/session-start.mjs`, `core/error-indexer.mjs` (신규) | F (게이트 로직 재사용) |

### Wave B — 검증 필요 (3~5일)

| # | 항목 | 비고 |
|---|------|------|
| B1 | **A+G**. Current_Todo.md (번호 pseudocode) + live recitation | 분리안 확정. 자동 체크 매칭 보수성 검증 필요 |

### Wave C — Open Questions 묶음 (Step 10)

| # | 항목 | 트리거 |
|---|------|--------|
| C1 | **C**. Diversity penalty (MMR) | 30일 운영 후 χ² 튜닝과 함께 |
| C2 | **D-Phase4**. cache hit rate 가시화 + 측정 | Claude Code transcript usage 메타데이터 노출 여부 spike 후 |
| C3 | **I**. Stale → Reference 압축 (Dual Representation) | events.jsonl 실제 부풀어오름 관측 시 |

---

## 6. 결정 필요 사항 (성희님 confirm)

1. **Wave A 5개 즉시 진행 OK?** — 모두 위험 낮음, 효과 명확. D-Phase1-3 (KV-cache prefix 안정화)도 포함
2. **Wave A+ (B+F 묶음) 진행 OK?** — context-relevant 에러 주입. 3축 스코어링 인프라 재사용
   - 부록: `applicable_when` backward-compat 정책 — 빈 필드 = "always applicable"로 도입 OK? (마이그레이션 부담 회피)
   - 부록: 에러 < 5개일 때 시간 기반 top-3 fallback OK?
3. **Wave B-1**: 분리안 확정 (Current_Focus 사람 + Current_Todo 자동, 2파일). 진행 OK?
4. **§4-1 신뢰성 수학을 [PRINCIPLES.md §3 Draft-first](../PRINCIPLES.md) 강화 근거로 인용 추가** OK?
5. **D-Phase4 (cache 측정)**: Claude Code transcript에서 `cache_read_input_tokens` 노출 여부 spike 먼저 진행하고, 가능하면 Wave C에서 dashboard 작업? 불가능하면 Phase 1-3만 가설 검증 없이 적용?
6. **Wave C는 [§11 Open Questions](../PRINCIPLES.md)에 항목 추가**만 하고 30일 후 재평가?

---

## 7. 참고 자료

### 공식 / 1차 자료
- [Context Engineering for AI Agents (Manus 공식)](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- [Manus Documentation — Welcome](https://manus.im/docs/introduction/welcome)
- [Manus API 문서](https://manus.im/docs/integrations/manus-api)
- [Wikipedia — Manus (AI agent)](https://en.wikipedia.org/wiki/Manus_(AI_agent))

### Leak / 시스템 프롬프트
- [Manus tools and prompts (jlia0 gist)](https://gist.github.com/jlia0/db0a9695b3ca7609c9b1a08dcbf872c9) — 시스템 프롬프트 + tools.json 원본
- [system-prompts-and-models-of-ai-tools (x1xhlol)](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/blob/main/Manus%20Agent%20Tools%20%26%20Prompt/tools.json)
- [DeepWiki — Manus Modules 분석](https://deepwiki.com/yuanqi99/system-prompts-and-models-of-ai-tools/3.2.2-manus-modules)
- [Manus AI System Prompt Leakage 공식 응답 (aibase)](https://www.aibase.com/news/16138)
- [Manus Unveiled (Joyce Birkins)](https://medium.com/@joycebirkins/manus-unveiled-dive-into-internal-prompts-workflows-and-tool-configurations-6ee9a7e0e708)

### 학술 / 분석
- [arxiv 2505.02024 — From Mind to Machine: Manus AI](https://arxiv.org/html/2505.02024v1)
- [In-depth investigation gist (renschni)](https://gist.github.com/renschni/4fbc70b31bad8dd57f3370239dccd58f)
- [E2B — How Manus Uses E2B](https://e2b.dev/blog/how-manus-uses-e2b-to-provide-agents-with-virtual-computers)
- [DataCamp — Manus AI: Features, Architecture, Access](https://www.datacamp.com/blog/manus-ai)

### 작업 로그 구조 / 메모리 lifecycle (§1-11 출처)
- [Context Engineering in Manus (Lance Martin, 2025-10)](https://rlancemartin.github.io/2025/10/15/manus/) — Recent → Stale → Summary 3단계 lifecycle, todo.md 33% 비용 시인, planner sub-agent 분리 진화
- [Manus Sandbox 공식 블로그](https://manus.im/blog/manus-sandbox) — 재개 시 보존/폐기 정책 (artifacts vs 임시)

### Prompt Caching (D 항목 핵심 출처)
- [Anthropic 공식 — Prompt caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) — 캐시 계층, 무효화 조건, breakpoint 정책, usage 메트릭
- [Claude 공식 블로그 — Lessons from building Claude Code: Prompt caching is everything](https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything) — Claude Code의 prefix 깨짐 사고, SEV 대응
- [How Prompt Caching Actually Works in Claude Code](https://www.claudecodecamp.com/p/how-prompt-caching-actually-works-in-claude-code) — `<system-reminder>` user message 패턴 권장
- [Anthropic Cache TTL 5분 변경 (2026-03-06)](https://dev.to/whoffagents/anthropic-silently-dropped-prompt-cache-ttl-from-1-hour-to-5-minutes-16ao) — TTL 정책 변화
- [How prompt caching works (sankalp)](https://sankalp.bearblog.dev/prompt-cache/) — 실전 캐시 적중 팁, JSON 직렬화 함정

### 실패 모드 / 비판
- [MIT Tech Review — We put Manus to the test (2025-03)](https://www.technologyreview.com/2025/03/11/1113133/manus-ai-review/)
- [Rio Times — 14 Failures in Two Weeks](https://www.riotimesonline.com/manus-a-i-review-14-failures-in-two-weeks-of-testing/)
- [Deeper Insights — Detailed Benefits/Drawbacks](https://deeperinsights.com/ai-review/manus-ai-review-detailed-analysis-of-benefits-drawbacks/)
- [Medium — Manus AI Limitations in High-Resolution GUI / Medical Coding](https://medium.com/@prasmit/manus-ais-limitations-in-high-resolution-gui-interactions-and-specialized-medical-coding-a-1bc1b3e244ad)

---

**관련 문서**:
- 설계 철학 → [PRINCIPLES.md](../PRINCIPLES.md)
- 인수인계 → [HANDOFF.md](../HANDOFF.md)
- 기획서 원본 → `C:/Users/adkrn/.claude/plans/eventual-jingling-adleman.md`
