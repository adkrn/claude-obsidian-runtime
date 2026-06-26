# 04 — 세션 지시문 (복붙용)

각 작업을 맡을 세션에 그대로 붙여넣는 자기완결적 지시문 2개.
배경·근거는 [02_GAP_ANALYSIS.md](./02_GAP_ANALYSIS.md) / [03_ROADMAP.md](./03_ROADMAP.md) 참조.
코드 라인은 변할 수 있으니 **함수명**으로 재확인할 것.

---

## 지시문 ① — 검색 개선

> ### 작업: claude-obsidian-runtime 의 lesson 검색 relevance 개선
>
> **맥락**: 이 런타임은 세션 간 장기기억을 마크다운+JSONL 로 보관하고, `/task-start` 시 관련 lesson 을 자동 주입한다. 현재 검색 relevance 가 약해 세션이 같은 걸 재탐색한다. 임베딩은 **도입하지 마라** — 이 규모(~60건)에선 과잉투자다(근거: arXiv 2410.09662 BM25 효율 임계 ~1000건, claude-mem-lite). 의존성 0·네트워크 0ms 의 lexical 개선만 한다.
>
> **먼저 읽어라**: `docs/research/02_GAP_ANALYSIS.md`(G1~G3), `docs/research/03_ROADMAP.md`(Phase A~C). 그리고 아래 3개 파일을 직접 읽어 현재 구현을 확인하라:
> - `core/memory/retrieval-scoring.mjs` — `scoreItem`(3축 스코어링), `jaccardSimilarity`(relevance 항), `evaluateGate`(applicable_when 게이트)
> - `commands/task-start.mjs` — `buildLessonReadFirst`. **여기가 유일한 라이브 검색 경로다**: `loadLessonRows → scoreItems(lessons, ctx) → filter(-Inf) → applyMMR → topN`. relevanceFn 주입은 여기서 한다.
> - `core/learning-curate.mjs` — `buildCandidateRow`. lesson 의 `tokens` 가 title+summary+relatedFiles 로만 만들어지고 `trigger_keywords` 는 별도 필드로 저장만 됨(점수 미반영).
>
> **TDD 로 진행. 기존 테스트(465 green)를 깨지 마라.** `core/memory/__tests__/retrieval-scoring*.test.mjs` 가 기준이다.
>
> **단계** (작은 커밋, 각 단계 후 `npm test`):
>
> 1. **seam 도입 (G1 기반공사)**: `retrieval-scoring.mjs` 의 `scoreItem` 에서 relevance 계산을
>    `const relevance = typeof ctx.relevanceFn === 'function' ? ctx.relevanceFn(item, ctx) : jaccardSimilarity(promptTokens, itemTokens)`
>    로 바꾼다. **`ctx.relevanceFn` 미주입 시 기존 Jaccard 그대로 → 465 테스트 보존**. 이 불변식을 검증하는 테스트를 먼저 써라.
>
> 2. **trigger_keywords 활용 (G1, 최대 즉효)**: `buildLessonReadFirst`(task-start.mjs)에서 relevanceFn 을 구성해 `ctx` 에 주입한다. relevanceFn 은
>    `jaccard(promptTokens, item.tokens) + W_TK * overlapCount(promptTokens, item.trigger_keywords) / promptTokens.length`
>    형태(가중 가산). 세션이 채운 trigger_keywords(예: Pasim62 488개)가 게이트뿐 아니라 *점수*에도 기여하게 된다. W_TK 기본값은 manifest `retrievalWeights` 로 오버라이드 가능하게.
>
> 3. **IDF 가중 (G2)**: relevanceFn 구성 시 `loadLessonRows` 결과를 1회 스캔해 토큰별 document frequency → idf map 을 만들고 closure 로 캡처. Jaccard 교집합 항을 `Σ idf(t)` 가중합(BM25-lite)으로 바꿔, 보일러플레이트 고빈도 토큰(`captured`/`reusable`/`workflow` 등 82~100% 등장)을 자동 억제. idf 빌드는 `task-start.mjs` 안에서 1회.
>
> 4. **char-trigram 보조 (G3)**: relevance 에 char-trigram Jaccard 항을 작은 가중으로 가산. "씬전환"vs"씬 전환"(토큰 0.0 → trigram 1.0) 형태변형을 흡수. 토큰항 > trigram항 가중. **한↔영 동의어(씬↔scene)는 이번에 하지 마라** — trigram 도 0.0 이라 소형 사전이 필요한데, 실제 미스 로그를 본 뒤(5단계) 추가한다.
>
> 5. **계측 (Phase C)**: `commands/eval-retrieval.mjs` 로 1~4 전후 precision@5 + **recall** 비교. recall 이 핵심 지표다(검색 존재이유 = 재탐색 방지 → 놓치면 토큰 폭발). golden-task 에 "이 프롬프트엔 이 lesson 이 나와야" 케이스를 추가하고, 측정값으로 W_TK/alphaRelevance/idf 가중을 `retrievalWeights` 에 고정.
>
> **건드리지 마라**: `mmr.mjs` 의 다양성 Jaccard 는 1차 그대로 둔다(이득/위험 비대칭). `context-resolver.mjs` 의 `scoreKnowledgeRow`(count-based 스코어러)는 별도 경로 — 이번 범위 밖. `evaluateGate`(구조 필터)는 의미 검색과 직교하므로 유지.
>
> **완료 기준**: (a) relevanceFn seam + 미주입 폴백 테스트, (b) trigger_keywords 가 랭킹에 반영됨을 보이는 테스트, (c) eval 전후 비교표, (d) 전체 테스트 green. 임베딩·외부 의존 0.

---

## 지시문 ② — 산출물 정리

> ### 작업: claude-obsidian-runtime 산출물(lesson/trouble/decision/architecture) 정리
>
> **맥락**: 세션이 종료 시 작성하는 4종 산출물이 jsonl 인덱스(`.claude/runtime/knowledge/*.jsonl`)와 Obsidian 볼트 문서로 저장된다. 옛 데이터에 보일러플레이트가 남아 있고, 일부 산출물은 검색 신호 필드가 비어 있다. 이걸 정리해 검색 품질과 데이터 위생을 올린다.
>
> **⚠️ 데이터 안전 — 먼저 읽어라**:
> - **볼트 격리 필수**: 어떤 CLI/스크립트든 실행 전 `OBSIDIAN_VAULT_ROOT` 를 테스트 경로로 지정하라. 안 하면 실제 `C:\Obsidian` 을 오염시킨다(단위테스트로 안 잡힘). 근거: 장기기억 `feedback_vault_leak_cli_e2e`.
> - **자동삭제 금지**: 과거 `fs.rmSync` 직접 unlink 가 mirror-only 파일을 영구 손실시킨 사고가 있다. 모든 제거는 **백업 후**, 가능하면 quarantine 방식. 근거: 장기기억 `obsidian-sync prune 사고`.
> - **읽어라**: `docs/research/02_GAP_ANALYSIS.md`(G1·G4), `docs/research/03_ROADMAP.md`(Phase 0·D).
>
> **TDD. 각 단계 후 `npm test`(465 green 유지). 각 단계는 독립 커밋.**
>
> **단계** (위험 낮은 순):
>
> 1. **보일러플레이트 청소 (Phase 0)**: 전 프로젝트 `lessons.jsonl` + 볼트 lesson 문서에서 보일러플레이트 라인 `read read_first notes before writing a plan` 만 제거하고 **세션이 채운 실제 rules 는 보존**. 대상 분포(진단 기준): Pasim62 10/64, talkSim 34/57, magicDraft 7/7, productSurvey 2/2, musicGame 1/1 = 54건. 절차: (a) `.bak` 백업 → (b) 해당 라인만 필터 제거 → (c) 재인덱싱 → (d) 검색 정상 확인. `core/diagnostics/rebuild-lessons.mjs` 가 재추출/백업 패턴의 참고.
>
> 2. **trigger_keywords/applicable_when 채우기 (G1 부차)**: `decision`/`architecture` 산출물은 `trigger_keywords`·`applicable_when` 이 비어 게이트·점수 기여를 못 한다(`learning-curate.mjs` 의 `buildCandidateRow`·`writeSessionDecision`/`writeSessionArchitecture` 확인). 세션 작성 시 이 필드를 채우도록 `templates/commands/task-close.md` 의 decision/architecture 작성 지시문을 보강하라(lesson 섹션은 이미 채움). 기존 빈 산출물은 일괄 재채움 대신, 다음 세션이 update 시 채우는 점진 방식 권장(데이터 변형 최소화).
>
> 3. **포맷/스키마 통일**: 4종 산출물 frontmatter 필드를 gold 포맷으로 통일·검증. lesson 의 11필드 검증기(`core/memory/memory-evolution.mjs` 의 `verifyFrontmatter11Fields`)가 기준 — trouble/decision/architecture 에도 동급 검증을 적용할지 검토. `task-close.md` 의 작성 기준(summary=한 문장 교훈, rules=구체적 "X일 때 Y하라", 보일러플레이트 금지)을 4종 모두에 일관 적용.
>
> 4. **중복 병합·stale 정리 (Phase D)**: (a) 같은 주제 중복 산출물 탐지 — `learning-curate.mjs` 의 `findDuplicateCandidate`(jaccard+파일오버랩) 로직 재사용. (b) **stale 리포트** — `last_accessed_at` 오래됨 + `access_count` 0 + 높은 jaccard 중복 후보를 **리포트만** 하고(자동삭제 절대 금지) 사람 검토 후 승격/제거. cognee 의 Forget·MemoryBank 망각곡선의 보수 버전. 새 CLI(예: `commands/knowledge-prune-report.mjs`)로 분리.
>
> **완료 기준**: (a) 보일러플레이트 0건 + 세션 rules 보존 확인, (b) decision/architecture 신규 작성분에 trigger_keywords 채워짐, (c) 4종 frontmatter 검증 통과, (d) stale 리포트 CLI(읽기전용), (e) 전체 테스트 green, (f) 모든 작업이 격리 볼트에서 검증됨.
>
> **순서 의존**: 지시문 ①(검색 개선)의 trigger_keywords 활용은 이 작업의 1·2단계가 끝난 데이터 위에서 효과가 크다. ② 1~2 → ① 2 순서가 이상적이나, seam 작업(① 1)은 병행 가능.

---

## 두 지시문의 관계

```
②-1 보일러플레이트 청소 ──┐
②-2 trigger_keywords 채움 ─┴─> ①-2 trigger_keywords 활용 (데이터 위에서 효과 극대화)
①-1 relevanceFn seam (독립, 병행 가능)
②-3,4 포맷통일·stale (독립)
```

권장 착수 순서: **②-1 → ①-1 → ②-2 → ①-2 → ①-3,4 → ①-5(eval) → ②-3,4**.
단, 각 세션은 자기 지시문만으로 자기완결적으로 동작하도록 작성됨 — 위 순서는 ROI 최적화일 뿐 강제 아님.
