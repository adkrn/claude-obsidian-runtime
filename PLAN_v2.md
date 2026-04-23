# Plan v2: Claude-Obsidian Runtime 로컬 npm 패키지화

군사 레드팀 피드백 반영한 최종 계획.

## v1 → v2 변경 요약

| 항목 | v1 | v2 |
|------|----|----|
| Steps | 7개 | 10개 (Step 0, 0.5 신설) |
| 설치 방식 | `file:../claude-obsidian-runtime` | `$CLAUDE_RUNTIME_HOME` 환경변수 |
| 검증 | smoke test 수동 | `doctor --full` 자동 체크리스트 |
| 마이그레이션 순서 | Talkup/talkSim 직접 | talkSim → Talkup_test1 → Talkup 본체 |
| install-hooks 정책 | 불명확 | merge/overwrite/preserve-list 3모드 |
| 롤백 | 없음 | Step 0.5 롤백 게이트 |
| 소요 | 3일 | 7일 (관찰 3주) |

## 핵심 설계 결정

### 1. 설치 방식: `$CLAUDE_RUNTIME_HOME` 환경변수

```bash
# 1회 머신 setup
export CLAUDE_RUNTIME_HOME="C:/JSProj/claude-obsidian-runtime"

# 새 프로젝트
cd C:/JSProj/myNewProject
npx --prefix "$CLAUDE_RUNTIME_HOME" claude-obsidian-runtime init \
  --project-id myproj \
  --vault-root C:/Obsidian/myproj
```

**이유**:
- 드라이브/한글/공백 경로 일괄 해결
- worktree 호환
- symlink 이슈 회피
- `git pull`로 즉시 업그레이드

### 2. hook shell wrapper (fallback 포함)

```bash
#!/bin/bash
set -euo pipefail
if [ -n "${CLAUDE_RUNTIME_HOME:-}" ] && [ -d "$CLAUDE_RUNTIME_HOME" ]; then
  node "$CLAUDE_RUNTIME_HOME/commands/session-start.mjs" --session-id "${CLAUDE_SESSION_ID:-}"
else
  # Legacy fallback (2주 유예)
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  node "$SCRIPT_DIR/../../scripts/runtime/runtime-session-start.mjs" --session-id "${CLAUDE_SESSION_ID:-}" 2>/dev/null || true
fi
```

### 3. 마이그레이션 순서 (격리 검증)

```
Step 6: talkSim 선행 (중요도 상대적 낮음) + 1주 관찰
   ↓
Step 7: Talkup_test1 워크트리 (Talkup 본체 영향 없음)
   ↓
Step 8: Talkup 본체 (검증 완료 후 설치만)
```

## 10 Steps

| Step | 이름 | 소요 | AC 수 |
|------|------|------|-------|
| 0 | 기능 동등성 매트릭스 확정 | 0.5일 | 3 |
| 0.5 | 롤백 게이트 | 0.5일 | 3 |
| 1 | 패키지 구조 리팩터링 | 1.5일 | 3 |
| 2 | CLI 통합 (bin/cli.mjs) | 1일 | 4 |
| 3 | Templates + shell wrapper | 0.5일 | 3 |
| 4 | shared에 10개 승격 | 1일 | 2 |
| 5 | doctor --full 자동화 | 1일 | 3 |
| 6 | talkSim 선행 마이그레이션 | 0.5일 + 1주 관찰 | 3 |
| 7 | Talkup_test1 워크트리 검증 | 0.5일 | 3 |
| 8 | Talkup 본체 마이그레이션 | 0.5일 + 2주 관찰 | 5 |
| 9 | 문서화 & 승격 | 0.5일 | 3 |

**개발 합계: 7일 / 관찰 포함: 약 3주**

## Step 0 산출물 (완료)

- [MIGRATION_MATRIX.md](./MIGRATION_MATRIX.md) — 26개 항목 분류 + 승격 10개 + local 1개 + 보존 hook 8개

## Step 0.5 체크리스트

Talkup, talkSim 양쪽에서 실행:

```bash
# git tag
cd C:/JSProj/Talkup && git tag runtime-pre-npm-migration
cd C:/JSProj/talkSim && git tag runtime-pre-npm-migration

# hooks 백업
cp -r C:/JSProj/Talkup/.claude/hooks C:/JSProj/Talkup/.claude/hooks.backup
cp -r C:/JSProj/Talkup/scripts/runtime C:/JSProj/Talkup/scripts/runtime.backup
cp -r C:/JSProj/talkSim/.claude/hooks C:/JSProj/talkSim/.claude/hooks.backup
cp -r C:/JSProj/talkSim/.claude/runtime/scripts C:/JSProj/talkSim/.claude/runtime/scripts.backup

# 롤백 스크립트 작성
# C:/JSProj/Talkup/scripts/rollback-runtime.sh
# C:/JSProj/talkSim/scripts/rollback-runtime.sh
```

## 리스크 테이블

| 리스크 | 대응 | Step |
|--------|------|------|
| hook 교체 직후 터짐 | fallback shim 2주 유예 + 롤백 스크립트 | 0.5, 3 |
| Talkup 고유 hook 덮어씌워짐 | install-hooks --preserve 필수 목록 | 2, 8 |
| `CLAUDE_RUNTIME_HOME` 미설정 | fallback shim + doctor 경고 | 3, 5 |
| 기능 누락 | doctor --full 9체크 자동화 | 5 |
| 양쪽 프로젝트 결과 다름 | Step 0 버전 일원화 + 6,7 격리 검증 | 0, 6, 7 |
| Talkup_test1 워크트리 경로 | 환경변수 기반이라 영향 없음 | 3 |
| openai-docs-staleness 이식 실패 | 프로젝트 로컬 유지 결정 | 0 |
| 2주 후 legacy 제거 시 터짐 | archive/에 보관, 3개월 후 삭제 | 8 |

## 다음 단계

Step 0 완료 → Step 0.5 (롤백 게이트) 시작 가능.

Step 0.5는 hook 실행 경로를 건드리지 않고 git tag와 백업 폴더만 만드는 작업이라 리스크 0.

---

**작성일**: 2026-04-20
**Task**: 20260420-1651-task-8b7eda60
**상태**: Step 0 완료, Step 0.5 대기 중
