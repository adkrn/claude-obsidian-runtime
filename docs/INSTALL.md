# 설치 가이드 (Install Guide)

claude-obsidian-runtime v3.0.0 — Claude Code와 Obsidian을 연동해 프로젝트별 장기기억·학습축적·자동 문서화를 제공하는 공유 런타임.

이 가이드는 **처음 쓰는 사람**이 0부터 첫 프로젝트를 설치할 때까지 따라할 수 있게 작성했어.

---

## 1. 사전 요구사항

| 항목 | 최소 버전 | 확인 명령 |
|------|----------|----------|
| Node.js | 20 이상 | `node --version` |
| git | 2.40 이상 | `git --version` |
| bash | 설치되어있어야 함 (Windows는 Git Bash / WSL) | `bash --version` |
| Obsidian | 선택 (볼트 실사용 시 필요) | 앱 설치 |

**권장**:
- Claude Code v2.1.32+ (agent-teams 기능과 무관. 표준 hook만 사용)
- tmux (선택)

---

## 2. 패키지 설치 (1회만 수행)

### 2-A. 패키지 저장소 clone

런타임 자체는 "공유 알고리즘 저장소"야. 한 곳에 clone해두고 여러 프로젝트가 참조하는 구조.

```bash
# 원하는 위치에 clone
cd C:/JSProj    # 또는 ~/projects 등 당신이 개발 저장소 두는 곳
git clone <이 저장소 URL> claude-obsidian-runtime
cd claude-obsidian-runtime
```

**버전 확인**:
```bash
node bin/cli.mjs version
# → 3.0.0
```

### 2-B. 환경 변수 설정

**핵심 환경 변수 `CLAUDE_RUNTIME_HOME`** — 모든 관리 대상 프로젝트의 hook이 이 경로를 참조해 런타임 엔진을 실행함. 반드시 **절대 경로**여야 함.

**bash (Git Bash / WSL / macOS / Linux)**:
```bash
# ~/.bashrc 또는 ~/.zshrc에 추가
export CLAUDE_RUNTIME_HOME="C:/JSProj/claude-obsidian-runtime"

# 즉시 반영
source ~/.bashrc
```

**PowerShell (Windows)**:
```powershell
# 영구 설정 (사용자 레벨)
[System.Environment]::SetEnvironmentVariable(
  'CLAUDE_RUNTIME_HOME',
  'C:/JSProj/claude-obsidian-runtime',
  'User'
)

# 현재 세션 즉시 반영
$env:CLAUDE_RUNTIME_HOME = "C:/JSProj/claude-obsidian-runtime"
```

**확인**:
```bash
echo $CLAUDE_RUNTIME_HOME
# → C:/JSProj/claude-obsidian-runtime
```

### 2-C. (선택) 전역 CLI 연결

`npm link`로 전역 명령어 `claude-obsidian-runtime` 또는 `claude-runtime` 활성화.

```bash
cd $CLAUDE_RUNTIME_HOME
npm link
```

이후 아무 디렉토리에서나:
```bash
claude-runtime version
# → 3.0.0
```

**스킵 가능**: 대신 `node $CLAUDE_RUNTIME_HOME/bin/cli.mjs <subcommand>` 형식으로 직접 호출해도 동일하게 동작.

---

## 3. 내부 검증 (건강 체크)

패키지 자체가 정상 상태인지 확인.

```bash
cd $CLAUDE_RUNTIME_HOME
node --test commands/__tests__/*.test.mjs core/__tests__/*.test.mjs core/memory/__tests__/*.test.mjs core/eval/__tests__/*.test.mjs scripts/__tests__/*.test.mjs
```

**기대 출력** (마지막 부분):
```
ℹ tests 264
ℹ pass 264
ℹ fail 0
```

실패 있으면 설치 불완전. `git status`로 저장소 상태 확인 + 재 clone.

---

## 4. 첫 프로젝트 설치

### 4-A. 대상 프로젝트 준비

관리 받고 싶은 프로젝트 디렉토리로 이동. 아래 둘 중 아무 거나 괜찮아:
- 이미 존재하는 프로젝트 (git 저장소여도 되고 아니어도 됨)
- 빈 디렉토리 (신규 시작)

```bash
cd C:/JSProj/myProject    # 당신의 프로젝트
```

### 4-B. Obsidian 볼트 경로 결정

프로젝트별로 **별도 볼트**를 써야 지식이 섞이지 않아. 권장 경로 패턴:

| OS | 권장 볼트 경로 |
|----|---------------|
| Windows | `C:/Obsidian/<projectId>` |
| macOS / Linux | `~/Obsidian/<projectId>` |

Obsidian 앱에서 이 경로를 "볼트 열기"로 추가하면 시각적 편집 가능.

### 4-C. init 실행

```bash
claude-runtime init \
  --project-id myproject \
  --vault-root C:/Obsidian/myproject
```

**CLI 옵션**:
| 옵션 | 설명 |
|------|------|
| `--project-id <id>` | **필수**. 프로젝트 식별자. 소문자 + 숫자 + 하이픈 권장 (예: `talksim`, `poeact`) |
| `--vault-root <path>` | **필수**. Obsidian 볼트 절대 경로 |
| `--project-dir <path>` | 선택. 프로젝트 루트 (기본: cwd) |
| `--preserve` | 선택. 기존 파일 덮어쓰지 않음 (재설치 시 유용) |
| `--no-doctor` | 선택. init 직후 자동 doctor 호출 skip (CI용) |
| `--force` | 선택. `<projectId>-lead.md` 있어도 덮어씀 |
| `--skip-hooks` | 선택. install-hooks 호출 skip |

### 4-D. init이 생성하는 것 (실제 파일 목록)

**프로젝트 측 (`<projectDir>/.claude/`)**:
- `.claude/runtime-manifest.json` — 프로젝트 매니페스트 (6축 + 확장 4축)
- `.claude/agents/<projectId>-lead.md` — 총괄 에이전트 (`{{PROJECT_ID}}` 치환됨)
- `.claude/commands/*.md` — slash 커맨드 템플릿 (task-start, task-close 등)
- `.claude/hooks/*.sh` — 6 core shell wrapper (install-hooks가 생성)
- `.claude/settings.json` — hook 등록 (install-hooks가 패치)
- `.claude/runtime-version.json` — 설치된 런타임 버전 기록
- `.claude/runtime/` 아래 7 subdir: `tasks/ events/ retrieval/ code-index/ knowledge/ architecture/ eval/`

**프로젝트 측 (`<projectDir>/document/obsidian_context/_meta/`)**:
- `obsidian_paths.json` — 볼트 경로 설정 (vaultRoot, managedRoots, indexTargets 등)
- `context_routes.json` — UserPromptSubmit 시 추천 문서 라우트

**볼트 측 (`<vaultRoot>/`)** — 9 managed roots + subdirs:
```
00_Home/
  <projectId>_Index.md
  Current_Focus.md
  Reading_Order.md
04_Architecture/
  Drafts/
  Generated/
06_Troubleshooting/
  Drafts/
07_Decisions/
  Drafts/
08_Lessons/
  Drafts/
08_Reflections/       # Reflexion 메모리
  Drafts/
09_Templates/
09_Templates/Procedures/    # 절차 학습 (Memp)
10_Worklogs/
  Auto/
```

### 4-E. init 완료 후 실제 출력 예시

```
claude-obsidian-runtime init
  Project ID:   myproject
  Project dir:  /path/to/myProject
  Vault root:   C:/Obsidian/myproject

  [vault] 9 managed roots ready
  [runtime] 7 subdirs ready
  [lead] /path/to/myProject/.claude/agents/myproject-lead.md
  [eval] /path/to/myProject/.claude/runtime/eval/golden-tasks.json

  [hooks] Running install-hooks...
[install-hooks] Installed 6 shell scripts: runtime-session-start.sh, runtime-prompt-context.sh, runtime-subagent-start.sh, runtime-stop.sh, runtime-session-end.sh, runtime-post-edit.sh
[install-hooks] settings.json patched: true
[install-hooks] runtime-version.json written: true

Initialized project: myproject
  Created: N file(s)
  Skipped (already exist): 0 file(s)

  [doctor] Running doctor --full --since-init...
claude-obsidian-runtime doctor
Package:     v3.0.0
Project:     /path/to/myProject
Mode:        full (--since-init)

[OK]    C01  CLAUDE_RUNTIME_HOME                    Set
[OK]    C02  runtime-manifest.json (6-axis)         6/6 axes valid
...
Summary: 12 pass, 0 warn, 0 fail

  [doctor] exit code 0

Next steps:
  1. export CLAUDE_RUNTIME_HOME="..."
  2. Edit .claude/runtime-manifest.json to set defaultScope, surfacePatterns
  3. Edit document/obsidian_context/_meta/obsidian_paths.json to add indexTargets, scanRoots
  4. Run: claude-obsidian-runtime sync
```

### 4-F. init 후 필수 편집 2개

init은 **뼈대**만 생성해. 아래 2개 파일을 프로젝트 실정에 맞게 편집해야 코드 탐색·인덱싱이 정상 동작.

#### (1) `.claude/runtime-manifest.json`

생성된 파일 예:
```json
{
  "runtimeVersion": "3.0.0",
  "projectTag": "myproject",
  "defaultScope": "repo",
  "coreHooks": "all",
  "useRuntimeHome": true,
  "legacyScriptsRelativePath": null,
  "surfacePatterns": [],
  "scopeFolderMap": {},
  "preserveHooks": [],
  "sessionEndPipeline": ["all"]
}
```

**반드시 채울 것**:
- `defaultScope`: 기본 스코프 이름 (예: `backend`, `frontend`, `repo`)
- `surfacePatterns`: public surface 감지 글롭 배열 (예: `["backend/src/routes/**", "frontend/src/app/**"]`)
- `scopeFolderMap`: 스코프 → 폴더 매핑 (예: `{"backend": ["backend/src"], "frontend": ["frontend/src"]}`)

**선택**:
- `preserveHooks`: 프로젝트 고유 hook 파일명 배열 (install-hooks 재실행 시 보존됨)
- `retrievalWeights`, `memoryLayers`: 고급 설정 (기본값 사용 권장)

#### (2) `document/obsidian_context/_meta/obsidian_paths.json`

생성된 파일 예:
```json
{
  "vaultRoot": "C:/Obsidian/myproject",
  "managedRoots": [],
  "mirrorExcludeRoots": [],
  "mcpRoots": [],
  "indexTargets": [],
  "scanRoots": []
}
```

**편집 포인트**:
- `indexTargets`: 코드 인덱스 빌드 대상 (예: `["backend/src", "frontend/src"]`)
- `scanRoots`: 추가 스캔 루트 (코드 외 설정 파일 위치 등)

**채운 후**:
```bash
claude-runtime sync       # 볼트 ↔ mirror 동기화
node $CLAUDE_RUNTIME_HOME/commands/memory-refresh.mjs --project-dir "$PWD"
```

---

## 5. 설치 검증

### 5-A. doctor 전체 체크

```bash
claude-runtime doctor --full --project-dir "$PWD"
```

**기대**: 12체크 전부 `[OK]`. `[FAIL]` 있으면 메시지의 `->` 조치 따라 수정.

**체크 12개 요약**:
| ID | 이름 | 실패 시 조치 |
|----|------|------------|
| C01 | CLAUDE_RUNTIME_HOME | 환경변수 재설정 |
| C02 | manifest 6축 | `runtime-manifest.json` 편집 |
| C03 | obsidian_paths | `vaultRoot` reachable 확인 |
| C04 | managed roots | init 재실행 or 수동 `mkdir` |
| C05 | hook wrappers | `install-hooks --force` |
| C06 | lead agent | init 재실행 |
| C07 | code-index | `memory-refresh` |
| C08 | knowledge-index | `memory-refresh` |
| C09 | task-start dry-run | `task-start.mjs` 파일 존재 + 9필드 JSON 출력 확인 |
| C10 | Prerequisites | Node/git 버전 업그레이드 |
| C11 | template integrity | 패키지 재 clone |
| C12 | performance | `memory-refresh` 재실행 |

### 5-B. JSON 모드 (스크립트 연동)

```bash
claude-runtime doctor --full --json > doctor-report.json
cat doctor-report.json | node -e "const j=JSON.parse(require('fs').readFileSync(0));console.log(j.counts)"
# → { pass: 12, warn: 0, fail: 0 }
```

### 5-C. 평가 프레임 동작 확인 (선택)

```bash
claude-runtime doctor --full --eval --project-dir "$PWD"
# 12/12 PASS 시 자동으로 eval-run 실행 + REPORT=<path> 출력
```

---

## 6. 재설치 / 업그레이드

### 패키지 저장소 업데이트
```bash
cd $CLAUDE_RUNTIME_HOME
git pull
node --test commands/__tests__/*.test.mjs ... # 재검증
```
모든 프로젝트가 자동으로 최신 엔진 사용. 프로젝트 측 변경 불필요.

### 프로젝트 hook만 갱신
```bash
cd <projectDir>
claude-runtime install-hooks --project-dir "$PWD" --force
```
`--preserve` 목록 파일은 덮어쓰지 않음.

### 전체 재 init (파일 보존 모드)
```bash
claude-runtime init --project-id <id> --vault-root <path> --preserve
```
기존 파일 전부 보존. 누락된 것만 추가.

---

## 7. 제거

### 프로젝트 측
```bash
cd <projectDir>
claude-runtime rollback --project-dir "$PWD"
# 또는 수동:
rm -rf .claude/ document/obsidian_context/_meta/
```

### 패키지 측 (완전 제거)
```bash
npm unlink claude-obsidian-runtime   # 전역 링크 해제 (했을 때만)
rm -rf $CLAUDE_RUNTIME_HOME
# 환경 변수 삭제
```

---

## 8. 트러블슈팅

### "CLAUDE_RUNTIME_HOME not set"
→ 섹션 2-B 환경 변수 재설정. 새 터미널에서 `echo $CLAUDE_RUNTIME_HOME` 확인.

### "Cannot find module 'commands/...'"
→ 패키지 저장소 불완전. `cd $CLAUDE_RUNTIME_HOME && git pull`.

### Windows 경로 backslash 에러
→ 모든 경로를 **forward slash**로 지정 (`C:/Obsidian/...`).

### init 후 hook이 Claude Code에 안 잡힘
→ Claude Code 세션 재시작 필요. 또는 `.claude/settings.json` 수동 확인.

### 볼트 권한 에러 (Permission denied)
→ `chmod -R u+w <vaultRoot>` (Linux/macOS) 또는 Windows 속성에서 읽기전용 해제.

---

## 다음 단계

설치 끝났으면 [시작 가이드](./QUICKSTART.md)로 가서 첫 task 실행.
