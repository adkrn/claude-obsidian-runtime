# WAVE2-A2 구현 보고서

**브랜치**: `wave2-a2-commands-curate`
**베이스**: `master` (Wave 1 완료 커밋 `b072fa1`, 141 tests)
**최종 테스트**: 173 pass / 0 fail (Wave 1 141 + Wave 2 신규 32)

---

## 변경 파일 목록

### 신설
- [commands/task-start.mjs](commands/task-start.mjs) — 9필드 JSON 출력 CLI 래퍼 + `--dry-run` 지원
- [commands/worklog-generate.mjs](commands/worklog-generate.mjs) — session-end-engine.buildHandoffWorklog 위임 래퍼
- [commands/__tests__/task-start-dry-run.test.mjs](commands/__tests__/task-start-dry-run.test.mjs) — 7 케이스
- [commands/__tests__/post-edit.test.mjs](commands/__tests__/post-edit.test.mjs) — 3 케이스 (file_read 분기)
- [core/__tests__/learning-curate.test.mjs](core/__tests__/learning-curate.test.mjs) — 13 케이스 (5 builder)
- [core/__tests__/session-end-engine.test.mjs](core/__tests__/session-end-engine.test.mjs) — 9 케이스 (Handoff + 훅 순서)

### 수정
- [core/runtime-lib.mjs](core/runtime-lib.mjs) — `parseCliArgs`에 `--dry-run` boolean flag 추가
- [core/task-start-engine.mjs](core/task-start-engine.mjs) — `createAndStartTask`에 `dryRun` 분기 + 9필드 output 재정렬
- [core/learning-curate.mjs](core/learning-curate.mjs) — 5 builder export 추가 (347줄 +)
- [core/session-end-engine.mjs](core/session-end-engine.mjs) — `buildHandoffWorklog` + `runSessionEndHooks` (251줄 +)
- [commands/post-edit.mjs](commands/post-edit.mjs) — `tool_name === 'Read'` 분기 추가 (vault .md → `captureFileRead`)
- [commands/knowledge-index-build.mjs](commands/knowledge-index-build.mjs) — `reflection`/`procedure` kind 2개 추가 (총 5 kind), 템플릿 스켈레톤 `_` prefix 제외 필터
- [commands/lesson-promote.mjs](commands/lesson-promote.mjs) — v3 frontmatter 기본값 시딩 (importance/access_count/evolved_at/trigger_keywords/applicable_when/confidence/last_accessed_at/linked_reflection)

---

## 10 CLI 승격 매트릭스

| CLI | 상태 | 소스 정합 | 신규 기능 |
|-----|------|----------|----------|
| session-start | 실구현 존재 (111줄) — Wave 1 산출물 유지 | talkSim `4e78bb21` 계열 | 변경 없음 |
| stop | 실구현 존재 (82줄) | talkSim `4e78bb21` | 변경 없음 |
| post-edit | 실구현 존재 + **file_read 분기 추가** (168줄) | talkSim `4e78bb21` + Design-A §1-D | `tool_name === 'Read'` + `isReadableDocPath` + `captureFileRead` |
| prompt-context | 실구현 존재 (191줄) | talkSim `4e78bb21` | 변경 없음 |
| subagent-start | 실구현 존재 (90줄) | talkSim `4e78bb21` | 변경 없음 |
| code-index-query | 실구현 존재 (199줄) | Talkup `339bd39d` | 변경 없음 |
| knowledge-index-build | 실구현 존재 + **kind 확장** (249줄) | Talkup `339bd39d` | `reflection`/`procedure` kind 추가 (3→5 kind) |
| lesson-promote | 실구현 존재 + **v3 frontmatter 지원** (255줄) | Talkup `64f10469` | promote 시 v3 필드 9개 기본값 시딩 |
| memory-refresh | 실구현 존재 (31줄) | Talkup `3158245a` | 변경 없음 — `buildCodeIndex` + `buildKnowledgeIndex` 순차 호출 이미 구현됨 |
| task-usage | 실구현 존재 (325줄) | Talkup base + talkSim merge 이미 완료 | 변경 없음 |

**비고**: 지시문이 `placeholder → 실제 구현 승격`을 가정했으나, 실제 브랜치 상태에서 모든 CLI가 이미 동작 수준으로 존재. 따라서 승격 대신 **증분 수정 3건** (post-edit / knowledge-index-build / lesson-promote)으로 Design-A §1-D + v3 요구사항을 만족시킴.

---

## task-start --dry-run 계약 체크 (PATCH_Phase1 §3-B/C/D)

| 계약 | 충족 | 증거 |
|------|------|------|
| 9필드 JSON 출력 (taskId/readFirst/codeHits/knowledgeHits/guardrails/matchedScopes/matchedGroups/currentTaskPath/lastContextPath) | ✅ | [core/task-start-engine.mjs:134-145](core/task-start-engine.mjs#L134-L145) |
| `current-task.json` skip | ✅ | [core/task-start-engine.mjs:96-100](core/task-start-engine.mjs#L96-L100) (if !dryRun) |
| `tasks/<taskId>.json` skip | ✅ | 동일 블록 |
| `events/*.jsonl` (learning-capture) skip | ✅ | [core/task-start-engine.mjs:111-127](core/task-start-engine.mjs#L111-L127) (appendJsonl inside !dryRun) |
| `obsidian-sync` skip | ✅ | [core/task-start-engine.mjs:62-64](core/task-start-engine.mjs#L62-L64) (dry-run short-circuit) |
| `last-context.json` skip | ✅ | write block inside !dryRun |
| stdout = 단일 라인 JSON | ✅ | post-edit.test 케이스 "single line check" |

### 1-line 검증

```bash
$ node commands/task-start.mjs --dry-run --task "smoke" --project-dir "$PWD" \
    | tail -1 \
    | node -e "const j=JSON.parse(require('fs').readFileSync(0));console.log(['taskId','readFirst','codeHits','knowledgeHits','guardrails','matchedScopes','matchedGroups','currentTaskPath','lastContextPath'].every(k=>k in j))"
true
```

부수효과 0건 — `.claude/runtime/` 디렉토리가 dry-run 후에도 생성되지 않음 (테스트 `does NOT create any files inside .claude/runtime/`).

---

## learning-curate 5 builder 체크 (Design-A §2-D)

| Builder | 구현 위치 | 계약 | 테스트 케이스 |
|--------|----------|------|--------------|
| `buildLessonDraft` | [core/learning-curate.mjs:646-701](core/learning-curate.mjs) | 순수, v3 11필드, trigger_keywords ≥ 3 추출, confidence→importance 매핑 (low=3/medium=6/high=9) | 3 (0/1/3 verification, keyword 개수) |
| `buildTroubleshootingDraft` | [core/learning-curate.mjs:708-763](core/learning-curate.mjs) | 순수, 4 auto + 4 manual 섹션, `<!-- CURATOR_TODO -->` 마커 ×4 | 3 (no-failures null / 8섹션 / 마커 4개) |
| `buildReflectionDraft` | [core/learning-curate.mjs:769-799](core/learning-curate.mjs) | 순수, `failures.length >= 1 && hasVerificationFailure` 조건 충족 시 ReflectionDraft, 아니면 null | 3 (0 failures → null / 실패가 tool_failed만 → null / verification_failed → draft) |
| `evolveRelatedMemories` | [core/learning-curate.mjs:815-844](core/learning-curate.mjs) | DI 기반 (deps 주입), memory-evolution `findNeighbors` + `applyEvolution` + semantic-store `upsertLesson` 위임 | 2 (deps 누락 에러 / 1 neighbor 진화) |
| `distillProceduralMemory` | [core/learning-curate.mjs:861-934](core/learning-curate.mjs) | 순수, 30일 window + repeatThreshold 3 + LCS ratio ≥ 0.5 검증 | 3 (2회 skip / 3회 candidate / 30일 초과 exclude) |

---

## session-end-engine 훅 순서 (Design-A §4-B)

`runSessionEndHooks` 내 고정 순서 (매니페스트 flag로 skip 가능):

1. **capture_events** — 항상
2. **lesson_draft** → **lesson_upsert** — `evolutionEnabled !== false`
3. **reflection_draft** → **reflection_upsert** — `reflectionsEnabled !== false`
4. **troubleshooting_draft** → **troubleshooting_write** — `task.failures.length >= 1` 시에만
5. **architecture_detect** — hook 제공 시 항상
6. **worklog** — 항상, `buildHandoffWorklog` 5섹션 markdown 생성
7. **procedural_distill** → **procedural_upsert** (배치) — `proceduralEnabled !== false`

각 훅은 `timedStep` 격리 — 단일 훅 실패가 후속 훅을 막지 않음.

### Handoff 5섹션 순서 (고정)

[core/session-end-engine.mjs:186-192](core/session-end-engine.mjs)의 `HANDOFF_SECTION_HEADERS` (Object.freeze):

1. `## 이번 세션에서 한 일`
2. `## 남은 일 (다음 세션 먼저 할 것)`
3. `## 건드리면 안 되는 것`
4. `## 핵심 가정 (깨지면 재설계)`
5. `## 한 줄 메모`

테스트 `renders all 5 headers in fixed order`에서 markdown 내 등장 순서 검증.

---

## 테스트 결과

- 실행: `node --test`
- 결과: **173 pass / 0 fail** (Wave 1 회귀 0건)
- 신규 테스트 파일 4개 / 총 32 케이스:
  - `commands/__tests__/task-start-dry-run.test.mjs`: 7
  - `commands/__tests__/post-edit.test.mjs`: 3
  - `core/__tests__/learning-curate.test.mjs`: 13
  - `core/__tests__/session-end-engine.test.mjs`: 9

---

## 병렬 세션 충돌 체크

| 영역 | 수정 건수 | 확인 |
|------|-----------|------|
| `core/memory/*` (Wave 1 A1) | 0 | ✅ 읽기만 (learning-curate / session-end-engine이 DI로 호출) |
| `core/eval/*`, `templates/eval/*` (Wave 1 C1) | 0 | ✅ |
| `core/doctor-*`, `core/manifest-schema.mjs` (Wave 1 B1) | 0 | ✅ (manifest-schema는 기존 그대로) |
| `core/learning-capture.mjs` file_read 분기 (A1) | 0 | ✅ 읽기만 (`isReadableDocPath`, `captureFileRead` 호출) |
| `commands/doctor.mjs` (Wave 2 B2) | 0 | ✅ |
| `commands/eval-*.mjs` (Wave 3) | 0 | ✅ |
| `commands/init-project.mjs` (Wave 3) | 0 | ✅ |
| `templates/agents/*`, `templates/hooks/*` | 0 | ✅ |

---

## Wave 2 B2/C2 블로커 해제 확인

- ✅ `task-start.mjs --dry-run` 구현 → Task-B2 C09 (doctor probe) spawn 계약 충족 가능
- ✅ learning-curate 5 builder export 시그니처 고정 → Task-C2 golden-task-runner가 동일 시그니처로 호출 가능
- ✅ post-edit `file_read` 이벤트 기록 → Task-C2 eval-retrieval 입력 확보

---

## 가정 / 미결정

- **task-start CLI의 기본 syncVault**: 실제 mirror sync는 `commands/obsidian-sync.mjs` 훅이 담당하도록 위임. task-start는 `{ ok: true, skipped: true }`만 반환 (dry-run/실모드 공통). 이 구조는 Design-A §2-B-2 "task-start는 context 계산만, sync는 별도 훅" 계약과 정합.
- **Procedural distillation은 LCS 채택**: LLM 미사용 (Design-A O-2). `lcsRatio` 순수 함수로 pair-wise similarity 계산, bucket 내 유사 쌍이 과반 이상이어야 candidate 확정.
- **lesson-promote v3 시딩은 덮어쓰지 않음**: 기존 draft에 이미 v3 필드가 있으면 유지, 누락된 필드만 기본값 주입.
- **Handoff Worklog oneLiner 기본값**: 명시 전달이 없을 때 `next session entry: <task title>`. 운용 중 더 나은 기본이 나오면 worklog-generate에서 override 가능.
- **knowledge-index-build의 `09_Templates/Procedures/` 스캔**: `_pattern.md` 같은 템플릿 스켈레톤(`_` prefix)은 `isSeedableDoc` 필터로 제외. 실제 인스턴스 파일이 있을 때만 `procedures.jsonl`에 수집.

---

## 완료 체크리스트

- [x] 10개 commands/*.mjs 전부 실행 가능 + 증분 요구사항 적용
- [x] `task-start.mjs --dry-run` 9필드 JSON + 부수효과 0건
- [x] learning-curate 5 builder export (buildLessonDraft/buildTroubleshootingDraft/buildReflectionDraft/evolveRelatedMemories/distillProceduralMemory)
- [x] session-end-engine Handoff 5섹션 (`buildHandoffWorklog`) + 훅 순서 (`runSessionEndHooks`)
- [x] 전체 테스트 PASS (173/173, Wave 1 141 + Wave 2 32)
- [x] 1-line 검증 `true`
- [x] 병렬 세션 영역 충돌 0건
