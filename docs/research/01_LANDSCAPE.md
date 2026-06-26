# 01 — 유사 프로젝트 지형도 (Landscape)

**목적**: "Claude Code + Obsidian 마크다운 장기기억 런타임"과 같은 문제를 푸는 프로젝트들이 각 기능을 *어떻게* 구현했는지, 우리 설계와 대응시켜 정리.
**출처**: GitHub / arXiv / HuggingFace 직접 리서치 (2026-06-26). star·ID·모델명 전부 fetch 검증.

---

## 0. 우리 프로젝트 좌표 (비교 기준점)

| 축 | 우리 구현 | 코드 위치 |
|----|-----------|-----------|
| 저장 | 평문 마크다운(Obsidian Vault) + 런타임 JSONL 인덱스 2-track | `08_Lessons/` 등 + `.claude/runtime/knowledge/*.jsonl` |
| 검색 | Generative Agents 3축(recency·importance·relevance) + applicable_when 게이트 + MMR | `core/memory/retrieval-scoring.mjs`, `mmr.mjs` |
| relevance | **Jaccard(토큰집합)** — 임베딩 아님 | `retrieval-scoring.mjs:226` |
| 쓰기 | 세션 종료 시 Claude 가 직접 산출물 작성(decision/lesson/trouble/arch) | `core/learning-curate.mjs`, `/task-close` |
| 진화 | A-MEM 방식 rule-based(jaccard≥0.7, top-3, append-only `evolved_at`) | `core/memory/memory-evolution.mjs` |
| 라이프사이클 | session-start 주입 → 수정이벤트 기록 → task-close 산출물 | `commands/session-start.mjs`, `task-close` |

→ 이 좌표를 기준으로 아래 프로젝트들의 "장점"과 "우리와 다른 점"을 읽으면 된다.

---

## 1. GitHub — 기능별 구현 방식

### 1-A. 가장 닮은 3대장 (직접 벤치마크 대상)

| 프로젝트 | ⭐ | 닮은 축 | 핵심 구현 | 우리가 배울 점 |
|----------|-----|---------|-----------|----------------|
| **basic-memory** (`basicmachines-co`) | ~3.3k | **저장 구조** | 평문 마크다운 SSOT + frontmatter + wikilink 그래프, FTS+시맨틱(FastEmbed+SQLite) 하이브리드, 인간/AI 양방향 쓰기, MCP 네이티브 | wikilink 를 *기억 간 관계*로 쓰는 법. 우리 `[[name]]` 링크와 동일 철학 |
| **claude-mem-lite** (`sdsrss`) | ~50 | **검색 철학** | SQLite + **FTS5 + TF-IDF**, 벡터 DB 없음, episode batching. "claude-mem 대비 600배 저비용" 명시 | **우리 "임베딩 미루고 lexical" 결정의 업계 쌍둥이.** TF-IDF 구현 참고 |
| **claude-mem** (`thedotmack`) | ~84k | **라이프사이클** | 5개 훅(SessionStart/UserPromptSubmit/PostToolUse/Stop/SessionEnd), 3계층 progressive disclosure(search 50~100토큰→timeline→full, 10배 토큰절감), SQLite+Chroma 하이브리드 | **progressive disclosure** — 우리 prompt-context 주입을 "요약 인덱스 먼저, 상세는 요청 시"로 계층화 |

### 1-B. LLM 에이전트 메모리 프레임워크 (설계 참고)

| 프로젝트 | ⭐ | 저장 | 검색 | 쓰기 | 특이점 |
|----------|-----|------|------|------|--------|
| **Mem0** (`mem0ai/mem0`) | ~59.5k | 벡터+그래프+KV 하이브리드 | **BM25 키워드+시맨틱+엔티티 병렬 융합** | LLM 추출(ADD-only) | 우리처럼 키워드를 *주 신호 중 하나*로 융합하는 유일한 대형 프레임워크 |
| **Letta/MemGPT** (`letta-ai`) | ~23.5k | 메모리 블록(persona/human 라벨), core/archival 2계층 | 에이전트가 함수콜로 archival 검색 | 에이전트가 자기 메모리 직접 편집 | "LLM as OS" 패러다임. 메모리 압력 시 self-edit |
| **cognee** (`topoteretes`) | ~22.5k | 지식그래프+벡터 | auto-routing(그래프/벡터/세션) | `add→cognify→improve` 파이프라인 | **명시적 Forget(삭제) 연산** — 우리 decay 미구현 보완 참고. Claude Code 플러그인 있음 |
| **Zep/Graphiti** (`getzep`) | ~4.7k | **bi-temporal 지식그래프** | 그래프+시맨틱+키워드 하이브리드 | 증분 ingest, 오래된 edge 무효화(삭제X) | LongMemEval 강점이 *temporal 메타데이터* 덕분(임베딩 아님). 우리는 recency decay 로 시간축 이미 다룸 |
| **A-MEM** (`agiresearch`, NeurIPS'25) | ~1.1k | **Zettelkasten 노트망**(ChromaDB) | 시맨틱+노트링크 추적 | 신규노트→기존노트 동적링크→**메모리 진화** | **우리 memory-evolution.mjs 의 학술 원형.** 우리는 rule-based 로 이미 구현 |
| **MemoryBank** (논문/구현) | — | 3-pillar | 임베딩 | **에빙하우스 망각곡선 decay** | 우리 decay 빈자리의 직접 설계 모델 |

### 1-C. Obsidian + 마크다운-as-메모리

| 프로젝트 | ⭐ | 검색 방식 | 우리와 차이 |
|----------|-----|-----------|-------------|
| **khoj** (`khoj-ai`) | ~35.3k | pgvector 임베딩 인덱스, Obsidian 플러그인 | 임베딩 퍼스트. 우리는 lexical 퍼스트 |
| **Copilot for Obsidian** (`logancyang`) | ~7.3k | 시맨틱+백링크, Agent Mode 툴콜 | 볼트를 영구메모리로 보는 비전은 동일 |
| **Smart Connections** (`brianpetro`) | ~5.2k | **100% 온디바이스 임베딩**, `.smart-env/` 캐시 | 임베딩 온리(BM25 없음). 우리와 정반대 노선 |

### 1-D. Claude Code 전용

| 프로젝트 | ⭐ | 저장 | 메모 |
|----------|-----|------|------|
| **MCP Knowledge Graph Memory** (공식, `modelcontextprotocol/servers`) | 레포 ~87.7k | 로컬 JSONL(`memory.json`) 그래프 | CLAUDE.md+MCP 메모리의 기준선. 우리 JSONL 인덱스와 같은 경량 철학 |
| **obsidian-claude-code-mcp** (`iansinnott`) | ~310 | 볼트 자체(WebSocket 브릿지) | Claude Code↔Obsidian 직결의 레퍼런스. 우리는 런타임 계층이 추가됨 |

---

## 2. arXiv — 학술 근거 (전부 ID 검증)

### 2-A. 검색 방법 (임베딩 결정 직결)

| # | 논문 | arXiv | 결정적 발견 |
|---|------|-------|-------------|
| ⭐ | Demonstration Retrievers in RAG for Coding | **2410.09662** (2024) | *"BM25 는 효과적이나 지식베이스가 1000건을 넘으면 효율이 떨어진다."* HNSW 는 1000건 초과에서만 44배 빨라짐(RougeL -1.74%). **N=60 은 임계 한참 아래 → BM25 의 효율 페널티 자체가 없음. 도메인도 코딩이라 정확히 일치.** |
| | Dense vs Sparse Strategy Selection | 2109.10739 (2021) | 쿼리별 sparse/dense/hybrid 라우팅. 특정 쿼리는 BM25 가 정답 |
| | HippoRAG | 2405.14831 (2024) | 그래프+PageRank 가 dense 대비 10~30배 저렴 +20%(멀티홉). 구조 > raw dense |
| | Mem0 | 2504.19413 (2025) | 전체 히스토리 투척 대비 +26%, 토큰 90%+ 절감 |

### 2-B. 쓰기·통합·망각 (우리 산출물/진화 직결)

| 논문 | arXiv | 우리 대응 |
|------|-------|-----------|
| **Generative Agents** (Stanford) | 2304.03442 (2023) | `score = recency(decay) + importance(1~10) + relevance(cos)`. **우리 retrieval-scoring.mjs 의 직계 원형.** 이미 구현. importance 누적 150↑ 시 reflection 생성(우리 reflective-store 와 유사) |
| **A-MEM** | 2502.12110 (2025) | 노트 자동링크+진화. **우리 memory-evolution.mjs 의 원형.** 이미 rule-based 구현 |
| **Reflexion** | 2303.11366 (2023) | 실패 후 자기반성을 텍스트로 기록. 우리 lesson/trouble 세션작성과 동형 |
| **MemoryBank** | 2305.10250 (2023) | 에빙하우스 망각곡선 decay. **우리 빈자리** — 보일러플레이트 54건 청소/노후 down-weight 의 설계모델 |

### 2-C. 소규모 검색 결론 (문헌 종합)

~60건 규모 결론: **lexical 유지가 옳다. 임베딩은 마진 가치가 없는 지점.**
1. 크로스오버 ~1000건(2410.09662). 60건엔 ANN 이 없는 문제를 푸는 것.
2. dense/sparse 는 다르게 실패 — 우리 콘텐츠(식별자·에러문자열·파일경로·API명)는 lexical 이 강한 영역.
3. 의미 필요해지면 hybrid(RRF)가 둘 다보다 낫고, 같은 seam 에 나중에 무중단 추가 가능.
4. 구조(HippoRAG)·통합(Mem0)이 검색백엔드 교체보다 레버리지 큼 → **쓰기 측 품질이 답.**

---

## 3. HuggingFace — (만약) 임베딩 갈 때 모델 후보

성희님 한/영 혼용 + CPU + ~60건 기준. **단, 현시점 권장은 "임베딩 보류"** (위 결론).

| 순위 | 모델 | 크기 | 차원 | 적합성 |
|------|------|------|------|--------|
| 1 | `intfloat/multilingual-e5-small` | ~470MB | 384 | 500MB↓ + 한영동시 + MIT 인 유일 모델 |
| 2 | `dragonkue/multilingual-e5-small-ko` | ~470MB | 384 | 위 모델 한국어 파인튜닝 fork, 드롭인 |
| 3 | `BAAI/bge-small-en-v1.5` | ~33MB | 384 | 영어 위주면. 한국어 약함 |
| — | `jhgan/ko-sroberta`, `BM-K/KoSimCSE` | ~440MB | 768 | **부적합**: retrieval 아닌 STS 튜닝 + 768차원(2배 저장) |

도입 시 배선점: `retrieval-scoring.mjs` 의 relevance 자리에 `relevanceFn` 주입(코사인). 자세히는 [03_ROADMAP.md](./03_ROADMAP.md) Phase E.

HF 솔직한 평가: 이 *아키텍처 결정*엔 GitHub/arXiv 가 HF 보다 유용. HF 가치는 모델 카탈로그뿐.
