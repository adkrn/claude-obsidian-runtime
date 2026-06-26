# 02 — 갭 분석 (현재 구현 vs 이상)

**목적**: 유사 프로젝트의 장점(01)에 비춰, *코드 기준* 우리가 어디에 있고 무엇이 비었는지.
**근거**: 작성 시점 `core/` 실제 파일. 라인은 함수명으로 재확인 권장.
**시작점**: 다음 세션은 이 문서부터 읽고 [03_ROADMAP.md](./03_ROADMAP.md) 로 가면 된다.

---

## 0. 한눈에 — 무엇이 이미 좋고, 무엇이 비었나

| 기능 | 상태 | 근거 |
|------|------|------|
| Generative Agents 3축 스코어링 | ✅ 충실 구현 | `retrieval-scoring.mjs:217 scoreItem` (recency exp-decay + importance/10 + relevance) |
| A-MEM 메모리 진화 | ✅ rule-based 구현 | `memory-evolution.mjs:142 evolveAgainst` (jaccard≥0.7, top-3, append-only) |
| applicable_when 구조 게이트 | ✅ 구현 | `retrieval-scoring.mjs:139 evaluateGate` (path_glob/trigger_keywords/scope_id AND) |
| frontmatter 안전장치 | ✅ 구현 | `memory-evolution.mjs:597 applyEvolutionWithSafeguard` (SHA256+rollback) |
| 세션 산출물 4종 작성 | ✅ 정상화(D-23~D-27) | `learning-curate.mjs::writeSession*` |
| **relevance 가 trigger_keywords 무시** | ❌ **G1 — 최대 갭** | `learning-curate.mjs:429 buildCandidateRow` |
| **BM25/IDF (토큰 빈도 가중)** | ❌ G2 | relevance 가 Jaccard(빈도 무시) |
| **char n-gram (형태변형 흡수)** | ❌ G3 | 한글 조사/띄어쓰기 변형에 취약 |
| **decay 기반 망각/청소** | ❌ G4 | recency 는 *읽혔지만*, *오래되고 안 읽힌* 보일러플레이트 청소 메커니즘 없음 |
| **progressive disclosure** | ❌ G5 | 주입이 단일 계층(요약 인덱스→상세 분리 없음) |

---

## G1. relevance 가 `trigger_keywords` 를 완전히 버린다 (최우선)

**증상**: 세션이 채운 고품질 신호 `trigger_keywords`(Pasim62 488개)가 검색 relevance 계산에 0% 반영.

**코드 추적**:
```
buildCandidateRow (learning-curate.mjs:429)
  → tokens = uniqueStrings([
      tokenizeSearchText(title),
      tokenizeSearchText(summary),
      relatedFiles.map(tokenizeSearchText)        // ← title+summary+files 만
    ]).slice(0, 24)
  → trigger_keywords: candidate.trigger_keywords  // ← 별도 필드로 저장만 됨

scoreItem (retrieval-scoring.mjs:226)
  → relevance = jaccardSimilarity(promptTokens, item.tokens)  // ← tokens 만 봄
```

`trigger_keywords` 는 `evaluateGate`(`:174`)의 **게이트 통과 판정에만** 쓰이고, *점수*에는 안 들어간다. 즉 세션이 "이 교훈은 이런 키워드일 때 꺼내라"고 명시적으로 채운 최고 신호가 랭킹에서 버려진다.

**왜 최대 즉효인가**: 이건 신규 데이터 수집·외부 의존 없이, *이미 존재하는* 신호를 연결만 하면 된다. 의존성 0, 네트워크 0ms.

**해결 방향**(03 Phase A): `tokens` 에 `trigger_keywords` 를 가중 병합하거나, relevance 식에 trigger_keywords 오버랩 항을 별도 가산.

---

## G2. Jaccard 는 토큰 빈도/희소성을 무시한다 (BM25/IDF 빈자리)

**증상**: 상위 토큰 7개가 전부 보일러플레이트(`captured`/`reusable`/`workflow`... 82~100% 문서 등장). Jaccard 분모(union)를 오염시켜 진짜 변별 토큰의 신호를 희석.

**근거**: `jaccardSimilarity`(`retrieval-scoring.mjs:64`)는 집합 교집합/합집합 — 모든 토큰을 동등 취급. "거의 모든 문서에 있는 토큰"과 "이 문서에만 있는 토큰"을 구별 못 함. 이게 정확히 IDF 가 푸는 문제.

**연관**: arXiv 2410.09662 가 코딩 태스크에서 BM25 우수성 입증. claude-mem-lite 가 실제로 TF-IDF 채택.

**해결 방향**(03 Phase B): IDF 가중 토큰 오버랩. idf 는 lessons.jsonl 1회 스캔으로 closure 빌드 → `relevanceFn` 으로 주입. 외부 의존 0.

---

## G3. 형태변형/띄어쓰기에 취약 (char n-gram 빈자리)

**증상**: "씬전환" vs "씬 전환" → Jaccard 0.0 (다른 토큰). 한글 조사·복합어·띄어쓰기 변형이 흔한데 토큰 단위라 못 흡수.

**근거**: `tokenizeSearchText`(`runtime-lib.mjs:218`)는 `가-힣` 지원·camelCase 분리·2자 최소·stopword 는 하나, 하지만 **char n-gram 은 없음**. 토큰 정확일치만 매칭.

**실측(메모리 노트)**: trigram 도입 시 "씬전환"vs"씬 전환" 0.0→1.0. 단 "씬"vs"scene"(한↔영)은 trigram 도 0.0 → 소형 동의어 사전이 유일 해법(후순위, 실제 미스 로그 후).

**해결 방향**(03 Phase B): relevance 의 보조항으로 char-trigram Jaccard 가산. 토큰 Jaccard 와 가중합.

---

## G4. decay 기반 망각이 없다 (보일러플레이트 54건 잔존)

**증상**: 옛 보일러플레이트 라인(`read read_first notes before writing a plan`)이 전 프로젝트 lessons.jsonl·볼트문서에 54건 잔존(Pasim62 10, talkSim 34, magicDraft 7, productSurvey 2, musicGame 1). D-26 코드차단은 *새* lesson 만 막아 *옛* 데이터는 미청소.

**근거**: recency 는 `last_accessed_at` 기반 *읽힘* 점수일 뿐, "오래됐고 안 읽혔고 중복인 항목을 *제거/down-weight*"하는 루프가 없다. cognee 의 Forget, MemoryBank 의 망각곡선이 비어 있는 자리.

**왜 중요**: 임베딩을 나중에 켜면 이 54개가 그대로 벡터 오염원. 그 전에 청소가 선결과제(메모리 노트 결론).

**해결 방향**(03 Phase A): (1) 보일러플레이트 일괄 청소(lessons.jsonl + 볼트 rules, 백업 후, 세션 rules 보존). (2) 장기적으로 decay+access_count 기반 stale 후보 리포트.

---

## G5. 주입이 단일 계층 (progressive disclosure 빈자리)

**증상**: session-start 주입이 "요약 인덱스 먼저, 상세는 요청 시"로 계층화돼 있지 않음. claude-mem 은 50~100토큰 인덱스→timeline→full 로 10배 절감.

**근거**: 우리도 MMR 로 다양성·payload_ref 로 지연로딩의 씨앗은 있으나(`mmr.mjs`, event-reader payload_ref), 명시적 3계층 disclosure 컨벤션은 없음.

**우선순위**: 낮음(검색 정확도 개선이 먼저). 토큰 예산이 실제 압박될 때 착수.

---

## 부차 관찰

- **decision/architecture 산출물은 trigger_keywords/applicable_when 이 비어** 게이트가 무력. 단 tokens 검색은 정상. 임베딩 도입 시 자연 해소되나, 그 전엔 G1 의 trigger_keywords 가중이 lesson 만 돕고 decision 은 못 도움 — 별도 고려 필요. **[2026-06-26 해소]** `writeSessionDecision`/`writeSessionArchitecture` 가 세션 입력의 trigger_keywords/applicable_when 을 candidate→row 로 보존하도록 수정(커밋 `7800274`). task-close.md/두 write CLI 지시문도 보강. 기존 빈 행은 점진(다음 update 시) 채움.
- **frontmatter 스키마 통일 — 검토 결과 추가 작업 불필요(2026-06-26).** 4종 vault 산출물(lesson/decision/troubleshooting/architecture)은 이미 동일 frontmatter 스키마(`title/date/task_id/type/status/scope/tags/generated_by` + `related_code`/`architecture_refs`)로 통일돼 있다 — 네 builder 모두 같은 템플릿. `verifyFrontmatter11Fields`(`memory-evolution.mjs:423`)의 11키(`id/summary/confidence/importance/related_task/related_files` 등)는 *vault 산출물용이 아니라* A-MEM 진화가 진화시킨 lesson 파일을 검증·롤백하는 별도 장치다(스키마가 다름). 따라서 11필드 검증기를 4종에 적용하는 건 부적합(전부 실패). 작성 기준(summary=교훈 한 문장, rules=구체 규칙, 보일러플레이트 금지)의 일관 적용은 G1 보강 시 task-close.md 지시문에서 이미 처리됨.
- **테스트 자산이 강함**(465 green). 모든 seam 에 테스트 있어 리팩토링 안전. G1~G3 은 `retrieval-scoring.mjs` 단일 모듈 + `relevanceFn` 주입으로 기존 465 보존 가능.
- **동기 순수성이 자산**: 현재 검색 경로는 완전 동기·순수(네트워크 0). G1~G4 는 이 속성을 보존(전부 in-process). 임베딩만 이걸 깬다 — 그래서 마지막.
