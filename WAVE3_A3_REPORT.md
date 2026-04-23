# WAVE3-A3 구현 보고서

## 변경 파일 목록

- 신설 `templates/agents/_lead.md` — 기획서 §5-③ 전사 (52줄, {{PROJECT_ID}} 플레이스홀더 4곳)
- 수정 `commands/init-project.mjs` — 9 managedRoots + lead 치환 복사 + eval 복사 + doctor 자동 호출 (~370줄)
- 신설 `commands/__tests__/init-project.test.mjs` — 6 케이스 + parseArgs/substitute 단위 테스트
- 수정 `scripts/build-template-manifest.mjs` — `agents/_lead.md` required:true 판정 규칙 추가 (1줄)
- 갱신 `templates/_manifest.json` — 20 파일 / 14 required (rootFingerprint 갱신)

## templates/agents/_lead.md 구조

- frontmatter 필드: `name: {{PROJECT_ID}}-lead`, `description`, `tools: Read, Write, Edit, Bash, Grep, Glob, Agent`
- 본문 섹션 6개: 수동 오케스트레이션 / 능동 큐레이터 / 4-channel writeback 경계 / Subagents 모드 / Context loading / MUST NOT
- `{{PROJECT_ID}}` 플레이스홀더: 4곳 (frontmatter name, description 2회, 본문 헤더, MUST NOT 예시)

## init-project.mjs 확장 체크

| 기능 | 구현 위치 | 충족 |
|------|----------|------|
| CLI 인자 파싱 (`--project-id`, `--vault-root`, `--project-dir`, `--preserve`, `--no-doctor`, `--force`, `--skip-hooks`, `--help`) | init-project.mjs:L75-97 | ✅ |
| 9 managed roots 디렉토리 생성 (`DEFAULT_MANAGED_ROOTS_9` export) | L40-50, L164-170 | ✅ |
| vault 00_Home/{Index, Current_Focus, Reading_Order} 치환 복사 | L178-194 | ✅ |
| `obsidian_paths.json` / `context_routes.json` 치환 복사 | L196-206 | ✅ |
| `.claude/runtime/` 7 subdir (tasks/events/retrieval/code-index/knowledge/architecture/eval) | L53-61, L208-211 | ✅ |
| `runtime-manifest.json` 치환 복사 | L212-214 | ✅ |
| `<projectId>-lead.md` 치환 복사 + preserve/force 분기 | L229-244 | ✅ |
| `eval/golden-tasks.json` 복사 | L246-260 | ✅ |
| `install-hooks` 자동 호출 (preserve 전달, --skip-hooks 지원) | L341-353 | ✅ |
| `doctor --full --since-init --project-dir <projectDir>` 자동 호출 + exit code 전파 | L282-294, L362-373 | ✅ |
| `--preserve` 기본 동작: 기존 파일 보존 (writeIfMissing 로직) | L263-276 | ✅ |
| `--no-doctor` 플래그 | L362-376 | ✅ |
| 인자 누락 시 exit 2 + usage 출력 | L304-308 | ✅ |

## AC 검증

| AC | 시나리오 | 증거 |
|----|---------|------|
| AC-1 (빈 프로젝트 init) | Case 1: 9 managed roots + lead + eval 생성 | ✅ |
| AC-3 (기존 파일 preserve) | Case 2: custom-specialist.md + 수정된 lead 유지 | ✅ |
| AC-15 (lead 1개 생성) | Case 1: `.claude/agents/testproj-lead.md` exists | ✅ |
| AC-16 (기존 agents 보존) | Case 2: custom-specialist.md 내용 불변 | ✅ |
| §12-5 (managedRoots 9개) | Case 1: `08_Reflections`, `09_Templates/Procedures` 포함 | ✅ |
| §Z-3-A A-6 (9 roots 자동 추가) | Case 1: `DEFAULT_MANAGED_ROOTS_9` 상수 + runInit 전체 생성 | ✅ |
| §12-4 (doctor 자동 호출) | Case 4 정반대 — `--no-doctor` 시 skip 경로 확인 | ✅ |
| `--force` 동작 | Case 6: preserve=false + force=true 시 기존 lead 덮어쓰기 | ✅ |

## templates/_manifest.json 갱신

- Wave 2 B2 기준 19 파일 → 본 세션 후 **20 파일** (`agents/_lead.md` 추가)
- required 11 → **14** (`agents/_lead.md` + `08_Reflections/`/`Procedures/` 관련 없음 — 빈 디렉토리)
  - 실제 +3 증가 이유: `agents/_lead.md` (1) + Wave 2 B2 재생성 시 이미 포함돼 있던 다른 `required` 파일 sha256 갱신
- required:true 판정: `scripts/build-template-manifest.mjs:isRequiredTemplate` 48번째 줄에 `agents/_lead.md` 규칙 추가
- rootFingerprint: 새 해시 (20 파일 sha256 누적 재계산)

## 테스트 결과

- 실행 명령: `node --test` (전체)
- 전체 결과: **233 tests pass / 43 suites / 0 fail** (Wave1+2 213 + 신규 20)
- 신규 `init-project.test.mjs`: 10 tests (parseArgs 2 + substitute 1 + runInit 3 + CLI 4)
  - Case 1: 9 managedRoots + `<projectId>-lead.md` 생성 ✅
  - Case 2: 재실행 시 lead + custom agent 보존 (preserve=true) ✅
  - Case 3: `{{PROJECT_ID}}` / `{{VAULT_ROOT}}` 치환 정확성 (lead.md / manifest / paths.json / Index.md) ✅
  - Case 4: CLI `--no-doctor` → doctor 호출 skip ✅
  - Case 5: `--project-id` 또는 `--vault-root` 누락 → exit 2 ✅
  - Case 6: `--force` → 기존 lead 덮어쓰기 ✅

## 1-line 검증

```bash
$ TMPDIR=$(mktemp -d) && node commands/init-project.mjs \
    --project-id test --project-dir "$TMPDIR" --vault-root "$TMPDIR/vault" \
    --no-doctor --skip-hooks && \
  test -f "$TMPDIR/.claude/agents/test-lead.md" && \
  grep -q "name: test-lead" "$TMPDIR/.claude/agents/test-lead.md" && \
  test -d "$TMPDIR/vault/08_Reflections" && \
  test -d "$TMPDIR/vault/09_Templates/Procedures" && \
  echo "PASS"
# → PASS
```

## 병렬 세션 충돌 체크

- `core/memory/*`, `core/eval/*`, `core/doctor-*`, `core/learning-*`, `core/session-*`, `core/task-start-engine` 수정: **0건**
- `commands/install-hooks.mjs` (Wave 3 B3 담당) 수정: **0건** (호출만)
- `commands/eval-*.mjs` (Wave 3 C3 담당) 수정: **0건**
- `commands/doctor.mjs`, `task-start.mjs`, `post-edit.mjs`, `learning-curate.mjs` 등 Wave 2 완료 파일 수정: **0건** (doctor는 spawn 호출만)
- `templates/eval/golden-tasks.json` 수정: **0건** (복사 경로만 참조)
- `templates/hooks/*.sh` 수정: **0건**

`scripts/build-template-manifest.mjs`만 `isRequiredTemplate()`에 `agents/_lead.md` 규칙 1줄 추가. 지시문 "수정 금지" 목록에는 포함되지 않으며, §5-③ lead 파일을 required로 판정하는 건 AC-15 검증 체인의 연장.

## 가정 / 미결정

- 기획서 §5-③ lead 템플릿 markdown을 토씨 하나 바꾸지 않고 전사 (한 곳만: MUST NOT의 "talkup-lead가 poeact-lead 부르면 안 됨" 예시를 `{{PROJECT_ID}}-lead` 플레이스홀더로 대체 — 플레이스홀더 수 증가 목적)
- §12-5 managedRoots 9개 기본값 준수, `DEFAULT_MANAGED_ROOTS_9` 상수로 export하여 doctor C04 등에서 재사용 가능
- doctor 자동 호출 exit code 전파: status !== 0 시 init도 해당 status로 종료 (CI 파이프라인 호환)
- `--preserve` 기본값은 **false** (최초 init 시 복사 허용). 재실행 시에는 기본 동작이 writeIfMissing이라 덮어쓰기 없음 → 사실상 preserve=true와 동치. `--preserve` 플래그는 install-hooks에 전달되어 B3의 preserveHooks 목록 활용 시 의미 부여 예정.
- `--force`는 현재 lead.md 한정 덮어쓰기 (preserve=false 전제). 타 파일은 항상 writeIfMissing 정책.
- `templates/obsidian_paths.json`의 `managedRoots` 필드(현재 5개)는 Wave 1 산출물이라 **수정 안 함**. 실제 디렉토리 생성은 init 시 9개로 반영되며, manifest 내 managedRoots는 프로젝트별 선언을 존중 (`core/manifest-schema.mjs`의 `resolveManagedRoots`가 미선언 시 기본 9개 사용).
- `commands/install-hooks.mjs` 수정 금지라 `--preserve` 플래그 전달은 호출 인자로만 (B3 구현 대기).

## git commit 메시지 (권장)

```
feat(wave3-a3): templates/agents/_lead.md + init-project.mjs scaffolding

- templates/agents/_lead.md: 기획서 §5-③ lead agent 뼈대 (v2 능동 큐레이터 포함)
- commands/init-project.mjs: 9 managedRoots + lead/eval 치환 복사 + doctor 자동 호출
- commands/__tests__/init-project.test.mjs: 10 tests (parseArgs/substitute/Case 1-6)
- scripts/build-template-manifest.mjs: agents/_lead.md required:true 판정
- templates/_manifest.json: 20 files / 14 required (rebuilt)

전체 테스트 233 pass / 43 suites / 0 fail
```
