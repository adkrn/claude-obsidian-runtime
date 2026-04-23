# WAVE1-C1 구현 보고서

## 변경 파일 목록

신설 (git 미사용 환경 — 직접 나열):

```
core/eval/metrics.mjs                            (167 lines)
core/eval/event-reader.mjs                       (107 lines)
core/eval/report-writer.mjs                      (111 lines)
core/eval/golden-task-loader.mjs                 (127 lines)
templates/eval/golden-tasks.json                 (185 lines)
core/eval/__tests__/metrics.test.mjs             (109 lines)
core/eval/__tests__/event-reader.test.mjs       (123 lines)
core/eval/__tests__/report-writer.test.mjs      (131 lines)
core/eval/__tests__/golden-task-loader.test.mjs (130 lines)
```

수정 0건 (담당 영역 외 파일 미접촉).

## 신설 export 시그니처 요약

`core/eval/metrics.mjs`
- `precisionAt(retrieved: string[], relevant: Set<string>, k=5): number`
- `recallAt(retrieved: string[], relevant: Set<string>, k=10): number`
- `mrr(rankedList: string[], firstEditedPath: string|null): number`
- `ndcgAt(rankedList: string[], relevanceScores: Record<string, number>, k=10): number`
- `jaccardSim(aTokens: string[], bTokens: string[]): number`
- `chiSquared(observedA: number[], observedB: number[]): {stat, df, p}`

`core/eval/event-reader.mjs`
- `readEventsWindow(projectDir: string, windowDays=30, now=Date.now()): EpisodicEvent[]`
- `groupEventsByTask(events): Map<taskId, events[]>`
- `extractFileReadsForTask(taskEvents): Set<string>`
- `extractFirstEditedFile(taskEvents): string|null`

`core/eval/report-writer.mjs`
- `validateReportSchema(report): void` (throws `SchemaError`)
- `formatTs(input, withSeconds=false): string` (UTC YYYYMMDD-HHmm[ss])
- `atomicWrite(filePath, content): void`
- `writeReport(projectDir, report): string` (returns absolute path)
- `class SchemaError extends Error`

`core/eval/golden-task-loader.mjs`
- `loadGoldenTasks({projectDir, tasksPath?}): Promise<{schemaVersion, description, tasks, source}>`
- `class GoldenTasksNotFound extends Error` (with `searched: string[]`)
- `class GoldenTasksSchemaError extends Error`

## Golden Task 데이터 검증

- 10 task 전부 기획서 §5-②-E 표와 일치 (id GOLDEN-01~10, prompt 그대로 전사, expectedScope 그대로).
- `schemaVersion: "1.0.0"`.
- 각 task에 `manualRelevanceScores` 객체 포함 (NDCG 계산용 path → 0/1 매핑).
- 모든 task에 `category`, `expectedReadFirstPaths`, `expectedCodeHitsKeywords`, `reusability`, `manualRelevanceScores` 포함 (Design-C §3-A 필수 필드 체크).

## Design-C 계약 체크

| 계약 | 충족 | 증거 |
|------|------|------|
| §2-B precisionAt 공식 (`top.slice(0,k)` ∩ relevant / k) | ok | metrics.mjs:5-19 |
| §2-B recallAt divide-by-zero 가드 (relevant.size===0 → 0) | ok | metrics.mjs:20-37 |
| §2-B mrr 인덱스 보정 (`1/(idx+1)`, missing → 0) | ok | metrics.mjs:38-51 |
| §2-B ndcgAt DCG/IDCG 공식 + idcg=0 가드 | ok | metrics.mjs:52-74 |
| §2-B jaccardSim 순수 함수 (intersection / union, empty/empty → 0) | ok | metrics.mjs:75-93 |
| §2-B chiSquared Wilson-Hilferty 근사 (라이브러리 0 의존) | ok | metrics.mjs:94-167 |
| §2-E writeReport 9 키 검증 (validateReportSchema 우선 호출) | ok | report-writer.mjs:7-19, 29-58, 93-111 |
| §2-E atomic write (`<file>.tmp` write → rename) | ok | report-writer.mjs:81-87 |
| §2-E formatTs `YYYYMMDD-HHmm` (UTC) | ok | report-writer.mjs:64-79 |
| §2-E 동분 충돌 시 seconds 보강 | ok | report-writer.mjs:104-108 |
| §2-F events 30일 윈도 + 멀티 scope 통합 + 정렬 | ok | event-reader.mjs:44-65 |
| §2-F task별 그룹핑 + file_read/file_modified 추출 | ok | event-reader.mjs:66-106 |
| §3-A Golden Task 스키마 (10개, 8 필수 필드) | ok | golden-tasks.json + golden-task-loader.mjs:8-17, 60-90 |
| §1-C fallback 순서 (local → CLAUDE_RUNTIME_HOME → bundled → throw) | ok | golden-task-loader.mjs:93-128 |
| A-C-1 Design-A `file_read` 스키마 read-only 사용 | ok | event-reader.mjs:82-94 (filePath/vaultRelPath 읽기만) |
| A-C-7 chiSquared 라이브러리 0 의존 | ok | package.json import 0건 — Node 내장 (`Math.cbrt`, `Math.exp`, `Math.SQRT2`)만 사용 |
| A-C-11 파일명 `<YYYYMMDD-HHmm>_<projectId>.json` | ok | report-writer.mjs:93-111 (collision은 seconds 보강) |

## 테스트 결과

- 명령: `node --test core/eval/__tests__/metrics.test.mjs core/eval/__tests__/event-reader.test.mjs core/eval/__tests__/report-writer.test.mjs core/eval/__tests__/golden-task-loader.test.mjs`
- 결과: **42 pass, 0 fail** (87ms)
- 커버:
  - metrics: 19 케이스 (6 함수 × 정상/경계/제로 분모 + chiSquared 라이브러리 무의존 검증)
  - event-reader: 9 케이스 (30일 윈도 필터, 멀티 scope 정렬, 누락 디렉토리, malformed JSONL skip, taskId 그룹핑, file_read 추출, first-edited 도출, 비-Edit/Write 무시, 빈 입력)
  - report-writer: 10 케이스 (각 9 필수 키 누락 throws, atomic write tmp cleanup, 동분 충돌 시 seconds 보강, 검증 실패 시 디스크 미접촉)
  - golden-task-loader: 5 케이스 (bundled fallback, project-local 우선, tasksPath 최우선, GoldenTasksNotFound throw, schema error)

## 추가 sanity 체크 (지시문 명시 명령)

```
$ node -e "import('./core/eval/metrics.mjs').then(m => console.log(m.precisionAt(['a','b','c','d','e'], new Set(['a','c']), 5)))"
0.4

$ node -e "import('./core/eval/golden-task-loader.mjs').then(m => m.loadGoldenTasks({projectDir:'/nonexistent'}).then(t => console.log(t.tasks.length)))"
10
```

둘 다 기대값 일치.

## 병렬 세션 충돌 체크

- `core/memory/*`, `core/learning-capture.mjs` 수정 여부: **0건** (디렉토리 미존재 — A1 세션 영역 미접촉)
- `core/doctor-*`, `core/manifest-schema.mjs` 수정 여부: **0건** (B1 세션 영역 미접촉)
- `commands/*` 수정 여부: **0건** (Wave 2/3 영역 미접촉)
- `templates/agents/*`, `templates/hooks/*`, `templates/vault/*` 수정 여부: **0건**
- `templates/eval/` 신설 + `templates/eval/golden-tasks.json` 생성: 지시문 허용 범위.

## 가정 / 미결정

준수한 가정:
- A-C-1 Design-A `file_read` 이벤트 스키마 read-only 소비 (event-reader는 append/write 0건)
- A-C-6 NDCG `relevanceScores`는 호출 측 입력 — `manualRelevanceScores`(golden-tasks) 또는 file_read 교집합 둘 다 수용 가능한 시그니처
- A-C-7 chiSquared Wilson-Hilferty 근사 + Abramowitz-Stegun 7.1.26 erf 근사. 외부 라이브러리 0건
- A-C-8 estimateTokenCount는 본 세션 범위 외 (Wave 3 golden-task-runner)
- A-C-11 파일명 `<YYYYMMDD-HHmm>_<projectId>.json` UTC 기준 + 동분 충돌 시 seconds 보강
- A-C-12 schemaVersion 검증은 loader에서 수행 (compare-engine은 Wave 3 범위)

구현 중 발견한 보조 결정 (Design-C 계약 침범 없음):
- `sanitizeProjectId` 추가: projectId의 안전하지 않은 문자(`/`, `\`, 공백 등)를 `_`로 치환. 파일명 안전성 위해. Design-C 미명시였으나 Windows 호환성 고려.
- `loader.tasksPath` 옵션 명시 시 최우선 적용 (검증 후 선택). `eval-run --goldenTasks` 인자 흐름 대응.
- loader에 `bundledTemplatePath()` (import.meta.url 기반) 폴백 추가: `CLAUDE_RUNTIME_HOME` 미설정 환경에서도 동작 보장. fallback 순서: tasksPath → projectDir 로컬 → CLAUDE_RUNTIME_HOME 템플릿 → bundled 템플릿 → throw.
- event-reader는 malformed JSONL 라인을 silently skip (eval은 데이터 손상으로 죽지 않아야 함). 테스트로 보호.

## 제약 준수

- Design-C CLI 5개 구현 0건 (Wave 3 범위)
- `core/eval/compare-engine.mjs`, `core/eval/golden-task-runner.mjs` 구현 0건 (Wave 3 범위)
- 외부 라이브러리 추가 0건 (Node 내장만)
- Design-C Closed Decisions 재논의 0건
- `templates/eval/` 외 templates 디렉토리 수정 0건
