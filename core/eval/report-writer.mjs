// Report writer for the eval frame.
// Validates the 9-key top-level schema, ensures the reports directory,
// generates a deterministic filename, and writes atomically.
// Spec: DESIGN_C §2-E + §3-B.

import fs from 'fs';
import path from 'path';

const REQUIRED_TOP_LEVEL_KEYS = [
  'projectId',
  'runtimeVersion',
  'reportedAt',
  'goldenRuns',
  'presence',
  'equivalence',
  'quality',
  'lessonReuse',
  'performance'
];

export class SchemaError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'SchemaError';
    if (details) this.details = details;
  }
}

export function validateReportSchema(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new SchemaError('report must be a plain object');
  }
  const missing = [];
  for (const key of REQUIRED_TOP_LEVEL_KEYS) {
    if (!(key in report)) missing.push(key);
  }
  if (missing.length > 0) {
    throw new SchemaError(`report missing required keys: ${missing.join(', ')}`, { missing });
  }
  if (typeof report.projectId !== 'string' || report.projectId.length === 0) {
    throw new SchemaError('report.projectId must be a non-empty string');
  }
  if (typeof report.runtimeVersion !== 'string' || report.runtimeVersion.length === 0) {
    throw new SchemaError('report.runtimeVersion must be a non-empty string');
  }
  if (typeof report.reportedAt !== 'string' || Number.isNaN(Date.parse(report.reportedAt))) {
    throw new SchemaError('report.reportedAt must be an ISO-8601 string');
  }
  if (!Array.isArray(report.goldenRuns)) {
    throw new SchemaError('report.goldenRuns must be an array');
  }
  for (const sectionKey of ['presence', 'equivalence', 'quality', 'lessonReuse', 'performance']) {
    const value = report[sectionKey];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new SchemaError(`report.${sectionKey} must be a plain object`);
    }
  }
}

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

export function formatTs(input, withSeconds = false) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new RangeError(`formatTs: invalid date input ${String(input)}`);
  }
  const yyyy = d.getUTCFullYear();
  const mm = pad2(d.getUTCMonth() + 1);
  const dd = pad2(d.getUTCDate());
  const hh = pad2(d.getUTCHours());
  const mi = pad2(d.getUTCMinutes());
  if (withSeconds) {
    const ss = pad2(d.getUTCSeconds());
    return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
  }
  return `${yyyy}${mm}${dd}-${hh}${mi}`;
}

export function atomicWrite(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

function sanitizeProjectId(projectId) {
  return String(projectId).replace(/[^A-Za-z0-9._-]/g, '_');
}

export function writeReport(projectDir, report) {
  if (!projectDir || typeof projectDir !== 'string') {
    throw new TypeError('writeReport: projectDir required');
  }
  validateReportSchema(report);
  const reportsDir = path.join(projectDir, '.claude', 'runtime', 'eval', 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const ts = formatTs(report.reportedAt, false);
  const safeId = sanitizeProjectId(report.projectId);
  let filename = `${ts}_${safeId}.json`;
  let filePath = path.join(reportsDir, filename);
  if (fs.existsSync(filePath)) {
    const tsFull = formatTs(report.reportedAt, true);
    filename = `${tsFull}_${safeId}.json`;
    filePath = path.join(reportsDir, filename);
  }
  atomicWrite(filePath, JSON.stringify(report, null, 2));
  return filePath;
}
