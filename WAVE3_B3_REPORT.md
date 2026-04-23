# WAVE3-B3 구현 보고서

## 변경 파일 목록
- 확장 `commands/install-hooks.mjs` (template-copy mode 추가, 기존 manifest mode 보존)
- 신설 `commands/__tests__/install-hooks.test.mjs` (8 케이스)
- 확장 `core/doctor-checks.mjs` (C11 `checkTemplateIntegrity` 메시지 강화 — missing/mismatch 분리 + 파일명 포함)
- 확장 `core/__tests__/doctor-checks.test.mjs` (C11 +2 케이스: required 누락 / optional 누락)

**수정 금지 영역 위반 0건** (C01~C10, C12 손대지 않음 / templates/hooks/*.sh 내용 미수정 / init-project.mjs 미수정 / templates/_manifest.json 미수정).

## install-hooks.mjs 인자 체크

| 인자 | 구현 위치 | 충족 |
|------|----------|------|
| --project-dir | install-hooks.mjs:462 | ✅ |
| --preserve <csv> | L435 | ✅ |
| --from-manifest | L439 | ✅ |
| --force | L440 | ✅ |
| --dry-run | L441 | ✅ |
| --help | L442 (`-h` 별칭 포함) | ✅ |

### 모드 자동 분기
- **Template-copy mode** (Wave 3 B3 계약): 위 플래그 하나라도 주어지거나 `runtime-manifest.json`이 없을 때.
- **Manifest mode** (legacy Wave 0): 위 플래그 없음 + manifest 존재 시 기존 Wave 0 경로 유지 (shell wrapper 생성 + settings.json 패치 + runtime-version.json 작성).

## preserveHooks 계약 (§12-2 + EXEC_D_PATCH §4)

| 시나리오 | 동작 | 증거 |
|---------|------|------|
| 빈 `.claude/hooks/` | 6 core 설치 | install-hooks.test.mjs:66~79 |
| 기존 + `--preserve <name>` | preserve 대상 skip, 내용 유지 | L81~100 |
| `--force` | 기존 파일 덮어쓰기 | L102~118 |
| `--dry-run` | 실제 복사 없음, plan만 stdout | L120~134 |
| `--from-manifest` | manifest.preserveHooks 반영 | L136~168 |
| 인자 누락 → exit 2 | `process.exit(2)` | L52~56 |

**preserveHooks 수정 없음** — 읽기 전용 (`readManifestPreserveList`).

## stdout JSON 스키마 (template-copy mode)

```json
{
  "installed": ["runtime-post-edit.sh", ...],
  "preserved": ["error-detector.sh", ...],
  "skipped": [{"name": "runtime-session-start.sh", "reason": "exists, use --force to overwrite"}]
}
```

Exit code: 0 (정상/skip), 2 (인자 오류).

## C11 보강 체크

| 계약 | 충족 | 증거 |
|------|------|------|
| templates/_manifest.json 로드 | ✅ (pre-existing) | doctor-checks.mjs:670 |
| required: true 파일 존재 검증 | ✅ | L692~694 |
| SHA256 일치 검증 | ✅ | L696~699 |
| missing → fail with names | ✅ | L701~710 (`"N required file(s) missing: ..."`) |
| mismatch → fail with names | ✅ | L711~721 (`"N checksum mismatch: ..."`) |
| optional(`required:false`) 누락 무시 | ✅ | L693 조건 분기 |

## 테스트 결과

```
$ node --test
ℹ tests 233
ℹ pass 233
ℹ fail 0
ℹ duration_ms ~1082
```

본 세션 신규:
- `commands/__tests__/install-hooks.test.mjs`: **8 케이스** PASS
  1. exit 2 on missing --project-dir
  2. --help exit 0
  3. empty dir → 6 core install
  4. --preserve로 기존 파일 보존
  5. --force 덮어쓰기
  6. --dry-run 무복사
  7. --from-manifest 통합
  8. 1-line 검증 (installed.length >= 5)
- `core/__tests__/doctor-checks.test.mjs` C11 추가: **2 케이스** PASS
  - required 파일 누락 → fail + 파일명 포함
  - optional 파일 누락 시 pass

## 1-line 검증 (지시문 §완료 기준)

```bash
$ TMPDIR=$(mktemp -d) && mkdir -p "$TMPDIR/.claude" && \
  node commands/install-hooks.mjs --project-dir "$TMPDIR" | \
  node -e "const j=JSON.parse(require('fs').readFileSync(0));console.log(j.installed.length >= 5)"
true
```

## 병렬 세션 충돌 체크

| 금지 영역 | 수정 건수 |
|----------|---------|
| core/memory/*, core/eval/*, core/learning-* | 0 |
| core/doctor-checks.mjs C01~C10, C12 | 0 (C11 메시지 포맷만 확장) |
| core/manifest-schema.mjs, core/doctor-rollback.mjs | 0 |
| commands/init-project.mjs (A3), commands/eval-*.mjs (C3) | 0 |
| commands/doctor.mjs, task-start.mjs 등 Wave 2 | 0 |
| templates/hooks/*.sh 파일 내용 | 0 (복사만) |
| templates/_manifest.json | 0 (A3 담당) |
| templates/agents/_lead.md | 0 (A3 담당) |

## 가정 / 미결정

- **preserveHooks는 프로젝트 로컬 정의** (기획서 §12-2): manifest.preserveHooks 배열을 그대로 존중, install-hooks는 쓰기/수정 없이 읽기만.
- **DEFAULT_PRESERVE_LIST는 legacy manifest mode에서만 적용**: template-copy mode에선 명시적 `--preserve`/`--from-manifest`만 사용. Wave 3 B3 지시문 §12-2 정합성 ("프로젝트 로컬, 글로벌 기본값 없음")에 맞춤.
- **TalkUp 본체 8개 preserve**는 본체 쪽 runtime-manifest.json에 등록된 상태여야 하며, 본 세션의 `--from-manifest` 경로로 자동 반영됨.
- **Windows chmod**: `fs.chmodSync(dst, 0o755)`는 Windows에서 무의미하지만 실패하더라도 try/catch로 무시 (파일 자체는 정상 복사).
- **Mode 자동 분기**: CLI 유저가 B3 인터페이스 플래그를 쓰면 template-copy mode, 그 외 legacy 경로는 기존 Wave 0 설치 흐름 유지 → Wave 3 A3의 init-project에서 `--from-manifest` 호출 시 자연스러운 통합 지점 확보.
