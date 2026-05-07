---
id: lesson-<task-id>
type: lesson
kind: lesson
scope: <scope-id>
title: Lesson - <short title>
summary: <≤180자 1줄 요약>
trigger_keywords:
  - <token1>
  - <token2>
applicable_when:                    # DESIGN_MANUS_F §6-A — 객체 형식
  path_glob:                        # optional. 비어있으면 미평가 (always pass)
    - "src/foo/**"
  trigger_keywords:                 # optional. 비어있으면 미평가
    - "hook"
  scope_id:                         # optional. string 또는 string[]. 비어있으면 미평가
    - "<scope-id>"
confidence: medium                  # high | medium | low
importance: 6                       # 1..10
access_count: 0
last_accessed_at: ""
evolved_at: []
linked_reflection: null
related_task: <task-id>
related_files: []
status: draft                       # draft | active
---

<!-- 본문은 사람 큐레이터가 채움. Draft-first 정책. -->

## 핵심 통찰

<!-- CURATOR_TODO: lesson 의 핵심 한 줄 -->

## 적용 맥락

<!-- CURATOR_TODO: 어떤 상황에서 이 lesson 이 유효한가 -->

## 반대 사례 (anti-pattern)

<!-- CURATOR_TODO: 적용하면 안 되는 경우 -->
