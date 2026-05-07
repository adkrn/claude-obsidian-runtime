# PRINCIPLES — 기획 의도와 설계 원칙

**목적**: "왜 이렇게 만들었나"에 답한다. 코드만 보면 복원 불가능한 **설계 의도와 선택 이유**를 고정한다.

**대상 질문**:
- "왜 shared/project-local 분리?"
- "왜 4-Layer 메모리?"
- "왜 draft-first?"
- "왜 Obsidian + Runtime 이중 저장소?"
- "왜 벡터 검색 안 쓰나?"
- "다른 방법은 왜 선택 안 했나?"

**선행**: [HANDOFF.md](./HANDOFF.md) §4 "주요 결정 로그"를 먼저 읽었다는 전제.

---

## 1. 근본 문제 — 세션 간 기억 상실

Claude는 세션 간 영속 메모리가 없다. 매번 새 세션에서:
- 같은 파일을 탐색한다
- 같은 실수를 반복한다
- 같은 설계 결정을 재해석한다

프로젝트가 커질수록 **"이미 결정한 것을 다시 결정하는 비용"**이 선형이 아니라 기하급수로 증가한다.

### 실제 증상 — 이 세션 이전에 반복된 것들
- TalkUp에서 "prompt_templates.yaml 구조" 질문을 세션마다 처음부터 답변
- "hook 수정 시 어느 파일들을 같이 보나" 매번 새로 탐색
- "어떤 lesson이 비슷한 문제를 다뤘나" 기억 못해서 중복 작업

**이 시스템의 존재 이유** = 위 비용을 프로젝트 수명 내내 감당 가능한 수준으로 낮추는 것.

---

## 2. 2-track 메모리 구조 (§1-2)

### 원칙

> **Runtime은 repo-local compact index. Obsidian은 curated narrative knowledge.**

두 저장소는 **수명과 입도가 다르다**.

| Track | 입도 | Claude가 읽는 방식 | 사람이 읽는 방식 |
|-------|------|-------------------|-----------------|
| **Runtime** (`.claude/runtime/`) | JSONL 한 줄 / 필드 단위 | 자동 주입 (readFirst/codeHits) | 거의 안 읽음 |
| **Obsidian Vault** | Markdown 문서 | **명시적 Read** 해야 로드 | 일상 읽기/편집 |

### 왜 합치지 않았나

합쳤을 때 나오는 증상:
- **Obsidian 본문 전체 자동 주입** → 토큰 낭비 + 맥락 희석
- **transcript 기반 writeback** → 노이즈 축적, 재사용성 저하
- **draft를 정식 문서처럼 취급** → retrieval precision 붕괴

→ Runtime은 **스코어링·필터링 최적화**, Obsidian은 **사람 읽기 최적화**. 최적화 방향이 달라 따로 둔다.

### 외부 표준 매핑 (MemGPT/Letta 3-tier)

| MemGPT 개념 | 본 시스템 위치 |
|-------------|---------------|
| core memory (always in-context, RAM) | `00_Home/Current_Focus.md` + task `readFirst` 최상위 |
| archival memory (disk vector store) | Obsidian Vault 전체 + `.claude/runtime/knowledge/*.jsonl` |
| recall memory (conversation history) | `10_Worklogs/Auto/*.md` + `.claude/runtime/events/*.jsonl` |
| self-directed memory management | `<projectId>-lead` agent (§7 능동 큐레이터) |

**벡터 검색 미도입 이유**: 현재는 키워드+자카드로 충분. lesson 100+ 시점에서 재평가 (D-13).

---

## 3. 학습 축적의 4-channel 구조 (§1-3)

코드가 쌓이면 자연히 쌓여야 하는 **지식의 4종**을 write-back target으로 명시 분리.

| 채널 | 트리거 | 위치 | 재사용 방식 |
|------|--------|------|-------------|
| **Decision** | 영속 결정 / 정책 변경 | `07_Decisions/` | 다음 task `knowledge_hits` |
| **Lesson** | 재사용 가능 교훈 / guardrail 발견 | `08_Lessons/` | 다음 task `knowledge_hits` |
| **Troubleshooting** | 반복 실패 패턴 | `06_Troubleshooting/` | 실패 시 자동 로드 |
| **Worklog** | 세션 요약 / 핸드오프 | `10_Worklogs/` | 다음 세션 진입점 |

### Draft-first 원칙 (§1-4)

모든 자동 생성물은 `Drafts/`에 저장. **정식 문서 승격은 사람 결정**.

```
Auto draft (08_Lessons/Drafts/...)
    ↓ 사람이 검토 + 승격 결정
정식 문서 (08_Lessons/<scope>/<slug>.md)
    ↓ 다음 task-start에서 knowledge_hits로 추천
```

**draft도 retrieval 대상**. 승격 안 해도 점진 학습 성립.

### 왜 draft-first인가

대안: "자동 승격" → retrieval에 노이즈 누적 → precision 붕괴

본 시스템: "자동 draft + 수동 승격" → 사람이 품질 필터링. 승격 게이트 = precision 보호장치.

---

## 4. 4-Layer 메모리 모델 (§1-6 v3 전면 재설계)

### 왜 단일 lesson 아닌 4계층인가

단일 lesson 채널의 결정적 결손 2가지:

| 결손 | 학계 표준 | 기존 시스템 |
|------|-----------|-------------|
| 메모리 타입 미분화 | episodic / semantic / procedural / reflective 4계층 | 모든 게 lesson 한 곳에 섞임 |
| 정적 저장만 | 메모리 evolution (A-Mem, NeurIPS 2025) | 한 번 쓰면 끝 |

### 4-Layer 구조

| Layer | 외부 표준 | 본 시스템 위치 | 트리거 |
|-------|-----------|----------------|--------|
| **L1 Episodic** | Generative Agents (Park 2023) memory stream | `.claude/runtime/events/*.jsonl` | 모든 도구 호출 자동 |
| **L2 Semantic** | LinkedIn Cognitive Memory + A-Mem | `08_Lessons/` + `knowledge/lessons.jsonl` | task close 시 `buildLessonDraft` |
| **L3 Procedural** | Memp (arxiv 2508.06433) | `09_Templates/Procedures/` | 30일 내 동일 패턴 3회 반복 감지 |
| **L4 Reflective** | Reflexion (NeurIPS 2023) | `08_Reflections/` | task close 시 failures ≥ 1 |

### 왜 4계층이 효과적인가

- **L1 (원시 이벤트)**: 무엇을 했는가. 감시/재현용
- **L2 (추출된 지식)**: 무엇을 배웠는가. 재사용용
- **L3 (재사용 워크플로우)**: 어떻게 하는가. 탐색 비용 절감용
- **L4 (반성)**: 왜 실패했는가. 재실패 방지용

각 계층이 **다른 retrieval index**를 가져서 task 종류에 맞는 layer를 우선 조회 가능.

### 학술 예상 효과

- Reflexion (Shinn 2023): 코딩 task pass rate **+10~20%p**
- A-Mem (Xu 2025, NeurIPS): retrieval 정확도 **+18%**
- Generative Agents 3축 스코어링 (Park 2023): 모든 축이 critical (ablation 입증)

---

## 5. A-Mem 스타일 메모리 진화

### 왜 진화가 필요한가

기존 동작: lesson 생성 후 영원히 동일 텍스트 유지. 새 정보 들어와도 무관.

→ 30일 후 첫 번째 lesson이 10번째 lesson과 모순돼도 모름.

### 진화 알고리즘

```
1. 새 lesson L_new 생성
2. retrieval로 L_new와 의미상 가까운 기존 lesson N개 (top-3) 찾음
3. 자카드 유사도 ≥ 0.7 → evolution 후보
4. rule-based 판정 (LLM 미사용 — 비용 회피)
5. 확정 시 기존 lesson frontmatter에 evolved_at: [{at, from_lesson}] append
6. in-place write (파일명 변경 X, git diff로 이력 보존)
```

**구현**: `core/memory/memory-evolution.mjs`

### 왜 LLM 판정 안 쓰나 (D-7)

- A-Mem 원문은 LLM 판정 사용
- 본 시스템은 **비용 폭증 회피** 결정
- 자카드 유사도만으로 rule-based 판정
- Step 10에서 LLM 판정 도입 재평가 가능

---

## 6. 3축 retrieval 스코어링 (Park 2023)

### 공식

```
score = α_recency    × exp(-decay × days_since_last_access)
      + α_importance × (importance / 10)
      + α_relevance  × jaccard(promptTokens, itemTokens)
```

**default**: α = (1.0, 1.0, 1.5), decay = 0.05

### 왜 3축 전부 필요한가

ablation 실험 (Park 2023): 3개 축 중 하나라도 빠지면 성능 저하.

- Recency만: 오래된 중요 지식 무시
- Importance만: 최근 맥락 무시
- Relevance만: 과거에 유용했던 패턴 무시

### 왜 relevance만 가중치 1.5인가

Park 2023은 모두 1.0이지만, 본 시스템은 **임베딩 미도입** → relevance 신호가 약함 → 1.5로 보강.

30일 운영 후 χ² 테스트로 가중치 튜닝 예정 (Open Question).

### 구현

`core/memory/retrieval-scoring.mjs :: scoreItem(item, ctx)`

manifest `retrievalWeights` 필드로 프로젝트별 오버라이드 가능.

---

## 7. Lead 에이전트 = 능동 큐레이터 (§1-7)

### 왜 lead 에이전트가 필요한가

Claude는 기본적으로 "수동 컨텍스트 소비자". `readFirst`를 받기만 함.

MemGPT 연구(arxiv 2310.08560)의 핵심 통찰:
> "Agent는 수동적 컨텍스트 소비자가 아니라 능동적 큐레이터."

### Lead의 3역할 (능동)

1. **승격 판단**: draft `confidence: high` + 재사용 2회 이상 감지 시 `/architecture-promote` 제안 (자동 승격 금지)
2. **관련성 재순위**: task 진행 중 readFirst 추천 vs 실제 읽은 문서 교집합 < 30%이면 `context_routes.json:groups` 업데이트 diff 제안
3. **lesson 품질 점검**: `trigger_keywords` / `applicable_when` 비어있으면 경고

### 왜 프로젝트당 1개인가 (D-8)

4-channel writeback은 **한 주체가 조율해야 일관성**. 에이전트 분산 시:
- 같은 이벤트가 두 채널에 중복 기록 (P4 dedup 이슈)
- 한 채널 누락
- 승격 판단 일관성 깨짐

### 왜 Subagents 모드인가 (D-8)

- Claude Code Agent Teams (v2.1.32+) 실험적
- shared task list / mailbox / file-lock 미도입
- 현재 필요 없음. 필요 시 Step 10에서 승격

### 구현

`templates/agents/_lead.md` → init 시 `{{PROJECT_ID}}-lead.md`로 치환 복사.

---

## 8. "Code map first, Generated second, Official last" (§1-4)

### 왜 즉시 공식 문서로 안 쓰나

대안: 새 아키텍처 변경 감지 → 바로 `04_Architecture/*.md` 생성

결과: 스텁 문서 증가 → retrieval precision 하락 → 다음 task `readFirst`에 쓸모없는 추천 섞임.

### 순서

```
public surface 감지 (code-index)
    ↓
04_Architecture/Generated/*.md (임시 후보)
    ↓
recommendation: promote
    ↓
정식 04_Architecture/*.md (사람 승격)
```

**승격 게이트 = 사람 결정**. 자동 승격 금지.

### 구현

- 감지: `core/architecture-utils.mjs`
- 임시 쓰기: `04_Architecture/Generated/`
- 승격: `/architecture-promote` slash command (사람 트리거)

---

## 9. "알고리즘 shared, 데이터 project-local" (§1-5)

### 경계

```
$CLAUDE_RUNTIME_HOME/ (패키지)
├── core/         ← shared 알고리즘 (수정 금지)
├── commands/     ← shared CLI (수정 금지)
└── templates/    ← shared 뼈대 (수정 금지)

<projectDir>/.claude/
├── runtime/      ← project-local 상태 (prj별 분리)
├── agents/       ← project-local 에이전트
└── hooks/        ← project-local hook wrapper

<vaultRoot>/      ← project-local 지식 (prj별 격리)
```

### 왜 이 경계가 불변인가

**엔진 개선이 모든 프로젝트에 전파되는 구조**:
- `$CLAUDE_RUNTIME_HOME`에서 `git pull` 1회 = 전 프로젝트 enginenow 업데이트
- 각 프로젝트는 자기 데이터만 관리

**반대 방향 (프로젝트가 shared 수정)**:
- 한 프로젝트의 hack이 다른 프로젝트에 전파
- 업데이트 conflict 빈발
- 결국 프로젝트별 fork → 공유 의미 소멸

### 구체 불변 규칙

- Lead 에이전트는 `$CLAUDE_RUNTIME_HOME/core/` 수정 시도 시 PreToolUse hook이 차단 (AC-17)
- doctor C11이 `templates/_manifest.json` SHA256으로 패키지 무결성 검증
- 프로젝트별 `runtime-manifest.json`의 6축으로 주권 경계 선언

---

## 10. Closed Decisions (§12 1-7)

**재논의 금지**. 설계서 작성 중 발생한 Open Question들을 확정한 결과.

### 12-1. task-usage 병합 base
- **결정**: Talkup 400줄 base + talkSim 329줄 고유 기능 머지
- **근거**: Talkup 버전이 더 풍부. base 교체 비용 큼

### 12-2. preserveHooks 범위
- **결정**: **프로젝트 로컬 정의**. 글로벌 기본값 없음
- **근거**: TalkUp 8개는 TalkUp 고유. talkSim/신규 프로젝트는 빈 배열

### 12-3. Current_Focus 주입
- **결정**: init 자동 주입 X. **lead 템플릿이 런타임에 Read**
- **근거**: Current_Focus는 자주 바뀜. 템플릿 하드코딩 시 stale

### 12-4. doctor 실패 시 롤백
- **결정**: 자동 롤백 + 확인 프롬프트
- **근거**: spec-kit 패턴. 멱등성 원칙. `--no-rollback-on-failure` CI 모드 지원

### 12-5. 선택적 볼트 루트
- **결정**: managedRoots 선언분만 검증. **기본 9개 fallback**
- **9개**: 00_Home, 04_Architecture, 06_Troubleshooting, 07_Decisions, 08_Lessons, 08_Reflections, 09_Templates, 09_Templates/Procedures, 10_Worklogs

### 12-6. Manifest 6축 계약
- **필수 6축**: projectTag, defaultScope, surfacePatterns, scopeFolderMap, preserveHooks, sessionEndPipeline
- **optional 확장**: coreHooks, managedRoots, retrievalWeights, memoryLayers
- **doctor C02**: 6축 누락 시 FAIL, 확장 누락 시 PASS

### 12-7. task-start --dry-run
- **결정**: 내부 툴링 전용 (doctor C09, golden-task-runner)
- **사용자 `/task-start`로 직접 호출 스코프 밖**
- **동작**: 파일 쓰기 skip + event 주입 skip + stdout 9필드 JSON 동일

---

## 11. Open Questions (현재 미결정, 운영 데이터로 결정)

### retrieval 가중치 튜닝
- 현재 default (1.0, 1.0, 1.5)
- 30일 운영 후 χ² 테스트로 재조정 예정
- Park 2023의 leave-one-out ablation 방법 참고

### Quality 지표 임계값 (§5-②-C)
- Precision@5 ≥ 0.60 (초기 보수적, 업계 0.7 대비)
- 실측 후 조정

### Procedural distillation LCS vs LLM
- 현재 LCS 알고리즘만 (rule-based)
- LLM 요약 도입 여부는 실측 품질 후 결정

### NDCG manualRelevanceScores 자동화
- 현재 `golden-tasks.json`의 수동 매핑 + `file_read` 교집합 fallback
- LLM 기반 관련성 판정은 Step 10 미래

### Agent Teams (v2.1.32+) 승격 시점
- 현재 Subagents 모드
- shared task list / mailbox 필요해지면 Step 10

### 벡터 검색 / 임베딩 도입
- 현재 키워드 + 자카드
- lesson 100+ 시점에서 재평가 (Step 10)

---

## 12. "왜 이 대안은 선택 안 했나" — 거절 이력

### ❌ Obsidian Dataview / vault 내 검색
- **왜 고려**: 이미 Obsidian 자체가 검색 기능 제공
- **왜 거절**: 
  - Claude가 Obsidian 앱을 실행하지 못함
  - Markdown 파싱 비용 + retrieval precision 낮음
  - runtime compact index가 더 빠름

### ❌ Vector DB (Pinecone, Chroma 등)
- **왜 고려**: 의미 유사도 검색이 가장 강력
- **왜 거절**:
  - 외부 서비스 의존
  - 임베딩 비용
  - 프로젝트 격리 복잡
  - 현재 규모(lesson < 100)에선 과도

### ❌ Graph DB (Neo4j)
- **왜 고려**: A-Mem 원문이 지식 그래프 모델
- **왜 거절**:
  - 설치 복잡도
  - 사람이 읽을 수 없음 (Markdown 우위)
  - JSONL + 자카드로 충분

### ❌ LLM 판정 모든 곳
- **왜 고려**: 품질 최고
- **왜 거절**:
  - 비용 폭증 (evolution + distillation + importance scoring 등)
  - latency 증가
  - rule-based가 80% 커버

### ❌ Agent Teams v2.1.32+ 전면 도입
- **왜 고려**: 병렬 작업 능력
- **왜 거절**:
  - 실험적 기능
  - 토큰 비용 선형 증가
  - 현재 Subagents 모드로 충분

### ❌ 단일 monorepo로 모든 프로젝트 통합
- **왜 고려**: 한 저장소 관리 편함
- **왜 거절**:
  - 프로젝트별 지식 격리 원칙(D-1) 위배
  - 보안 / 권한 분리 어려움
  - npm/node ecosystem 관례와 맞지 않음

---

## 13. 외부 학술 표준 참조 매핑

| 표준 | 논문/출처 | 본 시스템 적용 |
|------|----------|---------------|
| Generative Agents 3축 스코어링 | Park 2023 (dl.acm.org/10.1145/3586183.3606763) | `retrieval-scoring.mjs` scoreItem |
| MemGPT 3-tier memory | arxiv 2310.08560 | 2-track 구조 + Current_Focus/readFirst |
| A-Mem agentic memory | arxiv 2502.12110 (NeurIPS 2025) | `memory-evolution.mjs` |
| Reflexion | arxiv 2303.11366 (NeurIPS 2023) | `buildReflectionDraft` + L4 `08_Reflections/` |
| Memp Procedural Memory | arxiv 2508.06433 | `distillProceduralMemory` + L3 `09_Templates/Procedures/` |
| LinkedIn Cognitive Memory Agent | InfoQ 2026/04 | L2 semantic + Zettelkasten atomic |
| Zettelkasten (Luhmann) | 전통 PKM | lesson frontmatter 11필드 + linked_lesson |
| RAG eval (Precision@k/Recall@k/MRR/NDCG) | RAG 업계 2026 | `core/eval/metrics.mjs` |
| Spec-kit / AgentForge scaffolding | GitHub spec-kit | `init-project.mjs` + doctor 12체크 |
| Snapshot testing (Percy/Argos) | Visual regression 업계 | `eval-compare.mjs` schemaMatch |

---

## 14. "이 원칙을 위배하면 일어나는 일"

각 원칙 위배 시 실제로 나타나는 증상. 리뷰 시 체크리스트로 사용.

| 원칙 | 위배 증상 |
|------|-----------|
| §2 2-track | readFirst에 본문이 섞여 주입 → 토큰 폭발 |
| §3 4-channel | 모든 draft가 08_Lessons에만 쌓임 → 검색 시 noise |
| §4 4-Layer | 절차 지식이 lesson과 섞임 → 재사용 시 전부 읽어야 함 |
| §5 A-Mem 진화 | lesson 간 모순 누적 → 오래된 lesson이 잘못된 지침 제공 |
| §6 3축 스코어링 | 최근 접근 lesson만 계속 추천 → 과거 통찰 매몰 |
| §7 Lead 1개 | 여러 에이전트가 승격 경쟁 → 기준 일관성 붕괴 |
| §8 Draft-first | Generated가 정식 문서로 즉시 승격 → precision 붕괴 |
| §9 shared/local | 프로젝트가 core/ 수정 → git pull 시 conflict |

---

## 15. "다음 세션이 반드시 이해해야 할 3가지"

새 세션이 이 프로젝트 질문 받았을 때 **이것만 알면 80%는 답 가능**:

### 🎯 1. 2-track 원칙 (§2)
Runtime compact + Obsidian curated. 합치려 하지 마. 자동 주입은 runtime만, 본문은 사람이 명시 Read.

### 🎯 2. 4-Layer 메모리 (§4)
L1 Episodic → L2 Semantic → L3 Procedural → L4 Reflective. 각자 다른 트리거, 다른 저장소.

### 🎯 3. Draft-first (§3, §8)
자동 생성은 전부 Drafts/. 정식 문서 승격은 사람. 자동 승격 제안은 OK, 자동 실행은 금지.

---

**이 문서는 §10 Closed Decisions + §11 Open Questions을 제외하곤 변경 최소화한다. 새 원칙 추가는 기획서(`eventual-jingling-adleman.md`) 업데이트 후 반영.**

**관련 문서**:
- 사용법 → [docs/INSTALL.md](./docs/INSTALL.md) / [docs/QUICKSTART.md](./docs/QUICKSTART.md)
- 내부 동작 → [docs/FLOW.md](./docs/FLOW.md)
- 인수인계 엔트리 → [HANDOFF.md](./HANDOFF.md)
- 기획서 원본 → `C:/Users/adkrn/.claude/plans/eventual-jingling-adleman.md`
