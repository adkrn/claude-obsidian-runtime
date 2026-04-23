# 시작 가이드 (Quick Start)

설치가 끝났다면 이 문서로 시작해. 5분 안에 첫 task 실행 → 자동 추적 → 세션 종료까지 경험할 수 있어.

**전제**: [INSTALL.md](./INSTALL.md)의 섹션 1~5 완료 상태.

---

## 0. 동작 원리 1분 요약

Claude Code 세션에서 당신이 타이핑할 때마다, **4개 훅**이 자동 실행됨:

```
1. 세션 시작    → session-start   ("현재 진행 중 task 있음?" 컨텍스트 주입)
2. 프롬프트 입력 → prompt-context  (관련 문서/코드/교훈 찾아서 주입)
3. 파일 수정   → post-edit       (수정 이벤트 기록)
4. 세션 종료    → session-end     (lesson/worklog/reflection draft 자동 생성)
```

당신은 **아무 버튼도 누르지 않음**. Claude Code 세션 자체가 트리거.

볼트(Obsidian)에는:
- 매 세션마다 `10_Worklogs/Auto/<date>_<taskId>.md`로 handoff
- 의미 있는 변경은 `08_Lessons/Drafts/`에 lesson draft
- 실패 이벤트 발생 시 `08_Reflections/Drafts/`에 reflection draft
- 30일 내 같은 패턴 3회 반복 감지 시 `09_Templates/Procedures/Drafts/`에 procedure 후보

**수동 조작 포인트**:
- slash 커맨드 `/task-start`, `/task-close` (Claude Code UI에서 호출)
- 볼트의 draft 검토 후 정식 문서로 승격
- 가끔 `memory-refresh`, `doctor --full` 수동 실행

---

## 1. 첫 task 시작

### 1-A. Claude Code 세션 열기

관리 중인 프로젝트 디렉토리에서 Claude Code 열기.

```bash
cd <projectDir>
# Claude Code 세션 시작 (VS Code에서 사이드바 / 터미널 `claude` 등)
```

세션 시작 순간 `SessionStart` hook이 자동 실행. 아래와 같은 `additionalContext`가 시스템에 주입됨 (Claude가 내부적으로 봄):

```
[Runtime Session Context]
- session_id: <uuid>
- active_task: (없음 또는 이전 task 정보)
- recent_worklog: 10_Worklogs/Auto/<최근 파일>
```

### 1-B. task 시작 (slash 커맨드)

Claude Code 입력창에:

```
/task-start 결제 모듈 버그 수정
```

또는 수동으로 직접 호출:
```bash
node $CLAUDE_RUNTIME_HOME/commands/task-start.mjs \
  --task "결제 모듈 버그 수정" --project-dir "$PWD"
```

**출력 (stdout 마지막 라인, JSON)**:
```json
{
  "taskId": "20260423-1500-결제-모듈-버그-수정",
  "readFirst": [
    {"path": "00_Home/Current_Focus.md", "why": "current priorities"},
    {"path": "04_Architecture/Payment.md", "why": "payment domain map"}
  ],
  "codeHits": [
    {"path": "backend/src/services/paymentService.js", "scope": "backend", "score": 12}
  ],
  "knowledgeHits": [
    {"id": "lesson-xyz", "kind": "lesson", "title": "결제 실패 재시도 로직..."}
  ],
  "guardrails": ["check payment logs before editing", ...],
  "matchedScopes": ["backend"],
  "matchedGroups": [{"id": "payment", "label": "Payment domain", "score": 5}],
  "currentTaskPath": "...current-task.json",
  "lastContextPath": "...last-context.json"
}
```

Claude는 이 정보를 받아 **먼저 `readFirst` 파일들 Read** → 맥락 파악 후 작업 시작.

### 1-C. 작업 진행

당신이 Claude에게 대화로 지시 → Claude가 파일 Read/Edit/Write → Bash 실행.

**매 도구 호출마다 `PostToolUse` hook 실행**:
- `Edit`/`Write` → `events/<scope>.jsonl`에 `file_modified` 이벤트 append
- `Read` (볼트 `.md` 파일) → `file_read` 이벤트 (60초 dedup)
- `Bash` (예: `npm test`) → `verification_run` 또는 `verification_failed` 이벤트

당신이 따로 기록할 필요 없음. 자동으로 쌓임.

### 1-D. task 종료

```
/task-close
```

또는:
```bash
node $CLAUDE_RUNTIME_HOME/commands/stop.mjs --project-dir "$PWD"
```

세션 종료 훅이 아래 순서로 자동 실행:

1. **이벤트 수집** — 이번 task의 events/*.jsonl 로드
2. **lesson draft 생성** — `08_Lessons/Drafts/<date>_<slug>.md`
3. **reflection draft 생성** (실패 있었으면) — `08_Reflections/Drafts/<date>_<taskId>_reflection.md`
4. **troubleshooting draft 생성** (실패 있었으면) — `06_Troubleshooting/Drafts/<date>_<slug>.md`
5. **architecture 변경 감지** — public surface 변경 있으면 후보 기록
6. **worklog 생성** — `10_Worklogs/Auto/<date>_<taskId>.md` (Handoff 5섹션)
7. **procedural distillation** (배치) — 30일 내 3회 반복 패턴 감지 시 `09_Templates/Procedures/Drafts/`

---

## 2. 30초 E2E 실습

설치 후 실제 동작 확인:

```bash
# 임시 테스트 프로젝트
TMPDIR=$(mktemp -d)
cd $TMPDIR

# init
claude-runtime init --project-id smoketest --vault-root "$TMPDIR/vault" --no-doctor --skip-hooks

# 확인
ls .claude/agents/                       # smoketest-lead.md 존재
ls "$TMPDIR/vault/"                      # 9 managed roots
cat .claude/runtime-manifest.json | head # projectTag: "smoketest"

# task-start dry-run (부수효과 없이 JSON 출력만)
node $CLAUDE_RUNTIME_HOME/commands/task-start.mjs \
  --dry-run --task "smoke test" --project-dir "$PWD" | tail -1 | node -e "
const j=JSON.parse(require('fs').readFileSync(0));
console.log('9필드:', ['taskId','readFirst','codeHits','knowledgeHits','guardrails',
                      'matchedScopes','matchedGroups','currentTaskPath','lastContextPath']
                      .every(k => k in j));
"
# → 9필드: true

# eval-run 실행
cp $CLAUDE_RUNTIME_HOME/templates/eval/golden-tasks.json .claude/runtime/eval/
node $CLAUDE_RUNTIME_HOME/commands/eval-run.mjs \
  --task GOLDEN-01 --project-dir "$PWD" \
  --noRetrieval --noLessonReuse --noPerformance 2>&1 | tail -1
# → REPORT=<...>/eval/reports/<date>_smoketest.json

# 정리
cd .. && rm -rf $TMPDIR
```

---

## 3. 자주 쓰는 커맨드 5개

### 3-A. `doctor` — 건강 체크
```bash
claude-runtime doctor --full
```
12체크 전부. 이상 있으면 `[FAIL]` 표시.

```bash
claude-runtime doctor --full --json       # 기계 판독용
claude-runtime doctor                      # 빠른 6체크 (C01~C06)
```

### 3-B. `sync` — 볼트 동기화
```bash
claude-runtime sync
```
`<vaultRoot>/`의 실제 볼트 ↔ `<projectDir>/document/obsidian_context/` mirror 동기화. Obsidian에서 편집한 내용을 런타임이 읽게 하려면 필요.

### 3-C. `memory-refresh` — 인덱스 재빌드
```bash
node $CLAUDE_RUNTIME_HOME/commands/memory-refresh.mjs --project-dir "$PWD"
```
코드 인덱스 + 지식 인덱스 동시 재생성. 대량 커밋 후 한 번 돌리면 다음 task-start의 추천 정확도 개선.

### 3-D. `task-usage` — 토큰 사용량 집계
```bash
node $CLAUDE_RUNTIME_HOME/commands/task-usage.mjs --project-dir "$PWD"
```
최근 세션의 토큰/시간 통계.

### 3-E. `eval-run` — Golden Task 벤치마크
```bash
node $CLAUDE_RUNTIME_HOME/commands/eval-run.mjs --golden --all --project-dir "$PWD"
```
10개 표준 task로 런타임 성능 측정. 리포트는 `.claude/runtime/eval/reports/<date>_<projectId>.json`.

---

## 4. 볼트 구조 알아두기

### 4-A. 자동 생성되는 곳 (손대지 말 것)
- `10_Worklogs/Auto/` — 매 세션 worklog
- `08_Lessons/Drafts/` — Auto lesson
- `08_Reflections/Drafts/` — 실패 후 반성
- `06_Troubleshooting/*/Drafts/` — 트러블슈팅
- `07_Decisions/Drafts/` — 결정 후보
- `04_Architecture/Generated/` — 자동 감지된 아키텍처 후보
- `09_Templates/Procedures/Drafts/` — 반복 패턴 procedure

### 4-B. 사람이 편집하는 곳
- `00_Home/<projectId>_Index.md` — 볼트 홈. 자유 편집
- `00_Home/Current_Focus.md` — 현재 우선순위 (lead 에이전트가 읽음)
- `00_Home/Reading_Order.md` — 신규 세션 진입 순서
- `04_Architecture/<공식 문서>.md` — draft에서 승격된 정식 문서
- `09_Templates/*.md` (Procedures 제외) — 프로젝트 고유 템플릿

### 4-C. 승격 흐름

```
Auto draft (08_Lessons/Drafts/...)
    ↓ 사람이 검토 + 승격 결정
정식 문서 (08_Lessons/<스코프>/<slug>.md)
    ↓ 다음 task-start에서 knowledge_hits로 추천됨
```

현재 승격은 수동. lead 에이전트가 제안만 함.

---

## 5. 첫 실전 task 체크리스트

- [ ] `doctor --full` 실행 → 12/12 PASS
- [ ] `<projectId>-lead.md` 파일 한 번 읽어보기 (`.claude/agents/`)
- [ ] `00_Home/Current_Focus.md` 3줄로 작성 (지금 무엇에 집중?)
- [ ] `runtime-manifest.json`의 `surfacePatterns`, `scopeFolderMap` 채움
- [ ] `obsidian_paths.json`의 `indexTargets`, `scanRoots` 채움
- [ ] `memory-refresh` 1회 실행
- [ ] Claude Code 세션에서 `/task-start <작업 설명>` 시도
- [ ] 작업 완료 후 `/task-close`
- [ ] `10_Worklogs/Auto/`에 방금 세션의 파일 생성 확인
- [ ] `08_Lessons/Drafts/` 에 lesson 있으면 한 번 열어보기

---

## 6. 안 되는 게 있으면

### A. hook이 안 잡힌다
- Claude Code 세션 완전히 재시작
- `.claude/settings.json`에 `hooks` 섹션 있는지 확인
- `ls .claude/hooks/` 에 `runtime-*.sh` 6개 존재 확인

### B. readFirst 추천이 항상 빈 배열
- `document/obsidian_context/_meta/context_routes.json`의 `groups` 배열이 비어있음
- `00_Home/Current_Focus.md`에 키워드 1~2개 추가 후 재시도

### C. knowledge_hits 추천이 항상 빈 배열
- 아직 lesson draft 1개도 없음 (첫 task 완료 전엔 정상)
- `knowledge/lessons.jsonl` 파일 확인: `cat .claude/runtime/knowledge/lessons.jsonl | wc -l`

### D. Claude가 task-start 결과를 무시하는 듯
- `additionalContext` 전달은 Claude Code 내부 처리. Claude가 받긴 받음
- 단, Claude가 "먼저 readFirst 읽어줘" 같은 지시 없으면 그냥 작업만 함
- `<projectId>-lead.md`의 `## Context loading` 섹션을 Claude에게 명시 지시하는 게 확실

### E. doctor C09 FAIL: "task-start CLI missing"
- `$CLAUDE_RUNTIME_HOME/commands/task-start.mjs` 파일 존재 확인
- `CLAUDE_RUNTIME_HOME` 환경변수 재설정

### F. events/*.jsonl이 안 쌓임
- Claude Code 세션 재시작 (hook 갱신)
- `echo $CLAUDE_PROJECT_DIR` 확인 (Claude Code가 자동 설정)

---

## 다음 단계

동작 원리와 흐름을 더 깊이 알고 싶으면 [흐름 설명](./FLOW.md) 읽어.
