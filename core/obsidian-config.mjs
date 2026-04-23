/**
 * Shared Obsidian config loader.
 * Reads obsidian_paths.json from any project and returns unified config.
 * Project-neutral: no hardcoded defaults for any specific project.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const DEFAULT_MANAGED_ROOTS = [
  '00_Home',
  '04_Architecture',
  '06_Troubleshooting',
  '07_Decisions',
  '08_Lessons'
];

const DEFAULT_MCP_ROOTS = [
  '06_Troubleshooting',
  '07_Decisions',
  '08_Lessons',
  '10_Worklogs'
];

const DEFAULT_MIRROR_EXCLUDE_ROOTS = [
  '04_Architecture/Drafts',
  '04_Architecture/Generated',
  '07_Decisions/Drafts',
  '10_Worklogs'
];

export const READ_POLICY = {
  contextInjection: ['00_Home', '04_Architecture', '06_Troubleshooting', '07_Decisions', '08_Lessons'],
  knowledgeIndex: ['06_Troubleshooting', '07_Decisions', '08_Lessons'],
  architectureRef: ['04_Architecture'],
  templateSource: ['09_Templates']
};

export const WRITE_POLICY = {
  knowledgeDraft: ['06_Troubleshooting/*/Drafts', '07_Decisions/Drafts', '08_Lessons/*/Drafts'],
  architectureDraft: ['04_Architecture/Drafts', '04_Architecture/Generated'],
  worklog: ['10_Worklogs'],
  readOnly: ['00_Home', '09_Templates']
};

export function loadObsidianConfig(projectDir, options = {}) {
  const contextRoot = path.resolve(options.contextRoot || path.join(projectDir, 'document', 'obsidian_context'));
  const configPath = path.join(contextRoot, '_meta', 'obsidian_paths.json');
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    // use defaults
  }

  const platformDefault = process.platform === 'win32' ? 'C:\\Obsidian' : path.join(os.homedir(), 'Obsidian');
  const vaultRoot = process.env.OBSIDIAN_VAULT_ROOT || config.vaultRoot || platformDefault;
  const resolvedVaultRoot = path.resolve(vaultRoot);

  return {
    contextRoot,
    vaultRoot: resolvedVaultRoot,
    vaultAvailable: fs.existsSync(resolvedVaultRoot),
    managedRoots: config.managedRoots || DEFAULT_MANAGED_ROOTS,
    mcpRoots: config.mcpRoots || DEFAULT_MCP_ROOTS,
    mirrorExcludeRoots: config.mirrorExcludeRoots || DEFAULT_MIRROR_EXCLUDE_ROOTS,
    externalDocsRoot: path.join(contextRoot, '_external'),
    readPolicy: READ_POLICY,
    writePolicy: WRITE_POLICY,
    projectId: config.projectId || null,
    indexTargets: config.indexTargets || null,
    scanRoots: config.scanRoots || null
  };
}
