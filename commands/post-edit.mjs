#!/usr/bin/env node

/**
 * PostToolUse hook handler.
 *
 * Captures file_modified / public_surface_detected / verification_run / tool_failed
 * events using the shared learning-capture engine.
 *
 * Project-specific configuration is read from
 *   .claude/runtime-manifest.json:
 *     - surfacePatterns: string[]   (e.g. ["/routes/", "/controllers/"])
 *     - scopeFolderMap:  object      (e.g. { "backend/": "backend", "frontend/": "frontend" })
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  captureLearningEvent,
  inferSurfaceType,
  isCodeLikePath,
  isPublicSurfacePath,
  isVerificationCommand,
  parseCaptureArgs
} from '../core/learning-capture.mjs';
import { readStdinJson } from '../core/utils.mjs';

function loadManifestConfig(projectDir) {
  const manifestPath = path.join(projectDir, '.claude', 'runtime-manifest.json');
  if (!fs.existsSync(manifestPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return {};
  }
}

function buildCaptureConfig(manifest) {
  const surfaceSegments = Array.isArray(manifest.surfacePatterns) && manifest.surfacePatterns.length > 0
    ? manifest.surfacePatterns
    : undefined;

  const scopeMap = (manifest.scopeFolderMap && typeof manifest.scopeFolderMap === 'object')
    ? manifest.scopeFolderMap
    : null;

  const config = {};
  if (surfaceSegments) config.surfaceSegments = surfaceSegments;

  if (scopeMap) {
    config.inferScope = (filePath) => {
      const p = filePath.replace(/\\/g, '/');
      for (const [folder, scope] of Object.entries(scopeMap)) {
        if (p.includes(folder)) return scope;
      }
      return manifest.defaultScope || 'repo';
    };
  }

  return config;
}

async function main() {
  const args = parseCaptureArgs(process.argv.slice(2));
  const projectDir = path.resolve(args.projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd());

  let input;
  try {
    input = await readStdinJson({});
  } catch {
    input = {};
  }

  const manifest = loadManifestConfig(projectDir);
  const captureConfig = buildCaptureConfig(manifest);
  const surfaceSegments = captureConfig.surfaceSegments;

  const toolName = input.tool_name || args.toolName || '';
  const filePath = input.tool_input?.file_path || input.tool_input?.command || args.filePath || '';
  const command = input.tool_input?.command || args.command || '';
  const isError = input.tool_error === true;
  const output = String(input.tool_output || '').slice(0, 500);

  let eventType = '';
  let eventFilePath = '';
  let success = 'true';

  if (['Edit', 'Write'].includes(toolName) && filePath) {
    eventFilePath = filePath;
    if (isCodeLikePath(filePath)) {
      eventType = 'file_modified';
      if (surfaceSegments && isPublicSurfacePath(filePath, surfaceSegments)) {
        captureLearningEvent(projectDir, {
          eventType: 'public_surface_detected',
          toolName,
          filePath: eventFilePath,
          surfaceType: inferSurfaceType(eventFilePath),
          sessionId: args.sessionId
        }, captureConfig);
      } else if (!surfaceSegments && isPublicSurfacePath(filePath)) {
        captureLearningEvent(projectDir, {
          eventType: 'public_surface_detected',
          toolName,
          filePath: eventFilePath,
          surfaceType: inferSurfaceType(eventFilePath),
          sessionId: args.sessionId
        }, captureConfig);
      }
    }
  } else if (toolName === 'Bash' && command) {
    if (isVerificationCommand(command)) {
      eventType = isError ? 'verification_failed' : 'verification_run';
      success = isError ? 'false' : 'true';
    } else if (isError) {
      eventType = 'tool_failed';
      success = 'false';
    }
  }

  if (!eventType) {
    process.exit(0);
  }

  const result = captureLearningEvent(projectDir, {
    eventType,
    toolName,
    filePath: eventFilePath,
    command,
    success,
    message: output,
    sessionId: args.sessionId
  }, captureConfig);

  if (result.ok) {
    process.stdout.write(JSON.stringify(result) + '\n');
  }
}

const currentFilePath = fileURLToPath(import.meta.url);
const invokedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (currentFilePath === invokedFilePath) {
  main().catch(() => process.exit(0));
}
