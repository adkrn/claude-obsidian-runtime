# 03 — 로드맵 (유사 프로젝트 장점을 우리 seam 에 이식)

**목적**: [02_GAP_ANALYSIS.md](./02_GAP_ANALYSIS.md) 의 갭(G1~G5)을, [01_LANDSCAPE.md](./01_LANDSCAPE.md) 의 검증된 패턴으로 메우는 단계 계획.
**원칙**: 의존성·위험 오름차순. 동기 순수성 보존. 465 테스트 green 유지. 각 Phase 는 독립 착수 가능.

---

## 핵심 방향 한 문장

> **임베딩으로 점프하지 말고, 이미 가진 신호(trigger_keywords)와 검증된 lexical 기법(IDF·n-gram)으로 검색 품질을 먼저 끌어올린 뒤, 쓰기 측 품질(망각·진화)로 레버리지를 키운다. 임베딩은 lesson 수백 개 + 한↔영 미스가 *실측될 때만*, 같은 seam 에 무중단 추가.**

이건 학계(arXiv 2410.09662, ~1000건 임계)·업계(claude-mem-lite)·우리 메모리 진단(`project_embedding_pre_diagnosis`)이 전부 같은 결론.

---

## 단계 의존 그래프

```
Phase 0 (청소) ──> Phase A (trigger_keywords + seam) ──> Phase B (IDF + n-gram)
                                  │                              │
                                  └──> Phase C (eval 계측) <──────┘
                                                 │
                                                 v
                          Phase D (쓰기 측: decay/진화 강화)
                                                 │
                                                 v
                          Phase E (임베딩 — 조건 충족 시에만)
```

Phase 0·A·B 는 검색 정확도, C 는 측정, D 는 쓰기 품질, E 는 최후 옵션.

---

## Phase 0 — 보일러플레이트 청소 (선결, 위험 낮음)

**해결 갭**: G4 (일부)
**근거**: 02 §G4. 임베딩 전·검색개선 전 데이터 위생.

**작업**:
1. 백업 후, 전 프로젝트 `lessons.jsonl` + 볼트 lesson 문서에서 보일러플레이트 라인(`read read_first notes before writing a plan`)만 제거 — 세션이 채운 실제 rules 는 보존.
2. 청소 대상: Pasim62 10/64, talkSim 34/57, magicDraft 7/7, productSurvey 2/2, musicGame 1/1 = 54건.
3. **볼트 격리 필수**: CLI e2e 시 `OBSIDIAN_VAULT_ROOT` 지정 안 하면 실제 `C:\Obsidian` 오염 (메모리: `feedback_vault_leak_cli_e2e`).
4. 청소 후 재인덱싱(2-C 재인덱싱과 같은 줄기).

**완료 기준**: 보일러플레이트 라인 0건, 세션 rules 보존 확인, 재인덱싱 후 검색 정상.

---

## Phase A — `trigger_keywords` 부활 + `relevanceFn` seam (최대 즉효)

**해결 갭**: G1
**이식 출처**: Mem0(키워드를 주 신호로 융합)
**위험**: 낮음 (단일 모듈 + 주입, 465 테스트 보존)

**작업**:
1. **seam 도입**: `retrieval-scoring.mjs:226` 의 relevance 를
   `ctx.relevanceFn ? ctx.relevanceFn(item, ctx) : jaccardSimilarity(promptTokens, item.tokens)` 로 교체.
   미주입 시 기존 Jaccard → **465 테스트 그대로 통과**.
2. **trigger_keywords 활용**: 둘 중 택1 (A안 권장)
   - **A안(점수 가산)**: relevanceFn 안에서 `jaccard(promptTokens, tokens) + w_tk * overlap(promptTokens, trigger_keywords)`. trigger_keywords 는 게이트와 점수 둘 다에 기여.
   - B안(tokens 병합): `buildCandidateRow` 에서 `tokens` 에 trigger_keywords 가중 병합. 단순하나 재인덱싱 필요·가중 조절 불가.
3. 배선점: lesson read-first 빌드 경로(현재 `task-start` 계열 — 함수명 `buildReadFirst`/lesson 후보 빌드 지점 재확인). 여기서 relevanceFn 1회 구성 후 주입.

**완료 기준**: trigger_keywords 가 채워진 lesson 이, 해당 키워드 프롬프트에서 랭킹 상승. 신규 테스트 추가, 기존 465 green.

**주의**: decision/architecture 는 trigger_keywords 가 비어 이 개선 수혜 없음(02 부차). lesson 우선, 나머지는 Phase B 의 IDF 가 커버.

---

## Phase B — IDF 가중 + char n-gram (lexical 정밀화)

**해결 갭**: G2, G3
**이식 출처**: claude-mem-lite(TF-IDF), arXiv 2410.09662(BM25 우수성)
**위험**: 낮음~중 (relevanceFn 내부 확장, 외부 의존 0)

**작업**:
1. **IDF closure**: lesson read-first 빌드 시 `lessons.jsonl` 1회 스캔으로 토큰별 document frequency → idf map. relevanceFn closure 가 캡처.
2. **relevance 식 확장**: `Σ idf(t) over overlap` 형태(BM25-lite). 보일러플레이트 고빈도 토큰은 idf 낮아 자동 억제 → G2 의 분모 오염 해소.
3. **char-trigram 보조항**: 토큰 Jaccard 외에 char-trigram Jaccard 가산 → "씬전환"vs"씬 전환" 흡수(G3). 가중은 토큰 < trigram 보조.
4. **MMR 은 1차 Jaccard 유지**(`mmr.mjs:64`). 다양성 항까지 건드리면 이득/위험 비대칭 — 보류(메모리 노트 결론).
5. **한↔영 동의어**: 1차 제외. 실제 미스 로그(eval-retrieval) 본 뒤 소형 사전만 추가.

**완료 기준**: 보일러플레이트 토큰이 상위 신호에서 밀려남. 형태변형 쿼리 매칭 개선. Phase C eval 로 precision@5/recall 비교.

---

## Phase C — eval 계측 (튜닝 근거 확보)

**해결 갭**: 측정 부재
**기존 자산**: `commands/eval-retrieval.mjs`, `core/eval/` 이미 존재
**위험**: 낮음

**작업**:
1. `eval-retrieval` 로 Phase A/B 전후 precision@5 + **recall** 측정. (검색의 존재이유가 "재탐색 방지"라 recall 이 핵심 지표 — 놓치면 세션이 재탐색→토큰 폭발. 메모리 노트 §방법론.)
2. golden-task 에 "이 프롬프트엔 이 lesson 이 나와야 한다" 케이스 추가.
3. 측정 후 `retrievalWeights`(manifest override)로 alphaRelevance/w_tk/idf 가중 튜닝.

**완료 기준**: 전후 비교표 + 튜닝된 가중치가 manifest 에 고정.

---

## Phase D — 쓰기 측 품질 (레버리지 큰 곳)

**해결 갭**: G4 (decay), 진화 강화
**이식 출처**: MemoryBank(망각곡선), cognee(Forget), A-MEM(진화 — 이미 구현)
**근거**: arXiv 문헌 종합 — "검색 백엔드 교체보다 쓰기 품질이 더 남는다"(01 §2-C)
**위험**: 중 (데이터 변형 — 백업·격리 필수)

**작업**:
1. **stale 리포트**: `last_accessed_at` 오래됨 + `access_count` 0 + 중복(jaccard 높음) 후보를 리포트(자동삭제 아님, 사람 검토 후 승격). cognee Forget 의 보수 버전.
2. **진화 품질**: `memory-evolution.mjs` 는 rule-based append-only(jaccard≥0.7). 진화가 *실제로 유용했는지* access_count 로 사후 검증하는 루프 검토.
3. **decision/architecture 의 trigger_keywords 자동 채움** 검토(G1 부차 해소).

**완료 기준**: stale 후보 리포트 CLI + 사람 검토 워크플로. 자동삭제는 하지 않음(데이터 손실 사고 이력 — 메모리: obsidian-sync prune).

---

## Phase E — 임베딩 (조건 충족 시에만, 최후)

**해결 갭**: 한↔영 패러프레이즈 미스 (현시점 미실측)
**이식 출처**: khoj/basic-memory(하이브리드), HF multilingual-e5
**위험**: 높음 (동기 순수성 영구 상실 + 네트워크 + 키관리)

**착수 조건 (전부 충족 시에만)**:
- [ ] lesson 수백 개 도달 (현 ~60, 임계 ~1000건 근접)
- [ ] eval-retrieval 에서 한↔영 패러프레이즈 미스가 *실측됨* (추측 아님)
- [ ] Phase A~D 로도 recall 이 부족함이 데이터로 증명됨

**작업(조건 충족 시)**:
1. `relevanceFn` 에 코사인 주입 — Phase A 에서 깐 seam 그대로. **무중단 전환.**
2. 로컬 우선: `intfloat/multilingual-e5-small`(~470MB, 384차원, 한영) 또는 `-ko` fork. 60건이면 인메모리 brute-force 코사인이면 충분 — 벡터DB 불필요.
3. **하이브리드(RRF)**: lexical(Phase B) + dense 를 rank 융합. 어느 하나로 안 가고 둘 다 — arXiv 결론.
4. KV-cache: model-version 핀을 manifest+stable-stringify 에 넣어 cache miss 통제(D-20 기존 설계).

**현시점 결론**: **하지 마라.** 위 조건 미충족. Phase A~D 가 훨씬 큰 ROI.

---

## 우선순위 요약 (다음 세션이 바로 집을 것)

| 순위 | Phase | 왜 |
|------|-------|-----|
| 1 | **0 청소** + **A trigger_keywords** | 데이터 위생 + 최대 즉효, 위험 최저 |
| 2 | **B IDF/n-gram** | 보일러플레이트 억제 + 형태변형, 의존성 0 |
| 3 | **C eval** | A/B 효과 측정·튜닝 근거 |
| 4 | **D 쓰기 품질** | 레버리지 크나 데이터 변형 신중 |
| — | **E 임베딩** | 조건 미충족 시 착수 금지 |

**플랜 모드 권장 지점**: Phase A 의 seam 설계(relevanceFn 시그니처), Phase E(외부 의존 결정). 나머지는 TDD 로 직진 가능.
