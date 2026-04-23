# WAVE2-B2 구현 보고서

**브랜치**: `wave2-b2-doctor-main`
**베이스**: `wave2-a2-commands-curate` (A2 완료, 173 tests)
**최종 테스트**: **202 pass / 0 fail** (A2 173 + B2 신규 29)

---

## 변경 파일 목록

### 신설
- [commands/doctor.mjs](commands/doctor.mjs) — 438줄. Design-B §1~§5 기반 12체크 오케스트레이터 (기존 360줄 구버전 완전 교체)
- [scripts/build-template-manifest.mjs](scripts/build-template-manifest.mjs) — 156줄. 빌드 타임 SHA256 체크섬 생성기 (PATCH §5-B)
- [templates/_manifest.json](templates/_manifest.json) — 123줄. 19 파일 × sha256/size/required 기록 (빌드 출력)
- [commands/__tests__/doctor-main.test.mjs](commands/__tests__/doctor-main.test.mjs) — 188줄. parseArgs 5 + CLI smoke 7 = 12 케이스
- [scripts/__tests__/build-template-manifest.test.mjs](scripts/__tests__/build-template-manifest.test.mjs) — 176줄. isRequired 6 + buildManifest 4 + writeManifest 2 = 12 케이스

### 수정
- [core/doctor-checks.mjs](core/doctor-checks.mjs) — C09 `checkTaskStartDryRun` 함수 신설 (+112줄) + `ALL_CHECK_IDS` 배열에 `'c09'` 활성화 (1줄). 기존 C01~C08, C10~C12 **미수정**.
- [core/__tests__/doctor-checks.test.mjs](core/__tests__/doctor-checks.test.mjs) — C09 describe 블록 5 케이스 추가 + ID-coverage assertion을 11→12로 갱신
- [package.json](package.json) — `scripts.build:template-manifest` / `scripts.prepublishOnly` / `scripts.test` 추가 + `files[]`에 `scripts` 포함

---

## doctor.mjs 엔트리 구조

### parseArgs (Design-B §2-1)
6 플래그 지원: `--project-dir` / `--full` / `--eval` / `--json` / `--no-rollback-on-failure` / `--since-init` (+ `--help`)

### main 흐름
```
parseArgs → buildContext(ctx) → runChecks(checkIds, ctx)
         → (--json ? printReportJson : printReportText)
         → (--eval + full ? runEvalMode : maybeRollback)
```

- **basic** (default): `C01..C06` 6체크
- **full** (`--full`): `ALL_CHECK_IDS` 12체크
- **json** (`--json`): Design-B §5-3 스키마 (package/projectDir/mode/sinceInit/counts/elapsedMs/checks[]/rollback?)
- **eval** (`--eval`, full 필요): 12/12 PASS 후 eval-run spawn

### ctx 전파
`{ projectDir, packageRoot, manifest: null, paths: null }` — C02가 `ctx.manifest` populate, C03가 `ctx.paths` populate → 후속 C04/C06 참조.

---

## C09 구현 체크 (Design-B §3 C09 + PATCH_Phase1 §3-D)

| 계약 | 충족 | 증거 |
|------|------|------|
| `task-start --dry-run` spawn | ✅ | [core/doctor-checks.mjs:541-557](core/doctor-checks.mjs#L541) spawnSync(execPath, [taskStartPath, '--dry-run', '--task', 'doctor probe', '--project-dir', projectDir]) |
| timeout 30000ms (+ `DOCTOR_TIMEOUT_MS` env override) | ✅ | [core/doctor-checks.mjs:486,559-563](core/doctor-checks.mjs#L486) ETIMEDOUT 분기 |
| 9필드 검증 | ✅ | [core/doctor-checks.mjs:488-498,584-592](core/doctor-checks.mjs#L488) REQUIRED_DRY_RUN_FIELDS 상수 + `missing` 계산 |
| exit ≠ 0 → FAIL | ✅ | [core/doctor-checks.mjs:569-576](core/doctor-checks.mjs#L569) `task-start exited {status}: {stderr}` |
| stdout 파싱 실패 → FAIL | ✅ | [core/doctor-checks.mjs:580-586](core/doctor-checks.mjs#L580) `stdout last line is not JSON` |
| task-start 미설치 → FAIL | ✅ | [core/doctor-checks.mjs:513-517](core/doctor-checks.mjs#L513) `task-start CLI missing` |
| CLAUDE_PROJECT_DIR + SESSION_ID 환경 전파 | ✅ | [core/doctor-checks.mjs:519-521](core/doctor-checks.mjs#L519) `doctor-probe-<ts>` 세션 충돌 회피 |

**실측 (본 프로젝트 `--full` 실행)**: `[OK] C09  task-start dry-run schema   9/9 fields present, 64ms`

---

## stdout 포맷 검증 (Design-B §5)

### §5-1 전체 PASS 포맷 ✅
실제 본 프로젝트 실행 결과 (빈 `.claude/` 상태):
```
claude-obsidian-runtime doctor
Package:     v3.0.0
Project:     C:\JSProj\claude-obsidian-runtime
Mode:        full

[OK]    C01  CLAUDE_RUNTIME_HOME                    Set to ...
[FAIL]  C02  runtime-manifest.json (6-axis)         Missing at ...
        -> Run: claude-obsidian-runtime init --project-id <id>
...
[OK]    C09  task-start dry-run schema              9/9 fields present, 64ms
[OK]    C11  Template integrity                     19 template file(s), checksums match
...
Summary: 4 pass, 6 warn, 2 fail   (elapsed: 0.1s)
```
헤더 4줄 + 체크별 `[STATUS] CID  name   message` + remedy 들여쓰기 `-> ...` + Summary 포맷 모두 §5-1 일치.

### §5-2 롤백 프롬프트 포맷 ✅
`maybeRollback()`에서 failCount > 0 + `--since-init` + TTY + !noRollback 조건 충족 시:
```
---
N check(s) failed during post-init validation.
Automatic rollback available:
  Backup: .claude.backup-<ts>/
  Changes to restore:
    M .claude/runtime-manifest.json
    ...
Rollback? [y/N]: _
```
- `y` → `performRollback` + exit 2
- `n` / non-TTY / `--json` / `--no-rollback-on-failure` → exit 1 (프롬프트 skip)

### §5-3 `--json` 스키마 ✅
[commands/doctor.mjs:222-245](commands/doctor.mjs#L222) `printReportJson`:
```json
{
  "package": "3.0.0",
  "projectDir": "...",
  "mode": "full",
  "sinceInit": false,
  "counts": { "pass": 4, "warn": 6, "fail": 2 },
  "elapsedMs": 135,
  "checks": [ { "id": "c01", "name": "...", "status": "pass", "message": "...", "detail": null, "elapsedMs": 2 }, ... ],
  "rollback": { "available": true, "performed": false, "reason": "..." }
}
```
JSON 모드는 비대화형 원칙(§Z-3 미결정 3번) 준수 — 자동으로 rollback 프롬프트 skip.

---

## `--eval` 모드 계약 (Design-B §5-4)

| 계약 | 구현 위치 | 충족 |
|------|----------|------|
| 12/12 PASS 아니면 "Cannot run eval" + exit 1 | [commands/doctor.mjs:329-333](commands/doctor.mjs#L329) | ✅ |
| `$CLAUDE_RUNTIME_HOME/commands/eval-run.mjs` 미존재 시 친절 메시지 | [commands/doctor.mjs:336-340](commands/doctor.mjs#L336) "Design-C not yet integrated" | ✅ |
| `REPORT=<path>` 라인 파싱 → `Eval report: <path>` 출력 | [commands/doctor.mjs:357-363](commands/doctor.mjs#L357) `.startsWith('REPORT=')` | ✅ |
| eval-run exit code가 doctor 최종 exit code 덮어씀 | [commands/doctor.mjs:367,425-428](commands/doctor.mjs#L367) | ✅ |

테스트 커버: `--eval` without 12/12 PASS → "Cannot run eval with failed checks" (smoke 확인).

---

## templates/_manifest.json 빌드 (PATCH §5-A/B)

### 생성 스크립트
- 위치: [scripts/build-template-manifest.mjs](scripts/build-template-manifest.mjs)
- 엔트리: `node scripts/build-template-manifest.mjs` (또는 `npm run build:template-manifest`)
- `prepublishOnly` 훅에 연결 → `npm publish` 시 자동 갱신

### 출력 파일 (실측 실행 후)
- **생성 파일**: `templates/_manifest.json` (123줄)
- **포함 파일 수**: **19** (`_manifest.json` 자신은 제외)
- **required: true 파일**: **13**
  - `hooks/*.sh` × 6 (runtime-post-edit / prompt-context / session-end / session-start / stop / subagent-start)
  - `obsidian_paths.json`, `context_routes.json`, `runtime-manifest.json`
  - `vault/00_Home/*.md` × 3 (_Index / Current_Focus / Reading_Order)
  - `eval/golden-tasks.json`
- **required: false 파일**: **6** (모두 `commands/*.md` slash command templates)

### 결정론 보장
- `files[]` sorted by `relPath` lexicographically
- `rootFingerprint = SHA256(sorted(sha256 of each file))`
- 테스트 `is deterministic — same inputs yield identical rootFingerprint` PASS

### C11 정합성
- 현 브랜치에서 `doctor --full` 실행 시 C11: `[OK] 19 template file(s), checksums match`
- 빌드 타임 생성 계약 (PATCH §5-B) 준수 — 사용자는 `_manifest.json` 수동 편집 금지

---

## 테스트 결과

```
실행: node --test
ℹ tests 202
ℹ suites 34
ℹ pass 202
ℹ fail 0
ℹ duration_ms ~778
```

### 본 세션 신규 29 케이스
| 파일 | 케이스 수 | 커버리지 |
|------|----------|---------|
| `core/__tests__/doctor-checks.test.mjs` (C09 블록 신설) | 5 | PASS 9-field / FAIL missing-field / FAIL exit!=0 / FAIL non-JSON / FAIL cli-missing |
| `commands/__tests__/doctor-main.test.mjs` | 12 | parseArgs 5 + CLI smoke 7 (--help / basic / --full / --json / --since-init --no-rollback / --eval 실패 / eval-run 부재 소스 검증) |
| `scripts/__tests__/build-template-manifest.test.mjs` | 12 | isRequired 6 + buildManifest 4 (스키마/결정론/정렬/sha256) + writeManifest 2 (self-exclude / missing-dir throw) |

회귀 0건 (A2 173 케이스 전원 PASS).

---

## 1-line 검증

```bash
$ node commands/doctor.mjs --full --project-dir "$PWD" --json \
    | node -e "let s='';process.stdin.on('data',d=>s+=d);\
process.stdin.on('end',()=>{const j=JSON.parse(s);console.log(j.counts.pass>=2)})"
true
```

(본 프로젝트 디렉토리는 `.claude/runtime-manifest.json` 미보유 → C02/C05 FAIL이 예상됨. 빈 레포 스모크로 12체크 실행 · JSON 파싱 가능 · counts.pass ≥ 2 확인)

---

## 병렬 세션 충돌 체크

| 영역 | 수정 건수 | 확인 |
|------|-----------|------|
| `core/memory/*.mjs`, `core/learning-capture.mjs` (Wave 1 A1) | **0** | 읽지도 수정하지도 않음 |
| `core/eval/*.mjs`, `templates/eval/*` (Wave 1 C1) | **0** | ✅ |
| `core/manifest-schema.mjs`, `core/doctor-rollback.mjs` (Wave 1 B1) | **0** | import만 (구조적 의존성 — 수정 아님) |
| `core/doctor-checks.mjs` C01~C08, C10~C12 | **0 수정** | C09 신규 함수 추가 + `ALL_CHECK_IDS` 배열에 `'c09'` 활성화 1줄만 |
| `commands/task-start.mjs`, `learning-curate.mjs`, `session-end-engine.mjs` (A2) | **0** | spawn만 (소스 무변경) |
| `commands/eval-*.mjs`, `init-project.mjs` (Wave 3) | **0** | eval-run은 존재 검사만 (부재 시 skip) |
| `templates/agents/*`, `templates/hooks/*`, `templates/vault/*` | **0** | hooks는 sha256 계산 대상이지만 파일 내용 무변경 |

---

## 가정 / 미결정

### 준수한 Design-B §Z-3 가정
1. **A-1 (`--eval` spawn 계약)**: `REPORT=<path>` 파싱 + exit code propagation 구현. eval-run.mjs는 Design-C 범위로 위임, 부재 시 친절 메시지.
2. **A-2 (`task-start --dry-run`)**: A2 세션에서 완료된 9필드 JSON 출력을 C09가 소비. 실측 64ms, 9/9 필드 확인.
3. **A-3 (manifest v0.3 스키마)**: 본 세션 범위 외 (C02 자체는 B1에서 완료).
4. **A-4 (backup 보관 정책)**: 본 세션 범위 외. `performRollback` 호출만 담당.

### Design-B §Z-3 미결정 항목 대응
1. **미결정 1 (병렬/순차)**: 순차 채택. `runChecks`가 ctx를 순차 전파해 C02→C06, C02→C09 의존성 보장. 성능 이슈 발생 시 후속 세션에서 `Promise.allSettled` 전환 고려.
2. **미결정 2 (C09 재시도)**: 1회 시도 후 FAIL 확정 (PATCH §Z-3-A PA-6 2회 연속 정책은 향후 확장 여지).
3. **미결정 3 (JSON 모드 rollback)**: **"JSON 자동 non-interactive"** 채택. `args.json` 자체를 non-TTY로 취급해 프롬프트 전면 skip (info만 JSON에 수록).
4. **미결정 4 (timeout)**: `DOCTOR_TIMEOUT_MS` env 기본 30000ms, 초과 시 `timed out after {ms}ms` FAIL.

### 구현 중 결정
- **`--eval`은 `--full`과 동시에 있어야 동작**: basic 6체크로는 eval 전제(12/12) 미달. [commands/doctor.mjs:424](commands/doctor.mjs#L424)에서 `if (args.eval && args.full)` 조건 명시.
- **`buildContext`의 `packageRoot`는 `process.env.CLAUDE_RUNTIME_HOME || PACKAGE_ROOT`**: env 우선 + 설치본 fallback. C09 spawn과 C11 template 검증 둘 다 이 경로 사용.
- **`runChecks` 예외 처리**: check 함수가 throw하면 `{ id, name, status: 'fail', message: 'check threw: ...' }`로 감싸 pipeline 중단 방지. 본 세션에서는 12 체크 모두 현재 예외 없이 return.

### 후속 세션으로 위임
- Design-C 완료 시 `--eval` 실제 경로 E2E 테스트 보강 (현재는 eval-run 미존재 경로만 smoke).
- `doctor-rollback.promptRollback`의 readline DI가 본 세션 non-TTY 자동 abort만 검증. 실제 사용자 입력 E2E는 Wave 3 통합 테스트.
- `performRollback` 호출 후 doctor stdout 포맷의 전체 스냅샷 테스트 (현재는 restored/partial count 메시지 검증 생략).

---

## 완료 체크리스트

- [x] `commands/doctor.mjs` 실행 가능 + `--help` 출력 (`printHelp` 12 케이스 중 smoke PASS)
- [x] `node commands/doctor.mjs --full --project-dir <proj>` 실행 시 12체크 모두 실행 (C09 포함 실측 확인)
- [x] `core/doctor-checks.mjs`에 `checkTaskStartDryRun` export + `ALL_CHECK_IDS`에 `'c09'` 추가
- [x] `node commands/doctor.mjs --full --json` Design-B §5-3 스키마 JSON 출력
- [x] `node scripts/build-template-manifest.mjs` 실행 시 `templates/_manifest.json` 생성 (19 파일, 13 required)
- [x] `doctor-main.test.mjs` + `build-template-manifest.test.mjs` 테스트 PASS
- [x] 전체 테스트 (Wave 1 + Wave 2 A2 + 본 B2) 모두 PASS (202/202)
- [x] 병렬 세션 영역 수정 0건
