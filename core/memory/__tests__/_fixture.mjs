import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

export function createFixtureProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `core-memory-${crypto.randomBytes(4).toString('hex')}-`));
  fs.mkdirSync(path.join(root, '.claude', 'runtime', 'events'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude', 'runtime', 'knowledge'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude', 'runtime', 'tasks'), { recursive: true });
  return {
    projectDir: root,
    cleanup() {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  };
}
