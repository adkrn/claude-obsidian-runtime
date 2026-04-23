# Claude-Obsidian Runtime Migration Matrix

이 문서는 npm 로컬 패키지 전환 시 각 기능의 이식 계획을 정의한다.
Step 0의 산출물이며 Step 1~9의 기준이 된다.

## 핵심 분류 원칙 (코드 vs 데이터)

**shared로 가는 것**: 실행 로직 (알고리즘) 만
**프로젝트 로컬로 남는 것**: 모든 데이터 + 프로젝트 설정 + 프로젝트 고유 코드

| | 공통 (shared) | 고유 (project-local) |
|--|--------------|----------------------|
| **코드 (로직)** | `core/*.mjs`, `commands/*.mjs` (알고리즘) | `scripts/runtime/openai-docs-staleness.mjs` (Talkup 특수) |
| **데이터 (기록)** | ❌ 없음 | Obsidian 볼트 전체, `.claude/runtime/` 상태, 인덱스 JSONL |
| **설정** | `templates/` (빈 뼈대만) | `runtime-manifest.json`, `obsidian_paths.json`, `context_routes.json` |
| **hook** | 공용 hook shell wrapper 템플릿 | `error-detector.sh` 등 프로젝트 고유 hook |

## 프로젝트 단위로 관리되어야 하는 것 (레드라인)

**절대 shared 안 됨:**

| 항목 | 위치 | 이유 |
|------|------|------|
| 옵시디언 볼트 전체 | `C:/Obsidian/<ProjectId>/` | 프로젝트별 지식 도메인 완전 분리 |
| `03_Prompt_System/` | 볼트 내 (Talkup만) | 프로젝트별 프롬프트 정책 |
| `04_Architecture/*.md` | 볼트 내 | 프로젝트 고유 구조 |
| `06_Troubleshooting/*.md` | 볼트 내 | 프로젝트별 트러블슈팅 |
| `07_Decisions/*.md` | 볼트 내 | 프로젝트별 결정 기록 |
| `08_Lessons/*.md` | 볼트 내 | Talkup 교훈 ≠ talkSim 교훈 |
| `09_Templates/*.md` | 볼트 내 | 프로젝트별 문서 템플릿 |
| `10_Worklogs/*.md` | 볼트 내 | 세션 기록은 그 프로젝트 것 |
| `document/obsidian_context/` | 프로젝트 내 | 볼트 미러본 (읽기 전용 복사본) |
| `.claude/runtime/knowledge/*.jsonl` | 프로젝트 내 | 프로젝트별 지식 인덱스 |
| `.claude/runtime/code-index/*.jsonl` | 프로젝트 내 | 프로젝트별 코드 스캔 결과 |
| `.claude/runtime/current-task.json` | 프로젝트 내 | 현재 작업 상태 |
| `.claude/runtime/tasks/*.json` | 프로젝트 내 | 과거 작업 기록 |
| `.claude/runtime/events/*.jsonl` | 프로젝트 내 | 이벤트 로그 |
| `.claude/runtime/retrieval/*.json` | 프로젝트 내 | 마지막 컨텍스트 스냅샷 |
| `.claude/runtime/architecture/` | 프로젝트 내 | 아키텍처 후보 |
| `.claude/runtime-manifest.json` | 프로젝트 내 | projectTag, defaultScope, surfacePatterns |
| `.claude/settings.json` | 프로젝트 내 | hook 등록 + 프로젝트 고유 hook |
| `.claude/hooks/*.sh` (고유) | 프로젝트 내 | error-detector, migration-detector 등 |
| `.claude/commands/*.md` (고유) | 프로젝트 내 | 프로젝트 특수 slash 커맨드 |
| `.claude/rules/*.md` | 프로젝트 내 | rule-migrations, rule-security 등 |
| `.claude/skills/*` | 프로젝트 내 | 프로젝트 고유 skill |
| `document/obsidian_context/_meta/*.json` | 프로젝트 내 | 볼트 경로, managedRoots, indexTargets |
| CLAUDE.md (root, backend, frontend) | 프로젝트 내 | 프로젝트 가이드 |
| `document/troubleshooting/` | 프로젝트 내 | 프로젝트 트러블슈팅 인덱스 |
| `document/migrations/` | 프로젝트 내 | DB 마이그레이션 기록 |
| `scripts/runtime/openai-docs-staleness.mjs` | Talkup 내 | Talkup 전용 기능 |

## 공유(shared)되는 것 (화이트리스트)

**오직 "어떻게 동작하는가"의 알고리즘만:**

### `core/` (라이브러리, import-only)

- `runtime-lib.mjs` — 공통 유틸 (task id, path 처리, JSONL I/O)
- `obsidian-config.mjs` — 설정 로더
- `obsidian-sync.mjs` — 볼트 동기화 알고리즘
- `context-resolver.mjs` — read_first/code_hits/knowledge_hits 계산
- `task-start-engine.mjs` — task 생성 로직
- `session-end-engine.mjs` — 세션 종료 curation 로직
- `code-index-build.mjs` — 코드 인덱스 알고리즘
- `learning-capture.mjs` — 이벤트 기록
- `learning-curate.mjs` — 교훈 초안 생성
- `architecture-utils.mjs` — 아키텍처 후보 계산
- `utils.mjs`

### `commands/` (hook이 호출하는 CLI)

20개 CLI 실행 스크립트. 각 프로젝트의 hook `.sh`가 `$CLAUDE_RUNTIME_HOME/commands/*.mjs`를 호출.

### `templates/` (빈 뼈대만)

- `runtime-manifest.json` — 빈 매니페스트 (프로젝트가 채움)
- `obsidian_paths.json` — 빈 경로 설정
- `context_routes.json` — 빈 라우팅
- `hooks/*.sh` — shell wrapper (로직 없음, 경로만)
- `commands/*.md` — slash 커맨드 정의
- `vault/00_Home/{{PROJECT_ID}}_Index.md` — 빈 인덱스
- `vault/00_Home/Current_Focus.md` — 빈 focus
- `vault/00_Home/Reading_Order.md` — 빈 reading order

템플릿은 `init` 시 1회 복사 후 **프로젝트 소유**. 업그레이드 시 덮어쓰지 않음.

## 범례

- shared: `claude-obsidian-runtime/` 패키지에 유지/승격 (코드만)
- local: 프로젝트 로컬에만 유지 (프로젝트 특수 기능)
- deprecated: 제거 대상
- 승격: shared에 신규 추가 필요

## 전체 매트릭스 (26개 항목)

| # | 기능 | Talkup 파일 | talkSim 파일 | shared 현황 | 대상 | 선택 소스 | 비고 |
|---|------|-------------|--------------|-------------|------|-----------|------|
| 1 | runtime-lib | scripts/runtime/runtime-lib.mjs (re-export) | .claude/runtime/scripts/runtime-lib.mjs (re-export) | ✅ runtime-lib.mjs | shared | 기존 유지 | core/ 이동 |
| 2 | utils | - | - | ✅ utils.mjs | shared | 기존 유지 | core/ 이동 |
| 3 | obsidian-config | .claude/hooks/obsidian-config.mjs | .claude/runtime/scripts/obsidian-config.mjs | ✅ obsidian-config.mjs | shared | 기존 유지 | core/ 이동 |
| 4 | obsidian-sync | scripts/obsidian-context-sync.mjs | .claude/runtime/scripts/obsidian-sync.mjs | ✅ obsidian-sync.mjs | shared | talkSim | 이름 통일 |
| 5 | task-start (엔진) | - | - | ✅ task-start.mjs | shared | 기존 유지 | core/task-start-engine.mjs로 개명 |
| 6 | task-start (CLI) | scripts/runtime/task-start.mjs | .claude/runtime/scripts/task-start.mjs | ❌ | 승격 | talkSim (더 간결) | commands/task-start.mjs |
| 7 | session-start | scripts/runtime/runtime-session-start.mjs | .claude/runtime/scripts/session-start.mjs | ❌ | 승격 | talkSim | commands/session-start.mjs |
| 8 | session-end | scripts/runtime/runtime-session-end.mjs | .claude/runtime/scripts/session-end.mjs | ✅ session-end.mjs (엔진) | 승격 | talkSim | commands/session-end.mjs, core/session-end-engine.mjs |
| 9 | stop | scripts/runtime/runtime-stop.mjs | .claude/runtime/scripts/stop.mjs | ❌ | 승격 | talkSim | commands/stop.mjs |
| 10 | post-edit | .claude/hooks/runtime-post-edit.mjs | .claude/runtime/scripts/post-edit.mjs | ❌ | 승격 | talkSim | commands/post-edit.mjs |
| 11 | prompt-context | scripts/runtime/runtime-prompt-context.mjs | .claude/runtime/scripts/prompt-context.mjs | ❌ | 승격 | talkSim | commands/prompt-context.mjs |
| 12 | subagent-start | scripts/runtime/runtime-subagent-start.mjs | .claude/runtime/scripts/subagent-start.mjs | ❌ | 승격 | talkSim | commands/subagent-start.mjs |
| 13 | context-resolver | scripts/runtime/context-resolver.mjs | .claude/runtime/scripts/context-resolver.mjs | ✅ context-resolver.mjs | shared | 기존 유지 | core/ 이동 |
| 14 | code-index-build | scripts/runtime/code-index-build.mjs (re-export) | .claude/runtime/scripts/code-index.mjs | ✅ code-index-build.mjs | shared | 기존 유지 | core/ 이동, commands/code-index-build.mjs 추가 |
| 15 | code-index-query | scripts/runtime/code-index-query.mjs | ❌ | ❌ | 승격 | Talkup | commands/code-index-query.mjs |
| 16 | knowledge-index-build | scripts/runtime/knowledge-index-build.mjs | ❌ (context-resolver 내장) | ❌ | 승격 | Talkup | commands/knowledge-index-build.mjs |
| 17 | learning-capture | scripts/runtime/learning-capture.mjs (re-export) | .claude/runtime/scripts 내 post-edit이 호출 | ✅ learning-capture.mjs | shared | 기존 유지 | core/ 이동 |
| 18 | learning-curate | scripts/runtime/learning-curate.mjs (re-export) | session-end 내 호출 | ✅ learning-curate.mjs | shared | 기존 유지 | core/ 이동 |
| 19 | architecture-utils | - | - | ✅ architecture-utils.mjs | shared | 기존 유지 | core/ 이동 |
| 20 | architecture-detect | scripts/runtime/architecture-detect.mjs | session-end 내 호출 | ✅ architecture-utils 일부 | 승격 | Talkup | commands/architecture-detect.mjs |
| 21 | architecture-publish | scripts/runtime/architecture-publish.mjs | session-end 내 호출 | ✅ architecture-utils 일부 | 승격 | Talkup | commands/architecture-publish.mjs |
| 22 | architecture-promote | scripts/runtime/architecture-promote.mjs | ❌ | ✅ architecture-utils 일부 | 승격 | Talkup | commands/architecture-promote.mjs |
| 23 | worklog-generate | scripts/runtime/worklog-generate.mjs | .claude/runtime/scripts/worklog-generate.mjs | ❌ (session-end 내부) | 승격 | talkSim | commands/worklog-generate.mjs + core/ 분리 |
| 24 | lesson-promote | scripts/runtime/lesson-promote.mjs | ❌ | ❌ | 승격 | Talkup | commands/lesson-promote.mjs |
| 25 | memory-refresh | scripts/runtime/memory-refresh.mjs | ❌ | ❌ | 승격 | Talkup | commands/memory-refresh.mjs |
| 26 | task-usage | scripts/runtime/task-usage.mjs | .claude/runtime/scripts/task-usage.mjs | ❌ | 승격 | 병합 (두 버전 비교) | commands/task-usage.mjs |
| 27 | openai-docs-staleness | scripts/runtime/openai-docs-staleness.mjs | ❌ | ❌ | **local** | Talkup 유지 | Talkup 특수 기능 (외부 문서 staleness check) |

## 승격 목록 (10개)

Step 4에서 shared로 추가할 파일:

1. `commands/session-start.mjs` (talkSim 소스 기반)
2. `commands/stop.mjs` (talkSim 소스 기반)
3. `commands/post-edit.mjs` (talkSim 소스 기반)
4. `commands/prompt-context.mjs` (talkSim 소스 기반)
5. `commands/subagent-start.mjs` (talkSim 소스 기반)
6. `commands/code-index-query.mjs` (Talkup 소스 기반)
7. `commands/knowledge-index-build.mjs` (Talkup 소스 기반)
8. `commands/lesson-promote.mjs` (Talkup 소스 기반)
9. `commands/memory-refresh.mjs` (Talkup 소스 기반)
10. `commands/task-usage.mjs` (두 소스 병합 후 검증)

## 명명 통일 규칙

| Before (Talkup) | Before (talkSim) | After (shared) |
|-----------------|------------------|----------------|
| runtime-session-start.mjs | session-start.mjs | **commands/session-start.mjs** |
| runtime-session-end.mjs | session-end.mjs | **commands/session-end.mjs** |
| runtime-stop.mjs | stop.mjs | **commands/stop.mjs** |
| runtime-post-edit.mjs | post-edit.mjs | **commands/post-edit.mjs** |
| runtime-prompt-context.mjs | prompt-context.mjs | **commands/prompt-context.mjs** |
| runtime-subagent-start.mjs | subagent-start.mjs | **commands/subagent-start.mjs** |
| code-index-build.mjs | code-index.mjs | **commands/code-index-build.mjs** |
| obsidian-context-sync.mjs | obsidian-sync.mjs | **commands/obsidian-sync.mjs** |

원칙: talkSim의 짧은 이름을 표준으로, `runtime-` 접두어 제거.

## 프로젝트 로컬 유지 (1개)

### Talkup 로컬

- `openai-docs-staleness.mjs` — OpenAI 외부 문서 staleness 체크는 Talkup의 프롬프트 엔지니어링 맥락에 특화. 타 프로젝트에서 사용 가능성 낮음. `scripts/runtime/openai-docs-staleness.mjs`에 유지.

## 보존 대상 hook (install-hooks --preserve 목록)

Talkup의 프로젝트 고유 hook은 install-hooks가 덮어쓰지 않도록 명시:

- `error-detector.sh`
- `error-agent-enforcer.sh`
- `migration-detector.sh`
- `agent-approval-enforcer.sh`
- `commit-reminder.sh`
- `architect-reminder.sh`
- `code-simplifier-detector.sh`
- `troubleshooting-loader.sh`

## 폐기 또는 archive 대상

Step 8 (Talkup 본체 마이그레이션) 완료 후 2주 유예 거쳐 archive 이동:

- `scripts/runtime/*.mjs` 21개 중 openai-docs-staleness.mjs 제외 20개
- `scripts/obsidian-context-sync.mjs` (shared의 obsidian-sync.mjs로 대체)
- `.claude/runtime/scripts/*.mjs` 14개 (talkSim, Step 6 완료 후)

## 마이그레이션 순서 결정 근거

1. **talkSim 먼저** — production 중요도 상대적으로 낮음, 검증장 역할
2. **Talkup_test1** — Talkup과 동일 코드베이스, 워크트리라 Talkup 본체 영향 없음
3. **Talkup 본체 마지막** — 검증 완료된 패키지를 설치만 하므로 리스크 최소

이 순서로 진행하면 "격리 검증 경로"가 성립하며, 군사가 제기한 production 중단 리스크가 실질적으로 제거된다.

## 결정 사항

- 명명 통일: talkSim 쪽 짧은 이름 채택
- 설치 방식: `$CLAUDE_RUNTIME_HOME` 환경변수 기반
- fallback: 2주간 legacy 경로 shim 유지
- 롤백: git tag + .claude.backup/ 필수
- 검증: `doctor --full` 9체크 자동화
- 프로젝트 고유 기능: openai-docs-staleness 로컬 유지, 프로젝트 hook 8개 preserve 목록

---

**작성일**: 2026-04-20
**Task**: 20260420-1651-task-8b7eda60
**관련 계획**: v2 (군사 레드팀 피드백 반영)
