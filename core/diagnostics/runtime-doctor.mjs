#!/usr/bin/env node
// runtime-doctor.mjs — 운영 중인 프로젝트의 4-Layer 메모리 작동 진단
// 사용: node runtime-doctor.mjs <projectRuntimeDir>
//       예: node runtime-doctor.mjs C:/UnityProject/Pasim62_Trainee/.claude/runtime

import fs from 'node:fs'
import path from 'node:path'

const runtimeDir = process.argv[2]
if (!runtimeDir || !fs.existsSync(runtimeDir)) {
  console.error('usage: runtime-doctor.mjs <projectRuntimeDir>')
  process.exit(2)
}

const projectDir = path.dirname(path.dirname(runtimeDir))
const manifestPath = path.join(path.dirname(runtimeDir), 'runtime-manifest.json')

const out = []
const log = (line) => out.push(line)

const exists = (p) => fs.existsSync(p)
const readJsonSafe = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return fallback }
}
const readLinesSafe = (p) => {
  try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean) } catch { return [] }
}
const listDir = (p) => { try { return fs.readdirSync(p) } catch { return [] } }

const manifest = readJsonSafe(manifestPath, {})

log('═══════════════════════════════════════════════════════════════')
log(`  runtime-doctor — ${path.basename(projectDir)}`)
log(`  runtime: ${runtimeDir}`)
log('═══════════════════════════════════════════════════════════════')
log('')

// ─── L1 Episodic ──────────────────────────────────────────────────
const eventsDir = path.join(runtimeDir, 'events')
const eventFiles = listDir(eventsDir).filter(f => f.endsWith('.jsonl'))
let totalEvents = 0
const eventTypes = {}
for (const f of eventFiles) {
  const lines = readLinesSafe(path.join(eventsDir, f))
  totalEvents += lines.length
  for (const ln of lines) {
    try {
      const ev = JSON.parse(ln)
      eventTypes[ev.eventType] = (eventTypes[ev.eventType] || 0) + 1
    } catch {}
  }
}
log('[L1 Episodic]')
log(`  events 파일: ${eventFiles.length}개 / 총 ${totalEvents}건`)
const typeList = Object.entries(eventTypes).sort((a, b) => b[1] - a[1]).slice(0, 5)
for (const [t, c] of typeList) log(`    - ${t}: ${c}`)
const l1Status = totalEvents > 0 ? 'OK' : 'EMPTY'
log(`  상태: ${l1Status === 'OK' ? '✅ OK' : '❌ EMPTY'}`)
log('')

// ─── L2 Semantic (lessons) ────────────────────────────────────────
const lessonsPath = path.join(runtimeDir, 'knowledge', 'lessons.jsonl')
const lessonLines = readLinesSafe(lessonsPath)
let lessons = []
for (const ln of lessonLines) {
  try { lessons.push(JSON.parse(ln)) } catch {}
}
const defaultRule = 'read read_first notes before writing a plan'
const boilerplateCount = lessons.filter(l => {
  const rules = l.rules || []
  return rules.length === 1 && rules[0] === defaultRule
}).length
const summaryDefault = 'Captured reusable workflow guidance for repo scope.'
const summaryBoilerplate = lessons.filter(l => l.summary === summaryDefault).length
const lessonsWithGate = lessons.filter(l => {
  const aw = l.applicable_when
  return aw && Object.keys(aw).length > 0
}).length
const lessonsWithRelatedFiles = lessons.filter(l => (l.relatedFiles || []).length > 0).length
const lessonsWithChecks = lessons.filter(l => (l.checks || []).length > 0).length

log('[L2 Semantic]')
log(`  lessons.jsonl: ${lessons.length}건`)
log(`    - boilerplate rule만 가진 비율: ${boilerplateCount}/${lessons.length} (${pct(boilerplateCount, lessons.length)})`)
log(`    - boilerplate summary 비율: ${summaryBoilerplate}/${lessons.length} (${pct(summaryBoilerplate, lessons.length)})`)
log(`    - applicable_when 채워진 비율: ${lessonsWithGate}/${lessons.length} (${pct(lessonsWithGate, lessons.length)})`)
log(`    - relatedFiles 채워진 비율: ${lessonsWithRelatedFiles}/${lessons.length} (${pct(lessonsWithRelatedFiles, lessons.length)})`)
log(`    - checks 채워진 비율: ${lessonsWithChecks}/${lessons.length} (${pct(lessonsWithChecks, lessons.length)})`)
const l2Status = lessons.length > 0 && boilerplateCount / lessons.length < 0.5 ? 'OK' : (lessons.length === 0 ? 'EMPTY' : 'BOILERPLATE')
log(`  상태: ${l2Status === 'OK' ? '✅ OK' : (l2Status === 'EMPTY' ? '❌ EMPTY' : '⚠️ BOILERPLATE')}`)
log('')

// ─── L3 Procedural ────────────────────────────────────────────────
// 볼트 경로 추정 — runtime-manifest.json의 vaultRoot 또는 default
const vaultRootCandidates = [
  path.join(projectDir, 'document', 'obsidian_context'),
  path.join(projectDir, '..', '..', 'Obsidian', path.basename(projectDir).toLowerCase()),
]
let vaultRoot = null
for (const c of vaultRootCandidates) {
  if (exists(c)) { vaultRoot = c; break }
}
const proceduresDir = vaultRoot ? path.join(vaultRoot, '09_Templates', 'Procedures') : null
const procedureFiles = proceduresDir && exists(proceduresDir)
  ? listDir(proceduresDir).filter(f => f.endsWith('.md'))
  : []
log('[L3 Procedural]')
log(`  vault root: ${vaultRoot || '(미발견)'}`)
log(`  procedures: ${procedureFiles.length}건`)
const l3Status = procedureFiles.length > 0 ? 'OK' : 'EMPTY'
log(`  상태: ${l3Status === 'OK' ? '✅ OK' : '❌ EMPTY — 반복 패턴 distillation 미가동'}`)
log('')

// ─── L4 Reflective ────────────────────────────────────────────────
const reflectionsDir = vaultRoot ? path.join(vaultRoot, '08_Reflections') : null
const reflectionFiles = reflectionsDir && exists(reflectionsDir)
  ? walkMd(reflectionsDir)
  : []
const reflectionEnabled = manifest?.reflection?.enabled === true
log('[L4 Reflective]')
log(`  manifest.reflection.enabled: ${reflectionEnabled ? '✅ true' : '❌ false'}`)
log(`  08_Reflections/: ${reflectionFiles.length}건`)
const l4Status = reflectionEnabled && reflectionFiles.length > 0 ? 'OK'
  : (!reflectionEnabled ? 'DISABLED' : 'EMPTY')
log(`  상태: ${l4Status === 'OK' ? '✅ OK' : (l4Status === 'DISABLED' ? '⚠️ DISABLED (manifest 꺼짐)' : '❌ EMPTY')}`)
log('')

// ─── Scoring (hit-counts) ─────────────────────────────────────────
const hitCountsPath = path.join(runtimeDir, 'knowledge', 'hit-counts.json')
const hitCounts = readJsonSafe(hitCountsPath, {})
const hitEntries = Object.keys(hitCounts).length
const totalHits = Object.values(hitCounts).reduce((a, b) => a + (typeof b === 'number' ? b : (b?.count || 0)), 0)
log('[Scoring — 3축 retrieval]')
log(`  hit-counts.json 엔트리: ${hitEntries}`)
log(`  총 hit 카운트: ${totalHits}`)
log(`  weights: recency=${manifest?.retrievalWeights?.alphaRecency} importance=${manifest?.retrievalWeights?.alphaImportance} relevance=${manifest?.retrievalWeights?.alphaRelevance}`)
const scoringStatus = hitEntries > 0 ? 'OK' : 'DEAD'
log(`  상태: ${scoringStatus === 'OK' ? '✅ OK' : '❌ DEAD — readFirst → hit 카운트 hook 누락'}`)
log('')

// ─── MMR 다양성 ───────────────────────────────────────────────────
// 최근 task json들에서 readFirst의 중복(같은 폴더/같은 prefix) 비율 측정
const tasksDir = path.join(runtimeDir, 'tasks')
const taskFiles = listDir(tasksDir).filter(f => f.endsWith('.json')).slice(-20)
let totalReadFirst = 0
let duplicatePairs = 0
for (const tf of taskFiles) {
  const t = readJsonSafe(path.join(tasksDir, tf), {})
  const rf = t.readFirst || []
  totalReadFirst += rf.length
  for (let i = 0; i < rf.length; i++) {
    for (let j = i + 1; j < rf.length; j++) {
      if (similarPath(rf[i].path, rf[j].path)) duplicatePairs++
    }
  }
}
const mmrLambda = manifest?.retrievalWeights?.diversityLambda
log('[MMR 다양성]')
log(`  diversityLambda: ${mmrLambda} (PRINCIPLES 권장 0.7)`)
log(`  최근 ${taskFiles.length} task의 readFirst 총 ${totalReadFirst}개`)
log(`  유사경로 중복 쌍: ${duplicatePairs}`)
const mmrStatus = duplicatePairs === 0 ? 'OK' : (mmrLambda < 0.5 ? 'LAMBDA_TOO_LOW' : 'DUPLICATE')
log(`  상태: ${mmrStatus === 'OK' ? '✅ OK'
  : mmrStatus === 'LAMBDA_TOO_LOW' ? `⚠️ diversityLambda=${mmrLambda} 너무 낮음 (0.7 권장)`
  : '⚠️ 중복 발생'}`)
log('')

// ─── Session pointer ──────────────────────────────────────────────
const rootFiles = listDir(runtimeDir)
const orphanPointers = rootFiles.filter(f => /^current-task-.+\.json$/.test(f))
const globalPointer = rootFiles.includes('current-task.json')
log('[Session pointer]')
log(`  global current-task.json: ${globalPointer ? '⚠️ 존재 (race 위험)' : '✅ 없음'}`)
log(`  session-scoped current-task-*.json: ${orphanPointers.length}개`)
for (const f of orphanPointers.slice(0, 5)) {
  const stat = fs.statSync(path.join(runtimeDir, f))
  const days = Math.round((Date.now() - stat.mtimeMs) / 86400000)
  log(`    - ${f} (${days}일 전)`)
}
if (orphanPointers.length > 5) log(`    ... 외 ${orphanPointers.length - 5}건`)
const ptrStatus = !globalPointer && orphanPointers.length < 3 ? 'OK'
  : globalPointer ? 'RACE_RISK' : 'ORPHAN'
log(`  상태: ${ptrStatus === 'OK' ? '✅ OK'
  : ptrStatus === 'RACE_RISK' ? '🔴 RACE 위험 (글로벌 + 세션별 공존)'
  : '⚠️ ORPHAN — GC 필요'}`)
log('')

// ─── Governance (delegations) ─────────────────────────────────────
const delegationsPath = path.join(runtimeDir, 'delegations.jsonl')
const delegations = readLinesSafe(delegationsPath)
const governanceEnabled = manifest?.governance?.enabled === true
log('[Governance — delegations]')
log(`  manifest.governance.enabled: ${governanceEnabled ? '✅ true' : '❌ false'}`)
log(`  delegations.jsonl: ${delegations.length}건`)
const govStatus = governanceEnabled && delegations.length > 0 ? 'OK'
  : !governanceEnabled ? 'DISABLED' : 'EMPTY'
log(`  상태: ${govStatus === 'OK' ? '✅ OK'
  : govStatus === 'DISABLED' ? '⚠️ DISABLED (manifest 꺼짐)'
  : '❌ EMPTY — lead PM 미가동'}`)
log('')

// ─── codeHits in recent tasks ─────────────────────────────────────
let codeHitTotal = 0, taskWithCodeHits = 0
for (const tf of taskFiles) {
  const t = readJsonSafe(path.join(tasksDir, tf), {})
  const ch = (t.codeHits || []).length
  codeHitTotal += ch
  if (ch > 0) taskWithCodeHits++
}
log('[Code-index 매칭]')
log(`  최근 ${taskFiles.length} task 중 codeHits 발생: ${taskWithCodeHits}건 / 총 ${codeHitTotal}개`)
const codeStatus = taskWithCodeHits > 0 ? 'OK' : 'DEAD'
log(`  상태: ${codeStatus === 'OK' ? '✅ OK' : '❌ DEAD — code-index 키워드 매칭 0건'}`)
log('')

// ─── 요약 ─────────────────────────────────────────────────────────
log('═══════════════════════════════════════════════════════════════')
log('  요약')
log('═══════════════════════════════════════════════════════════════')
const summary = [
  ['L1 Episodic', l1Status],
  ['L2 Semantic', l2Status],
  ['L3 Procedural', l3Status],
  ['L4 Reflective', l4Status],
  ['Scoring (hit-counts)', scoringStatus],
  ['MMR 다양성', mmrStatus],
  ['Session pointer', ptrStatus],
  ['Governance', govStatus],
  ['Code-index 매칭', codeStatus],
]
for (const [name, st] of summary) {
  const mark = st === 'OK' ? '✅' : (st === 'DISABLED' ? '⚠️ ' : '❌')
  log(`  ${mark} ${name.padEnd(24)} ${st}`)
}
log('')
const okCount = summary.filter(([, s]) => s === 'OK').length
log(`  작동률: ${okCount}/${summary.length} (${pct(okCount, summary.length)})`)
log('')

console.log(out.join('\n'))

// ─── helpers ──────────────────────────────────────────────────────
function pct(n, d) {
  if (!d) return '0%'
  return `${Math.round(n / d * 100)}%`
}
function similarPath(a, b) {
  if (!a || !b) return false
  if (a === b) return true
  // 같은 폴더 + 비슷한 prefix
  const da = path.dirname(a), db = path.dirname(b)
  if (da !== db) return false
  const na = path.basename(a, '.md'), nb = path.basename(b, '.md')
  return na.slice(0, 20) === nb.slice(0, 20)
}
function walkMd(dir) {
  const out = []
  function walk(d) {
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.md')) out.push(p)
    }
  }
  walk(dir)
  return out
}
