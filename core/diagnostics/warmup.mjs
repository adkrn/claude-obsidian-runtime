#!/usr/bin/env node
// warmup.mjs — 즉효 2/3 의 효과를 한 번 강제로 발동시켜 doctor 가 변화를 볼 수 있게 함.
// 안전: 실제 task 진행과 무관. side-effect는 (1) orphan pointer archive 이동, (2) hit-counts seed.
// 사용: node warmup.mjs <projectDir>

import path from 'node:path';
import fs from 'node:fs';
import { gcOrphanPointers } from '../pointer-gc.mjs';
import { bumpHitCounts } from '../memory/hit-counts.mjs';

const projectDir = process.argv[2];
if (!projectDir || !fs.existsSync(projectDir)) {
  console.error('usage: warmup.mjs <projectDir>');
  process.exit(2);
}

console.log('=== orphan pointer GC ===');
const gcResult = gcOrphanPointers(projectDir, {});
console.log(`archived: ${gcResult.archived.length}`);
for (const f of gcResult.archived) console.log(`  - ${f}`);
console.log(`kept: ${gcResult.kept.length}`);
console.log(`skipped: ${gcResult.skipped.length}`);
console.log('');

console.log('=== hit-counts seed (최신 task readFirst 기반) ===');
const tasksDir = path.join(projectDir, '.claude', 'runtime', 'tasks');
const taskFiles = fs.existsSync(tasksDir)
  ? fs.readdirSync(tasksDir).filter((f) => f.endsWith('.json')).sort().slice(-5)
  : [];
let totalIncremented = 0;
for (const tf of taskFiles) {
  let task;
  try { task = JSON.parse(fs.readFileSync(path.join(tasksDir, tf), 'utf8')); } catch { continue; }
  const readFirst = task.readFirst || [];
  // 기존 readFirst entries에 lessonId 가 없으므로, lesson row 의 sourceDoc 과 path 매칭으로
  // lessonId 를 역추적해서 bump 한다.
  const lessonsPath = path.join(projectDir, '.claude', 'runtime', 'knowledge', 'lessons.jsonl');
  const lessons = fs.existsSync(lessonsPath)
    ? fs.readFileSync(lessonsPath, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : [];
  const pathToId = new Map(lessons.map((l) => [l.sourceDoc, l.id]));
  const enriched = readFirst.map((r) => ({ ...r, lessonId: pathToId.get(r.path) || '' }));
  const res = bumpHitCounts(projectDir, enriched, { taskId: task.taskId });
  totalIncremented += res.incremented.length;
}
console.log(`총 incremented: ${totalIncremented} (최근 ${taskFiles.length} task readFirst 기반)`);
