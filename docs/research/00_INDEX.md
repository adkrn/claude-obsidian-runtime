# 리서치 & 방향성 문서 인덱스

**작성**: 2026-06-26 (다른 세션이 계획 수립에 쓰도록 정리)
**대상 독자**: 이 프로젝트의 다음 방향을 기획·구현할 Claude 세션

이 폴더는 "유사 프로젝트는 어떻게 구현했나 → 우리는 어디에 있나 → 어디로 갈까"를 분리한 문서들이다.
HANDOFF.md 가 "지금 상태"라면, 이 폴더는 "앞으로의 근거와 지도"다.

| # | 문서 | 한 줄 |
|---|------|-------|
| 1 | [01_LANDSCAPE.md](./01_LANDSCAPE.md) | 유사 프로젝트(GitHub/arXiv/HF) 기능 구현 방식 — 검증된 출처 + 우리 설계와의 대응표 |
| 2 | [02_GAP_ANALYSIS.md](./02_GAP_ANALYSIS.md) | 코드 기준 현재 구현 vs 이상 — 실제 파일/라인 근거. **시작점은 여기** |
| 3 | [03_ROADMAP.md](./03_ROADMAP.md) | 단계별 실행 계획 — 유사 프로젝트 장점을 우리 seam 에 어떻게 이식할지 |
| 4 | [04_INSTRUCTIONS.md](./04_INSTRUCTIONS.md) | **세션 복붙용 지시문 2개** — ① 검색 개선 ② 산출물 정리. 코드경로·완료기준 포함 |
| 5 | [05_SELF_IMPROVEMENT.md](./05_SELF_IMPROVEMENT.md) | **자가발전 루프 설계** — 검색→산출물→자동개선 닫힌 루프. ①② 끝난 뒤 구현계획용. 4패턴(B/C/A/D)→우리 seam 매핑 |

## 다음 세션을 위한 3줄 요약

1. **검색 결정은 이미 옳다**: ~60개 규모에선 임베딩이 과잉투자. 학계(arXiv 2410.09662: BM25 효율 임계 ~1000건)·업계(claude-mem-lite: SQLite+FTS5+TF-IDF, 임베딩 600배 비용절감)가 우리 입장을 뒷받침.
2. **최대 즉효 = `trigger_keywords` 부활**: 세션이 채운 고품질 신호(Pasim62 488개)가 `tokens` 에 안 들어가 검색에서 100% 버려지는 중. [02_GAP_ANALYSIS.md §G1](./02_GAP_ANALYSIS.md) 참조. 의존성 0, +0ms.
3. **레버리지는 쓰기 측 품질**: A-MEM(노트 진화) · Generative Agents(reflection) · MemoryBank(decay) 가 공통으로 말하는 건 "검색 백엔드 교체보다 *쓰기 품질*이 더 남는다". 우리는 A-MEM 진화·Generative 3축 스코어링은 이미 구현됨. 비어 있는 건 **decay 기반 망각/청소**와 **trigger_keywords 활용**.

## 검증 메모

- 모든 GitHub star/레포·arXiv ID·HF 모델ID 는 작성 시점 직접 fetch 로 검증됨 (환각 아님).
- 코드 근거는 작성 시점 `core/` 실제 파일 기준. 라인번호는 변할 수 있으니 함수명으로 재확인 권장.
- 관련 장기기억: `project_embedding_pre_diagnosis` (검색 seam 사전진단), `project_phase2_decision` (산출물 생성 정상화).
