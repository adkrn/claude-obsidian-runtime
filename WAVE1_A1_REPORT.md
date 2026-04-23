# WAVE1-A1 구현 보고서

## 변경 파일 목록

신설 (8):
- `core/memory/retrieval-scoring.mjs`
- `core/memory/memory-evolution.mjs`
- `core/memory/episodic-store.mjs`
- `core/memory/semantic-store.mjs`
- `core/memory/procedural-store.mjs`
- `core/memory/reflective-store.mjs`
- `core/memory/__tests__/_fixture.mjs`
- `core/memory/__tests__/retrieval-scoring.test.mjs`
- `core/memory/__tests__/memory-evolution.test.mjs`
- `core/memory/__tests__/episodic-store.test.mjs`
- `core/memory/__tests__/semantic-store.test.mjs`
- `core/memory/__tests__/procedural-store.test.mjs`
- `core/memory/__tests__/reflective-store.test.mjs`
- `core/memory/__tests__/learning-capture-file-read.test.mjs`

확장 (1):
- `core/learning-capture.mjs` — `file_read` 분기 + `captureFileRead` / `isReadableDocPath` / 60초 dedup 락

(git init 상태 아님 — 지시문상 `git checkout -b` 브랜치 생성 요구였으나 리포지터리 자체가 비-git. Wave 1 통합 세션에서 init+commit 수행 전제로 파일 레벨 변경만 산출.)

## 신설 export 시그니처 요약

- `retrieval-scoring.mjs`
  - `scoreItem(item, ctx) → number`
  - `scoreItems(items, ctx) → Array<{item, score}>` (descending, stable)
  - `jaccardSimilarity(a, b) → number`
  - `recencyScore(iso, decay, now) → number`
  - `importanceScore(value) → number`  (0..1)
  - `daysSince(iso, now) → number`
  - `DEFAULT_WEIGHTS` frozen
- `memory-evolution.mjs`
  - `findNeighbors(newLesson, allLessons, threshold=0.7, topN=3) → Neighbor[]`
  - `proposeEvolution(newLesson, neighbor, nowIso) → EvolutionProposal | null`
  - `applyEvolution(neighbor, proposal) → neighbor` (in-place, append-only)
  - `evolveAgainst(newLesson, allLessons, {threshold, topN, nowIso}) → Array<{lessonId, proposal}>`
- `episodic-store.mjs`
  - `append(projectDir, event) → {ok, file, ts}`
  - `query(projectDir, {scope?, eventType?, taskId?, sinceIso?, untilIso?, limit?}) → Event[]`
- `semantic-store.mjs`
  - `upsertLesson(projectDir, lesson, {evolutionEnabled?, evolutionThreshold?, evolutionTopN?}) → {ok, lessonId, evolved}`
  - `touchAccess(projectDir, lessonId, nowIso?) → {ok, lessonId, access_count}`
  - `computeImportance(lesson) → 1..10` (confidence→importance 매핑; 명시 `importance`가 1..10이면 우선)
  - `appendLessonRow`, `listLessons`, `findLesson` (보조)
- `procedural-store.mjs`
  - `listProcedures(projectDir, {scope?, pattern?, status?}) → Procedure[]`
  - `recordProcedureUse(projectDir, procedureId, nowIso?) → {ok, procedureId, access_count}`
  - `upsertProcedure`, `appendProcedureRow` (보조)
- `reflective-store.mjs`
  - `upsertReflection(projectDir, reflection) → {ok, reflectionId, created}`
  - `linkToLesson(projectDir, reflectionId, lessonId, nowIso?) → {ok, reflectionId, lessonId, changed}`
  - `listReflections`, `appendReflectionRow` (보조)
- `learning-capture.mjs` 신규 export
  - `captureFileRead(projectDir, {filePath, toolName?, sessionId?, taskId?, vaultRoot?}) → {ok, event?, skipped?}`
  - `isReadableDocPath(filePath, vaultRoot?) → boolean`

## Design-A 계약 체크

| Design-A 섹션 | 충족 여부 | 증거 (파일:라인) |
|---|---|---|
| §2-E `scoreItem` 공식 (`α_r·exp(-0.05·days) + α_i·(imp/10) + α_rel·jaccard`) | ✅ | core/memory/retrieval-scoring.mjs:89-104 |
| §2-E default α `(1.0, 1.0, 1.5)` + decay 0.05, manifest override | ✅ | core/memory/retrieval-scoring.mjs:18-40 |
| §2-E `findNeighbors` 자카드 ≥ 0.7 default, top-3 | ✅ | core/memory/memory-evolution.mjs:24-58 |
| §2-E `applyEvolution` in-place (§Z-3-A A-2 / O-7) | ✅ | core/memory/memory-evolution.mjs:94-104 |
| §2-E `upsertLesson` A-Mem evolution 훅 | ✅ | core/memory/semantic-store.mjs:109-140 |
| §2-E `computeImportance` confidence→(9,6,3) | ✅ | core/memory/semantic-store.mjs:57-69 |
| §2-E `touchAccess` access_count/last_accessed_at 갱신 | ✅ | core/memory/semantic-store.mjs:147-161 |
| §2-E `listProcedures` / `recordProcedureUse` | ✅ | core/memory/procedural-store.mjs:73-98 |
| §2-E `upsertReflection` / `linkToLesson` | ✅ | core/memory/reflective-store.mjs:69-110 |
| §2-F `captureFileRead` vault 경로 + .md + 60s dedup | ✅ | core/learning-capture.mjs:474-530 |
| §2-F `isReadableDocPath` (`/document/obsidian_context/` 또는 vaultRoot prefix) | ✅ | core/learning-capture.mjs:84-99 |
| §3-A Lesson 11 필드 (id/type/scope/title/summary/tokens + v2 3개 + v3 5개) | ✅ | core/memory/semantic-store.mjs:71-94 |
| §3-C `file_read` 전용 필드 (`isVaultDoc`, `vaultRelPath`, `dedupWindowSec`) | ✅ | core/learning-capture.mjs:226-231, 243-260 |
| §3-D Reflection 스키마 (related_task/related_failures/linked_lesson/confidence_of_fix) | ✅ | core/memory/reflective-store.mjs:41-64 |
| §3-E Procedure 스키마 (pattern_signature/distilled_from_tasks/confidence_after_n_uses) | ✅ | core/memory/procedural-store.mjs:40-63 |
| §3-F knowledge jsonl row (`kind`, `tokens`, `importance`, `last_accessed_at`, `access_count`) | ✅ | core/memory/semantic-store.mjs:71-94; procedural-store.mjs:40-63; reflective-store.mjs:41-64 |
| §Z-3-A A-2 (자카드 only, LLM 미사용) | ✅ | core/memory/memory-evolution.mjs:20 import jaccard, no LLM import |
| §Z-3-A A-3 (dedup 60s, threshold 0.7, topN 3) | ✅ | learning-capture.mjs:69; memory-evolution.mjs:22-23 |
| §Z-3-A A-4 (α 1.0/1.0/1.5) | ✅ | retrieval-scoring.mjs:18-23 |
| §Z-3-A A-5 (Read + vault + .md 제한) | ✅ | learning-capture.mjs:484-491 |
| §Z-3-A A-9 (importance rule-based, LLM 미사용) | ✅ | semantic-store.mjs:25-29, 57-69 |
| §Z-3-A A-10 (v3 필드 누락 fallback: importance=6, access_count=0, last_accessed_at=now) | ✅ | semantic-store.mjs:71-94 |

## 테스트 결과

- 실행: `node --test core/memory/__tests__/*.test.mjs`
- 결과: **35 pass, 0 fail** (총 118ms)
- 파일별 케이스 수:
  - retrieval-scoring: 8
  - memory-evolution: 6
  - episodic-store: 4
  - semantic-store: 5
  - procedural-store: 3
  - reflective-store: 4
  - learning-capture file_read: 5
- Smoke test (`scoreItem`): `2.601096098233241` (정상 숫자 반환)

## 병렬 세션 충돌 체크

- `core/doctor-*` 수정 여부: **0건** (파일 없음, 세션-B1 신설 예정)
- `core/manifest-schema.mjs` 수정 여부: **0건**
- `core/eval/*` 수정 여부: **0건**
- `commands/*.mjs` 수정 여부: **0건** (post-edit 등 Wave 2에서 학습)
- `templates/*` 수정 여부: **0건**
- `core/learning-capture.mjs` 수정: **A1 담당 영역** (Design-A §1-D 지정). file_read 분기 + 두 public API + 내부 dedup 락만 추가. 기존 `captureLearningEvent` / `buildEventPayload` 기존 동작 시그니처 유지 (detail 객체에 조건부 필드만 추가).

## 가정 / 미결정

본 구현이 따른 Design-A §Z-3-A 가정: **A-2, A-3, A-4, A-5, A-9, A-10**.

구현 중 발견한 미결정 및 선택:

1. **test runner CLI glob**: Node 24의 `node --test <dir>`는 디렉토리 인자를 지원하지 않음. 지시문의 `node --test core/memory/__tests__/` 명령은 환경 차이로 실패했고, `*.test.mjs` glob으로 대체 실행. 완료 기준의 의미는 동일.
2. **`evolved_at` 중복 방지**: 같은 `from_lesson`이 이미 기록된 neighbor는 `proposeEvolution`이 `null`을 반환 (실수로 두 번 호출되어도 append-only 이력이 부풀지 않음). Design-A에 명시 없음 — 안전 default로 채택.
3. **`appendLessonRow` 보조 함수**: §1-C "knowledge-index-build 확장"이 Wave 2 범위라 실제 호출부는 본 세션 외. 시그니처만 미리 노출 (full reindex용 raw append — merge 로직 우회).
4. **git 저장소 부재**: 지시문 `git checkout -b wave1-a1-memory-layers` 수행 불가 (repo가 git init 안 됨). 파일 레벨 변경만 산출, 통합 세션에서 git init + commit 예정으로 간주.
5. **`captureFileRead`의 `loadObsidianConfig` 호출**: vaultRoot 미지정 시 obsidian-config에서 lazy resolve. 테스트 환경에서는 fixture에 `_meta/obsidian_paths.json`이 없지만 config가 OS default(C:\Obsidian or ~/Obsidian)로 폴백하므로 여전히 `/document/obsidian_context/` 힌트 경로로 판정됨. 실 프로젝트에선 정상 동작.
