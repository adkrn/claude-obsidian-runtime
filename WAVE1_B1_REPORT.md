# WAVE1-B1 구현 보고서

**세션**: Wave 1 / B1 (doctor core 모듈)
**범위**: `core/manifest-schema.mjs` + `core/doctor-rollback.mjs` + `core/doctor-checks.mjs` (C09 제외)
**기준 문서**: eventual-jingling-adleman.md §12-4/12-5/12-6, DESIGN_B_step5.md §2-3/§2-4/§3/§5-2, PATCH_Phase1.md §2-A/§2-D/§4-A/§5-A

---

## 변경 파일 목록

신설 (git 기준이 아니라 현재 `C:/JSProj/claude-obsidian-runtime/` 기준 신규 파일):

```
core/manifest-schema.mjs                        (313 lines, NEW)
core/doctor-rollback.mjs                        (324 lines, NEW)
core/doctor-checks.mjs                          (717 lines, NEW)
core/__tests__/manifest-schema.test.mjs         (159 lines, NEW)
core/__tests__/doctor-checks.test.mjs           (396 lines, NEW)
core/__tests__/doctor-rollback.test.mjs         (173 lines, NEW)
WAVE1_B1_REPORT.md                              (this file, NEW)
```

Repo가 git 레포가 아니므로 `git diff --name-only` 출력은 생략. 위 7개 파일만 신설.

---

## 신설 export 시그니처 요약

### `core/manifest-schema.mjs`
- `validateManifest(data: unknown): { valid: boolean, errors: SchemaError[] }` — [manifest-schema.mjs:293](core/manifest-schema.mjs#L293)
- `REQUIRED_MANIFEST_AXES: string[]` — 6축 이름 목록 — [manifest-schema.mjs:313](core/manifest-schema.mjs#L313)
- `SchemaError`: `{ path, expected, actual, severity: 'fail'|'warn' }`

### `core/doctor-rollback.mjs`
- `findLatestBackup(projectDir: string): string | null` — [doctor-rollback.mjs:48](core/doctor-rollback.mjs#L48)
- `diffAgainstBackup(projectDir, backupDir): DiffLine[]` — [doctor-rollback.mjs:121](core/doctor-rollback.mjs#L121)
- `promptRollback(diff, io?): Promise<'rollback'|'abort'>` — [doctor-rollback.mjs:190](core/doctor-rollback.mjs#L190)
- `performRollback(opts): Promise<{restored, partial, logPath}>` — [doctor-rollback.mjs:263](core/doctor-rollback.mjs#L263)
- `ROLLBACK_TARGET_PATHS` — `['runtime-manifest.json','settings.json','hooks','agents']`

### `core/doctor-checks.mjs`
- `checkRuntimeHome (C01)` — [doctor-checks.mjs:120](core/doctor-checks.mjs#L120)
- `checkManifestSchema (C02)` — [doctor-checks.mjs:148](core/doctor-checks.mjs#L148) (manifest-schema.mjs 위임)
- `checkObsidianPaths (C03)` — [doctor-checks.mjs:180](core/doctor-checks.mjs#L180)
- `checkManagedRoots (C04)` — [doctor-checks.mjs:220](core/doctor-checks.mjs#L220)
- `checkHookWrappers (C05)` — [doctor-checks.mjs:252](core/doctor-checks.mjs#L252)
- `checkLeadAgent (C06)` — [doctor-checks.mjs:320](core/doctor-checks.mjs#L320)
- `checkCodeIndex (C07)` — [doctor-checks.mjs:360](core/doctor-checks.mjs#L360)
- `checkKnowledgeIndex (C08)` — [doctor-checks.mjs:409](core/doctor-checks.mjs#L409)
- **[TODO Wave 2]** `checkTaskStartDryRun (C09)` — 미구현. 주석만 [doctor-checks.mjs:495-503](core/doctor-checks.mjs#L495)
- `checkPrerequisites (C10)` — [doctor-checks.mjs:508](core/doctor-checks.mjs#L508)
- `checkTemplateIntegrity (C11)` — [doctor-checks.mjs:557](core/doctor-checks.mjs#L557)
- `checkPerformanceObservability (C12)` — [doctor-checks.mjs:649](core/doctor-checks.mjs#L649)
- `ALL_CHECK_IDS` — C09 제외 11개 — [doctor-checks.mjs:704](core/doctor-checks.mjs#L704)
- `DEFAULT_MANAGED_ROOTS` — §12-5 기본 9개 — [doctor-checks.mjs:40](core/doctor-checks.mjs#L40)
- `EXPECTED_CORE_HOOKS` — Core 6개

공통 Check shape: `{ id, name, status, message, detail?, elapsedMs }` — Design-B §2-2 정합.

---

## Design-B + PATCH §2 계약 체크

| 계약 | 충족 | 증거 |
|------|------|------|
| PATCH §2-A 6축 필수 검증 | ✅ | `REQUIRED_AXES` 상수 + [manifest-schema.mjs:170](core/manifest-schema.mjs#L170) `validateRequiredAxes` (projectTag/defaultScope/surfacePatterns/scopeFolderMap/preserveHooks/sessionEndPipeline) |
| PATCH §2-D 6축 누락 → FAIL | ✅ | [manifest-schema.mjs:170-209](core/manifest-schema.mjs#L170) — 각 필드 누락 시 `severity: 'fail'` 기록 |
| PATCH §2-D 확장 미선언 → PASS | ✅ | [manifest-schema.mjs:215-265](core/manifest-schema.mjs#L215) `validateOptionalExtensions` — `=== undefined` 체크로 미선언은 오류 없음 |
| PATCH §2-D 확장 형식 오류 → FAIL | ✅ | [manifest-schema.mjs:235-264](core/manifest-schema.mjs#L235) `retrievalWeights` 각 키/`memoryLayers` 각 키 타입 검사, 실패 시 `severity: 'fail'` |
| PATCH §2-D `managedRoots` 빈 배열 허용 | ✅ | [manifest-schema.mjs:223-233](core/manifest-schema.mjs#L223) — 배열 타입만 검증, 길이 0 허용 |
| §12-5 managedRoots 기본 9개 | ✅ | [doctor-checks.mjs:40-50](core/doctor-checks.mjs#L40) + [doctor-checks.mjs:207-213](core/doctor-checks.mjs#L207) fallback (manifest/paths 둘 다 없으면 기본 9개) |
| §12-5 선언분만 검증 (빈 배열 허용) | ✅ | [doctor-checks.mjs:226-228](core/doctor-checks.mjs#L226) — 빈 배열이면 PASS + `explicit empty` 메시지 |
| §12-4 자동 롤백 프롬프트 | ✅ | [doctor-rollback.mjs:190-223](core/doctor-rollback.mjs#L190) `promptRollback` — diff count 표시 + `y/N` 입력 |
| §12-4 `--no-rollback-on-failure` (비대화형) | ✅ | [doctor-rollback.mjs:195-198](core/doctor-rollback.mjs#L195) — stdin TTY 아니거나 `forceNonTty` 옵션 시 자동 `abort` |
| §12-4 `.claude.backup-<timestamp>/` 탐지 | ✅ | [doctor-rollback.mjs:40-82](core/doctor-rollback.mjs#L40) `findLatestBackup` — `^\.claude\.backup-(.+)$` 정규식 + mtime + stamp 정렬 |
| §12-4 partial-restore 로그 | ✅ | [doctor-rollback.mjs:245-259](core/doctor-rollback.mjs#L245) `writePartialRestoreLog` — `.claude.partial-restore-<ts>.log` 생성 |
| Design-B §2-3 `ManifestData` 필드 | ✅ | PATCH §2-C 갱신본 기반. `runtimeVersion`은 검증 대상 외 (presence만) |
| Design-B §3 C11 SHA256 | ✅ | [doctor-checks.mjs:580-607](core/doctor-checks.mjs#L580) — `templates/_manifest.json.files[]` 각 entry와 실파일 sha256 비교. 파일 없으면 WARN (PATCH §5-B "빌드 타임 생성" 정합) |
| Design-B §5-2 FAIL 메시지 포맷 | ✅ (Check 반환값까지) | 각 `finishFail` 메시지가 예시 형태 준수. stdout 최종 출력은 Wave 2 `commands/doctor.mjs` 책임 |

---

## 테스트 결과

```
실행: node --test core/__tests__/manifest-schema.test.mjs core/__tests__/doctor-checks.test.mjs core/__tests__/doctor-rollback.test.mjs

ℹ tests 64
ℹ suites 18
ℹ pass 64
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ duration_ms ~361
```

테스트 커버리지:
- `manifest-schema` — 16 케이스 (6축 누락 / 확장 미선언 / 확장 형식 오류 / 빈 배열 허용 / record form surfacePatterns)
- `doctor-checks` — 36 케이스 (C01~C12 중 11개. 각 PASS/FAIL/WARN 경계값)
- `doctor-rollback` — 12 케이스 (backup 탐색 / diff MAD / prompt TTY 분기 / performRollback 복원·삭제·로그 / backupDir 없음 throws)

### 1-line 실행 검증 (지시문 완료 기준)
```bash
$ node -e "import('./core/manifest-schema.mjs').then(m => console.log(JSON.stringify(m.validateManifest({projectTag:'test',defaultScope:'x',surfacePatterns:['a'],scopeFolderMap:{x:['y']},preserveHooks:[],sessionEndPipeline:[]}))))"
{"valid":true,"errors":[]}
```

---

## 병렬 세션 충돌 체크

| 금지 영역 | 수정 여부 |
|-----------|-----------|
| `core/memory/*.mjs` (세션-A1) | 0건 (해당 디렉토리는 현재 존재하지 않음) |
| `core/learning-capture.mjs` (세션-A1) | 0건 |
| `core/eval/*.mjs` (세션-C1) | 0건 (해당 디렉토리 존재하지 않음) |
| `commands/*.mjs` 전부 (Wave 2) | 0건 |
| `commands/doctor.mjs` (Wave 2) | 0건 |
| `templates/*` (Wave 2/3) | 0건 |

본 세션 변경 파일은 **전부 신설**이며 `core/` 및 `core/__tests__/` + 루트의 리포트 1건뿐.

---

## C09 처리 현황

- `checkTaskStartDryRun` 함수 미구현. [doctor-checks.mjs:495-503](core/doctor-checks.mjs#L495)에 TODO 주석 블록:
  - spawn 명령 계약 (`node ${CLAUDE_RUNTIME_HOME}/commands/task-start.mjs --dry-run --task "doctor probe" --project-dir <projectDir>`)
  - 9필드 JSON 요구사항 나열 (taskId / readFirst / codeHits / knowledgeHits / guardrails / matchedScopes / matchedGroups / currentTaskPath / lastContextPath)
  - 전제 조건 (Wave 2에서 task-start CLI에 `--dry-run` 플래그 신설) 명시
- `ALL_CHECK_IDS` 배열에서 `'c09'` 주석 처리로 제외 ([doctor-checks.mjs:713](core/doctor-checks.mjs#L713))
- Wave 2 `commands/doctor.mjs` 에서는 본 배열을 import하여 오케스트레이션 + C09 추가 통합

---

## 가정 / 미결정

### 준수한 Design-B §Z-3 가정
1. **A-1 (`--eval` 위임)**: 본 세션 무관. 가정 유지.
2. **A-2 (`task-start --dry-run`)**: Wave 2 의존. C09 TODO 주석으로 명시.
3. **A-3 (manifest v0.3 스키마 고정)**: `runtimeVersion` 필드는 스키마 엄격 검증 대상 외 (presence 없어도 통과). Design-B §2-3 인터페이스엔 있지만 PATCH §2-A 표에서 필수 축에 포함되지 않음 → `validateManifest`는 미체크.
4. **A-4 (backup 보관 기간 90일)**: 본 세션 무관. cleanup은 별도 `backup-cleanup.mjs` 작업 (범위 외).

### 구현 중 결정한 세부사항 (Design-B §Z-3 미결정 항목 대응)
1. **체크 실행 순서 (미결정 1)**: `ALL_CHECK_IDS` 배열은 순서만 제공. 병렬/순차 선택은 Wave 2 `commands/doctor.mjs` 책임. 본 모듈의 개별 check는 **서로 독립**이며 context 전파(`ctx.manifest`, `ctx.paths`)만 C02/C03이 populate.
2. **C11 manifest 부재 처리 (PATCH §5-B 연계)**: `templates/_manifest.json` 미존재 시 **WARN**. 빌드 타임 생성 전제라 패키지 내부에 항상 있어야 하지만, Wave 1 단계에서는 아직 생성되지 않았을 수 있음 → 빌드 파이프라인(Wave 3)이 채울 때까지 warn. FAIL 조건은 templates 디렉토리 자체 부재 / 체크섬 불일치 / 파일 누락(required: true).
3. **C12 token-usage 스키마**: 기존 repo에 `task-usage/*.json` 스키마 확정이 없음. `extractTokenTotal`이 여러 후보 경로(`.totalTokens`, `.usage.totalTokens`, `.tokens`, `.summary.totalTokens`)를 시도. Wave 2/3에서 스키마 확정 시 단일 경로로 단순화 가능.
4. **C06 frontmatter 검증 깊이**: `name:` + `tools:` 2필드만 검증 (Design-B §3 C06 기준). `description:` 등은 검증 대상 외.

### 미결정 (후속 세션 판단 필요)
- `ctx.manifest` / `ctx.paths`의 캐시 수명: 본 모듈은 check 함수가 ctx에 쓰고 뒤 체크가 읽는 패턴. Wave 2 doctor.mjs가 C02 fail 시 C06/C09 skip 여부 + ctx 초기화 정책 결정.
- Windows에서 `performRollback`의 `fs.rmSync`가 읽기 전용 파일에 실패하는 경우의 강제 삭제 옵션 (`force: true`는 이미 사용). 특이 케이스는 운영 중 발견되면 추가 대응.

---

**세션 종료 준비**: 본 보고서 작성 완료. 병렬 세션 영역 수정 0건, 테스트 64/64 통과, 1-line 계약 검증 통과.
