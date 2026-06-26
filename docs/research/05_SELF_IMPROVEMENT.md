# 05 — 자가발전 루프 설계 (Self-Improvement Loop)

**목적**: "검색 → 산출물 생성 → 자동개선"을 반복하며 시스템이 스스로 나아지는 닫힌 루프의 설계. 기존 워크로그-수동분석 방식을 대체.
**상태**: ⚠️ **이건 구현계획이 아니다.** 선결조건(검색개선·산출물정리)이 끝난 뒤 다음 세션이 *구현계획을 세울 수 있게* 하는 설계·근거 문서다.
**근거**: GitHub 18개 프로젝트 + arXiv 14개 논문 + HF 도구 리서치(2026-06-26). ID·URL 검증됨.

---

## 0. 왜 지금 구현하지 않는가 (선결조건)

자가발전 루프의 입력은 **"세션이 어떤 메모리를 실제로 읽고 썼는가"(read/edit 신호)**다. 이 신호의 품질이 루프 전체의 품질을 결정한다. 그래서 아래가 먼저다:

| 선결조건 | 왜 먼저인가 | 추적 |
|----------|-------------|------|
| **지시문 ① 검색개선** | 검색이 엉뚱한 lesson 을 주입하면 read 신호가 노이즈. trigger_keywords·IDF 로 *맞는 걸* 주입해야 신호가 깨끗 | `core/memory/similarity.mjs` (진행중) |
| **지시문 ② 산출물정리** | 보일러플레이트 54건이 남으면 "무용 메모리" 판정이 오염. 청소 후라야 가지치기가 정확 | `scripts/clean-boilerplate-rules.mjs` (진행중) |

→ **두 작업이 green 으로 끝나면**, 이 문서의 [§6 다음 세션 체크리스트](#6-다음-세션이-구현계획을-세울-때)로 가서 구현계획을 세운다.

---

## 1. 리서치 핵심 결론 (한 문단)

조사한 18개 프로젝트 중 **"메모리가 실제로 유용했는지를 신호로 받아 검색을 자동개선하는" 진짜 루프를 가진 건 거의 없다.** Mem0/Zep/A-MEM 의 "자기개선 메모리"는 전부 *쓰기 시점 LLM 정리*(모순 조정)일 뿐, 검색·유용성 신호를 안 본다. 진짜 "사용신호→보상→개선"은 RAG/IR 논문(REPLUG, GainRAG)과 옵티마이저(OPRO/DSPy)에만 있다. **이 런타임은 이미 부품(이벤트 로그 + 자동 채점 eval-retrieval)을 갖고 있어 이 빈자리를 메우는 위치에 있다.** 워크로그 수동분석이 비효율이라는 직관은 정확하다 — 업계 표준이 거기서 멈춰 있다.

---

## 2. 현재 vs 목표 (열린 루프 → 닫힌 루프)

```
[현재 — 끊긴 루프]
검색(주입) → 작업 → events 자동기록 → eval-retrieval 자동채점 ✅
                                              ↓ ❌ 끊김
                          reflection-run 이 draft 문서 작성 → 사람이 읽고 → 손으로 가중치 조정

[목표 — 닫힌 루프]
신호: read/edit events + 작업성공 (IPS 로 rank 편향 보정)
   ↓
분석(sleep-time 백그라운드): 메모리별 유용도 = 쓰임+성공(+)/떠도 무시(−)/쓰였는데 오도(−−)
   ↓
제안(Maker, 자율): ① 가중치 델타  ② 가지치기 후보  ③ (선택) 저정밀 메모리 재작성안
   ↓
게이트(Checker): 섀도우 재생 → eval 개선될 때만 승격. 버전드·되돌림가능
   ↓
반영 + (제안,결과) 로그 → 다음 분석으로 되먹임
```

---

## 3. 4가지 검증된 패턴 → 우리 코드 seam 매핑

리서치가 공통 도출한 골격: **신호 → 분석 → 제안 → 게이트 → 반영**. ROI·안전 순.

### 패턴 B — 지표→가중치 자동튜닝 (1순위, 최저비용)
- **출처**: OPRO(arXiv 2309.03409), DSPy MIPRO(2406.11695). `(config, 점수)` 정렬 로그 → 제안 → 채점 → 승자 채택.
- **왜 1순위**: 이미 지표(Precision/Recall)와 작은 config 공간이 있음. 외부의존 0, 라이브 위험 0, 배치 재실행.
- **우리 seam**:
  - 지표 = `commands/eval-retrieval.mjs::compute` (이미 P@5/R@10/MRR/NDCG 산출)
  - config = `manifest.retrievalWeights` (alphaRelevance·triggerKeywordWeight·trigramWeight·decayRate — 지시문 ①이 이미 추가)
  - 제안기 = 신규 `commands/eval-feedback.mjs`: 작은 grid/random search 가 config 후보 → 각 후보를 eval-retrieval 로 채점 → 최고를 manifest 제안. **LLM 불필요** (lexical 노브라 탐색으로 충분).
- **주의**: eval-retrieval 은 `sampleCount < 5` 면 null. task 가 쌓인 프로젝트(Pasim62)라야 유의미.

### 패턴 C — 투표 카운터로 무용 메모리 가지치기 (2순위)
- **출처**: ExpeL(arXiv 2308.10144, AAAI'24) — 쓰이면 +1, 무시되면 −1, **0 되면 자동 제거**. MemoryBank(2305.10250) 에빙하우스 decay.
- **우리 seam — 절반은 이미 있다**:
  - `core/memory/hit-counts.mjs::bumpHitCounts` 가 이미 `{count, lastHitAt, lastTaskId}` 로 **hit 누적 중**(증가 절반 구현됨).
  - **빠진 절반**: (a) *읽혔는데 무시/실패* 시 감점 (b) count 임계 이하 + 오래됨 → 가지치기 후보.
  - 구현: `bumpHitCounts` 에 음수 신호 경로 추가 + 신규 `knowledge-prune-report.mjs`(읽기전용 리포트, 자동삭제 절대 금지).
- **안전**: 자동삭제 금지(prune 손실 사고 이력 — 메모리 `obsidian-sync prune`). 리포트만 → 사람 검토 → 승격.

### 패턴 A — read 신호로 검색기 재가중 (3순위, 데이터 쌓인 뒤)
- **출처**: REPLUG(arXiv 2301.12652) — "세션이 읽은 메모리"가 "LM이 이득 본 문서"의 이산 버전. 사람 라벨 0으로 검색기 학습.
- **우리 seam**: `relevanceFn`(지시문 ①이 깐 seam) 가중을 read 분포 쪽으로 nudge. `eval-retrieval` 의 per-task read 집합이 타깃.
- **⚠️ 2대 함정**:
  1. **rank 편향 보정 필수**(IPS, PyClick): 위에 뜬 메모리가 더 많이 읽힘 → 보정 없이 read=정답으로 쓰면 망함.
  2. **유용≠관련**(GainRAG, 2505.18710): 읽혔지만 *오도한* 메모리는 **음수**. read 만 보지 말고 작업 성공까지.
- **왜 3순위**: 신호가 통계적으로 유의미하려면 세션 로그가 충분히 쌓여야 함. B·C 로 먼저 데이터 축적.

### 패턴 D — Maker-Checker / 섀도우 게이트 (우리 차별점, 모든 패턴에 적용)
- **출처**: developer-memory 논문(2605.01567) + Letta 2-에이전트 분리. **18개 중 단 2개만** 제안·반영을 분리. 나머지는 게이트 없이 덮어씀 → 60개 store 엔 치명적.
- **우리 seam — 패턴 이미 있다**: governance Maker-Checker(`core/delegation-schema.mjs`, `delegations.jsonl`)를 자가발전에 재사용. 제안=Maker, 사람/섀도우=Checker, 반영=자동.
- **게이트 3종(싼 순)**:
  1. **섀도우/OPE**: 로그된 세션에 새 config 재생 → eval 개선될 때만 승격(라이브 위험 0). 패턴 B와 천연 결합.
  2. 카나리: 일부 세션에만 적용, 회귀 시 자동 롤백.
  3. 버전드·되돌림가능 쓰기(cognee 식). A-MEM 의 무이력 위험을 고침.
- **백그라운드 실행**: 분석·제안은 sleep-time 패스로(Letta/LangMem `ReflectionExecutor` 식 debounce) — task-start 핫패스 안 건드림.

---

## 4. 권장 닫힌 루프 (리서치 종합)

**안전 원칙**: *재가중·decay 는 완전 자동*(되돌림가능·내용보존), *내용 생성/재작성만 사람 승인*.

| 단계 | 자율/게이트 | 패턴 | 우리 구현 자리 |
|------|------------|------|----------------|
| 1. 신호 수집 | 자동 | A 기반 | events(이미) + 작업성공 플래그(신규) + IPS 보정 |
| 2. 분석(백그라운드) | 자동 | C | hit-counts 확장(±) |
| 3-a. 가중치 제안 | 자동(Maker) | B | eval-feedback.mjs (grid search) |
| 3-b. 가지치기 제안 | 자동(Maker) | C | knowledge-prune-report.mjs |
| 3-c. 내용 재작성 제안 | 자동(Maker) | LangMem 식 | (후순위) |
| 4. 게이트 | 섀도우/사람 | D | governance 재사용 + 섀도우 재생 |
| 5. 반영+로그 | 조건부 자동 | D | manifest 갱신 + 결과 로그 |

**보류 (모델접근 필요 + 보상드리프트 위험)**: 자기보상 가중치학습 — STaR(2203.14465), Self-Rewarding(2401.10020), RISE(2407.18219). 60개 store 가 못 버팀.

---

## 5. 도구: 만들 것 vs 빌릴 것 (HF 리서치)

**루프 로직은 앱레벨이라 HF에 턴키 없음 — 직접 짠다.** 단 2개 경량 부품만 빌림:

| 용도 | 도구 | footprint | 도입 지점 |
|------|------|-----------|-----------|
| 지표 계산(교차검증) | **ranx** (github.com/AmenRa/ranx) | NumPy+Numba, 서버X | P@k·R@k·MRR·NDCG + `compare()` **통계적 회귀검출**. eval-retrieval 손계산 검증용 |
| 추이 저장/시각화 | **trackio** (huggingface.co/docs/trackio) | <1k줄, 로컬 SQLite | `log()` 한 줄 → SQLite → `trackio query --sql`. 데이터 경로 서버 불필요 |
| 자동튜닝 | **자체 grid search + ranx** | 무시 | lexical 노브엔 DSPy보다 가벼움 |

**버려라**: RAGAS/TruLens/DeepEval(LLM-judge·비동기·생성품질용 — 검색지표엔 과함), BEIR/MTEB(벤치마크 스케일), DSPy MIPROv2(60개엔 call-hungry). DSPy 는 LLM 매개 단계(쿼리재작성/리랭킹)가 생길 때만, 그것도 BootstrapFewShot/COPRO 로.

> ⚠️ Python 도구(ranx)는 Node 런타임과 별프로세스. 도입 시 child_process 경계·의존성 트레이드오프를 plan mode 에서 결정. 처음엔 자체 JS 지표(이미 `core/eval/metrics.mjs` 존재)로 시작하고 ranx 는 교차검증용으로만 후순위.

---

## 6. 다음 세션이 구현계획을 세울 때

선결조건(①②) green 확인 후, 이 순서로 계획하라:

1. **현재 상태 실측 먼저**: `runtime-doctor` + `eval-retrieval` 를 Pasim62/talkSim 에 실제 실행. 작동률·precision·sampleCount 를 본다. **sampleCount < 5 면 패턴 B/A 보류**(데이터 부족) → 패턴 C(decay/카운터)부터.
2. **패턴 C 부터** (가장 안전·자율): `hit-counts` 음수 신호 + prune 리포트. 자동삭제 금지.
3. **패턴 B** (데이터 충분 시): `eval-feedback.mjs` grid search → manifest 제안. 섀도우 게이트(D) 동반.
4. **패턴 D 게이트**: governance Maker-Checker 재사용. 모든 자동반영은 섀도우 재생 통과 후.
5. **패턴 A** (로그 충분히 쌓인 뒤): IPS 보정 + 작업성공 신호 추가. GainRAG 의 "유용≠관련" 음수 크레딧 반드시.
6. **plan mode 권장 지점**: 작업성공 신호 정의(무엇이 "성공"인가), ranx child_process 경계, 섀도우 재생 구현.

**완료 정의 (루프 1차)**: (a) hit-counts ± 신호 + prune 리포트, (b) eval-feedback 가중치 제안, (c) 섀도우 게이트 1종, (d) trackio/CSV 로 precision 추이 가시화, (e) 전 과정 격리볼트 검증, (f) 자동삭제·자동덮어쓰기 0건(전부 게이트 경유).

---

## 인용 (검증됨)

**GitHub**: Mem0, Letta, cognee(usage→edge reweight), LangMem(prompt rewrite), A-MEM, ExpeL(github.com/LeapLabTHU/ExpeL, 투표카운터), Voyager(skill library), REPLUG(github.com/swj0419/REPLUG), GainRAG, Self-RAG, DSPy, OPRO 구현체.
**arXiv**: REPLUG 2301.12652 · GainRAG 2505.18710 · ExpeL 2308.10144 · AWM 2409.07429 · Reflexion 2303.11366 · MemoryBank 2305.10250 · NEMORI 2508.03341 · OPRO 2309.03409 · TextGrad 2406.07496 · MIPRO 2406.11695 · Self-Evolving Agents Survey 2507.21046 · developer-memory(Maker-Checker) 2605.01567.
**HF 도구**: ranx, trackio, (참고)DSPy.

관련 내부 문서: [02_GAP_ANALYSIS.md](./02_GAP_ANALYSIS.md), [03_ROADMAP.md](./03_ROADMAP.md), [04_INSTRUCTIONS.md](./04_INSTRUCTIONS.md).
