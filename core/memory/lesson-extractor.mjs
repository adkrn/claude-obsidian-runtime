// lesson-extractor.mjs — task 본문/readFirst/guardrails/codeHits에서 lesson 본문 추출
// 목표:
//   - boilerplate summary 탈출 (task 제목·readFirst 기반)
//   - applicable_when 자동 채움 (language/layer/task_type/scope_id)
//   - rules: prompt/title 한국어 키워드 기반 동적 생성
//   - relatedFiles: task.files + readFirst paths + codeHits 통합
// learning-capture hook 이 없어 file_read events 가 안 쌓여도
// 적어도 readFirst 가 가리키는 mirror code 경로는 안다.

import path from 'node:path';

const LANG_EXTS = {
  cs: 'csharp', cshtml: 'csharp',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java', kt: 'kotlin',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  sh: 'shell', bash: 'shell', ps1: 'powershell',
  md: 'markdown', mdx: 'markdown',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  sql: 'sql',
  html: 'html', css: 'css', scss: 'css', less: 'css',
  shader: 'shader', cg: 'shader', hlsl: 'shader',
  unity: 'unity-scene', prefab: 'unity-prefab', asset: 'unity-asset', meta: 'unity-meta'
};

const KIND_KEYWORDS = {
  unity: ['unity', 'monobehaviour', 'scriptableobject', 'prefab', '.cs', 'gameobject', '하베스', '컨트롤러', '낙하산', '비행'],
  web: ['react', 'next', 'vue', 'svelte', 'css', 'html', 'tsx', 'jsx'],
  backend: ['express', 'django', 'spring', 'route', 'controller', 'service', 'middleware', 'sql', 'migration'],
  cli: ['cli', 'bin/', 'argv', 'process.argv'],
  data: ['csv', 'parquet', 'sqlite', 'duckdb', 'pandas', 'clickhouse'],
  library: ['package.json', 'export ', 'public api']
};

const TASK_TYPE_HINTS = [
  { type: 'impl', tokens: ['구현', 'implement', 'add', '추가', '작성해', '만들어'] },
  { type: 'design', tokens: ['설계', 'design', '기획', '계획서', 'plan'] },
  { type: 'debug', tokens: ['수정', 'fix', '버그', 'bug', '오류', 'error', '문제'] },
  { type: 'analysis', tokens: ['분석', 'analyze', '조사', '확인', '검토', 'investigate', 'review'] },
  { type: 'refactor', tokens: ['리팩토링', 'refactor', '정리', '슬림화', '통일', 'unify', 'cleanup'] },
  { type: 'docs', tokens: ['문서', 'docs', 'readme', '작성해줘', 'documentation'] },
  { type: 'test', tokens: ['테스트', 'test', 'editmode', 'playmode', '검증', 'verify'] }
];

const STOP_TOKENS = new Set([
  '이', '그', '저', '것', '수', '문서', '읽고', '진행해', '해줘', '해', '돼', '돼지',
  '의', '와', '을', '를', '에', '에서', '으로', '로', '도',
  'the', 'a', 'an', 'is', 'in', 'on', 'with', 'and', 'or', 'to', 'for',
  // Boilerplate-derived tokens ("read read_first notes before writing a plan").
  // These leaked into trigger_keywords and polluted retrieval (read=24x etc.).
  'read', 'read_first', 'before', 'after', 'notes', 'writing', 'plan',
  // Korean command verbs / fillers / sentence fragments — no retrieval signal.
  '구현', '구현해줘', '구현해', '하는데', '하는', '하고', '진행',
  '시작해', '시작', '명세대로', '문서대로', '작성', '작성해줘', '작성해', '보고',
  '지금', '바로', '현재', '어떻게', '어떤', '사용할지', '사용', '싶은데', '싶어',
  '좀', '확인', '확인해줘', '정리', '정리해줘', '알려', '알려줘',
  '만들어', '만들어줘', '추가', '추가해줘', '세션', '계획', '계획좀',
  // English generic verbs.
  'this', 'that', 'add', 'fix', 'make', 'use', 'check'
]);

export function detectLanguage(files = []) {
  const langs = new Set();
  for (const f of files) {
    const ext = path.extname(String(f || '')).slice(1).toLowerCase();
    if (LANG_EXTS[ext]) langs.add(LANG_EXTS[ext]);
  }
  return Array.from(langs);
}

export function detectKind(text = '', files = []) {
  const hay = `${text} ${files.join(' ')}`.toLowerCase();
  const kinds = new Set();
  for (const [kind, kws] of Object.entries(KIND_KEYWORDS)) {
    if (kws.some((kw) => hay.includes(kw))) kinds.add(kind);
  }
  return Array.from(kinds);
}

export function detectTaskTypes(text = '') {
  const types = new Set();
  for (const { type, tokens } of TASK_TYPE_HINTS) {
    if (tokens.some((kw) => text.includes(kw))) types.add(type);
  }
  return Array.from(types);
}

export function buildApplicableWhen({ files, text, scope, matchedScopes }) {
  const language = detectLanguage(files);
  const kind = detectKind(text, files);
  const task_type = detectTaskTypes(text);
  const aw = { scope_id: scope || null };
  if (language.length) aw.language = language;
  if (kind.length) aw.kind = kind;
  if (task_type.length) aw.task_type = task_type;
  if (Array.isArray(matchedScopes) && matchedScopes.length > 0) {
    aw.matched_scopes = matchedScopes.slice(0, 6);
  }
  return aw;
}

export function buildTriggerKeywords(text = '', files = [], topN = 8) {
  const tokens = String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s.\-/]/gu, ' ')
    .split(/\s+/)
    // Strip leading/trailing dots so "구현해줘." matches the stopword "구현해줘".
    .map((t) => t.replace(/^[.]+|[.]+$/gu, ''))
    .filter((t) => t && t.length >= 2 && !STOP_TOKENS.has(t))
    // Drop pure numbers — no retrieval signal (e.g. "100").
    .filter((t) => !/^[0-9]+$/u.test(t));
  const fileTokens = (files || [])
    .map((f) => path.basename(String(f), path.extname(String(f))))
    .filter(Boolean);
  const merged = new Map();
  for (const t of [...tokens, ...fileTokens]) {
    merged.set(t, (merged.get(t) || 0) + 1);
  }
  return Array.from(merged.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t)
    .slice(0, topN);
}

/**
 * task 에서 감지/증거(evidence)를 수집한다. lesson 본문은 만들지 않는다.
 * LLM 추출(llm-extractor)의 프롬프트 seed + related_files 환각 필터에 사용.
 * @returns {{ files, language, kind, task_type, scope, readFirstPaths }}
 */
export function extractEvidence({ task, scope }) {
  const safeTask = task || {};
  const text = [
    safeTask.title || '',
    safeTask.prompt || '',
    ...(Array.isArray(safeTask.guardrails) ? safeTask.guardrails : [])
  ].join('\n');

  const readFirstPaths = Array.isArray(safeTask.readFirst)
    ? safeTask.readFirst.map((r) => String(r?.path || '')).filter(Boolean)
    : [];

  const files = Array.from(new Set([
    ...(Array.isArray(safeTask.files) ? safeTask.files : []),
    ...readFirstPaths
  ])).filter(Boolean);

  return {
    files,
    readFirstPaths,
    scope: scope || (Array.isArray(safeTask.matchedScopes) && safeTask.matchedScopes[0]) || 'repo',
    language: detectLanguage(files),
    kind: detectKind(text, files),
    task_type: detectTaskTypes(text)
  };
}

/**
 * task 의 감지 필드(applicable_when/trigger_keywords/language/kind/task_type)를 만든다.
 * boilerplate 생성부(summary/rules)는 제거됨 — lesson 본문은 LLM(llm-extractor)이 생성한다.
 * summary/rules 가 비어 있으면 호출부(learning-curate)의 게이트가 lesson 생성을 건너뛴다.
 * @returns {{ summary, rules, applicable_when, trigger_keywords, relatedFiles, language, kind, task_type }}
 */
export function extractLessonContent({ task, scope }) {
  const safeTask = task || {};
  const text = [
    safeTask.title || '',
    safeTask.prompt || '',
    ...(Array.isArray(safeTask.guardrails) ? safeTask.guardrails : [])
  ].join('\n');

  const evidence = extractEvidence({ task: safeTask, scope });
  const applicable_when = buildApplicableWhen({
    files: evidence.files,
    text,
    scope,
    matchedScopes: safeTask.matchedScopes
  });
  const trigger_keywords = buildTriggerKeywords(text, evidence.files);

  return {
    summary: '',            // boilerplate 제거 — LLM 추출이 채운다
    rules: [],              // boilerplate 제거 — LLM 추출이 채운다
    applicable_when,
    trigger_keywords,
    relatedFiles: evidence.files.slice(0, 12),
    language: evidence.language,
    kind: evidence.kind,
    task_type: evidence.task_type
  };
}
