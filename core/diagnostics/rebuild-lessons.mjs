#!/usr/bin/env node
// rebuild-lessons.mjs — 기존 lessons.jsonl 을 새 extractor 로 재추출.
// 사용: node rebuild-lessons.mjs <projectRuntimeDir> [--dry-run]
//
// 동작:
//   1. tasks/*.json 전체 읽음
//   2. 각 task 마다 extractLessonContent 호출
//   3. 새 lesson row 만들어 lessons.jsonl 덮어쓰기 (백업 .bak 생성)
//   4. 변화 통계 출력

import fs from 'node:fs';
import path from 'node:path';
import { extractLessonContent } from '../memory/lesson-extractor.mjs';

const args = process.argv.slice(2);
const runtimeDir = args.find((a) => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');

if (!runtimeDir || !fs.existsSync(runtimeDir)) {
  console.error('usage: rebuild-lessons.mjs <projectRuntimeDir> [--dry-run]');
  process.exit(2);
}

const tasksDir = path.join(runtimeDir, 'tasks');
const lessonsPath = path.join(runtimeDir, 'knowledge', 'lessons.jsonl');

function loadJsonl(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

const existingLessons = loadJsonl(lessonsPath);
const existingById = new Map(existingLessons.map((l) => [l.id, l]));

const taskFiles = fs.existsSync(tasksDir)
  ? fs.readdirSync(tasksDir).filter((f) => f.endsWith('.json'))
  : [];

let rebuilt = 0;
let stillBoilerplate = 0;
let withGate = 0;
let withRules = 0;
let withFiles = 0;
const updatedLessons = [];

for (const tf of taskFiles) {
  let task;
  try {
    task = JSON.parse(fs.readFileSync(path.join(tasksDir, tf), 'utf8'));
  } catch { continue; }
  if (!task?.taskId) continue;

  const lessonId = `lesson-${task.taskId}`;
  const prev = existingById.get(lessonId);
  if (!prev) continue;  // 원래 lesson 없던 task 는 건너뜀

  const scope = (Array.isArray(task.matchedScopes) && task.matchedScopes[0])
    || prev.scope || 'repo';

  const extracted = extractLessonContent({ task, scope });

  const next = {
    ...prev,
    summary: extracted.summary,
    rules: extracted.rules.length ? extracted.rules : prev.rules,
    relatedFiles: extracted.relatedFiles.length ? extracted.relatedFiles : (prev.relatedFiles || []),
    applicable_when: extracted.applicable_when,
    trigger_keywords: extracted.trigger_keywords,
    updatedAt: new Date().toISOString()
  };

  updatedLessons.push(next);
  rebuilt++;

  if (next.summary === 'Captured reusable workflow guidance for repo scope.') stillBoilerplate++;
  if (Object.keys(next.applicable_when || {}).filter((k) => k !== 'scope_id').length > 0) withGate++;
  if ((next.rules || []).length > 0 && next.rules[0] !== 'read read_first notes before writing a plan') withRules++;
  if ((next.relatedFiles || []).length > 0) withFiles++;

  // existingById 에서 제거 — 처리 완료된 거.
  existingById.delete(lessonId);
}

// existingById 에 남은 것 = task 가 없는 고아 lesson. 그대로 보존.
const orphanLessons = Array.from(existingById.values());
const finalLessons = [...updatedLessons, ...orphanLessons];

console.log(`taskFiles: ${taskFiles.length}`);
console.log(`existing lessons: ${existingLessons.length}`);
console.log(`rebuilt: ${rebuilt}`);
console.log(`orphan kept: ${orphanLessons.length}`);
console.log(`still boilerplate: ${stillBoilerplate}`);
console.log(`with non-trivial applicable_when: ${withGate}/${rebuilt}`);
console.log(`with dynamic rules: ${withRules}/${rebuilt}`);
console.log(`with relatedFiles: ${withFiles}/${rebuilt}`);

if (dryRun) {
  console.log('[dry-run] 파일 변경 안 함.');
  process.exit(0);
}

// 백업 + 덮어쓰기
const bak = `${lessonsPath}.bak.${Date.now()}`;
if (fs.existsSync(lessonsPath)) fs.copyFileSync(lessonsPath, bak);
const out = finalLessons.map((l) => JSON.stringify(l)).join('\n') + '\n';
fs.writeFileSync(lessonsPath, out);
console.log(`백업: ${bak}`);
console.log(`갱신: ${lessonsPath} (${finalLessons.length} lessons)`);
