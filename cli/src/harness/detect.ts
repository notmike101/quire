import { existsSync, statSync } from 'node:fs';
import { makeZcodeAdapter, zcodeDbPath } from './zcode.js';
import { makeClaudeCodeAdapter, claudeProjectsDir } from './claude-code.js';
import type { HarnessAdapter } from './types.js';

export type HarnessName = 'zcode' | 'claude-code';

export function defaultStorePaths(): { zcode: string; claudeCode: string } {
  return { zcode: zcodeDbPath(), claudeCode: claudeProjectsDir() };
}

function mtimeIfExists(path: string): number | undefined {
  try {
    return existsSync(path) ? statSync(path).mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

export function detectHarness(
  env: NodeJS.ProcessEnv = process.env,
  paths: { zcode: string; claudeCode: string } = defaultStorePaths(),
): HarnessName {
  if (env.CLAUDECODE) return 'claude-code';
  if (env.ZCODE_APP_VERSION) return 'zcode';
  const z = mtimeIfExists(paths.zcode);
  const c = mtimeIfExists(paths.claudeCode);
  if (z !== undefined && c !== undefined) return z >= c ? 'zcode' : 'claude-code';
  if (z !== undefined) return 'zcode';
  if (c !== undefined) return 'claude-code';
  throw new Error('could not detect a harness; pass --harness zcode or --harness claude-code');
}

export function makeAdapter(name: HarnessName): HarnessAdapter {
  return name === 'zcode' ? makeZcodeAdapter() : makeClaudeCodeAdapter();
}
