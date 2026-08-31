import { existsSync, statSync } from 'node:fs';
import { makeZcodeAdapter, zcodeDbPath } from './zcode.js';
import { makeClaudeCodeAdapter, claudeProjectsDir } from './claude-code.js';
import { codexStateDbPath, codexStoreUpdatedAt, makeCodexAdapter } from './codex.js';
import { makeOmpAdapter } from './omp.js';
import type { HarnessAdapter } from './types.js';

export type HarnessName = 'zcode' | 'claude-code' | 'codex' | 'omp';

export function defaultStorePaths(): { zcode: string; claudeCode: string; codex: string } {
  return { zcode: zcodeDbPath(), claudeCode: claudeProjectsDir(), codex: codexStateDbPath() };
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
  paths: { zcode: string; claudeCode: string; codex: string } = defaultStorePaths(),
): HarnessName {
  if (env.CODEX_THREAD_ID) return 'codex';
  if (env.CLAUDECODE) return 'claude-code';
  if (env.ZCODE_APP_VERSION) return 'zcode';
  const newest = [
    { name: 'zcode' as const, updatedAt: mtimeIfExists(paths.zcode) },
    { name: 'claude-code' as const, updatedAt: mtimeIfExists(paths.claudeCode) },
    { name: 'codex' as const, updatedAt: codexStoreUpdatedAt(paths.codex) },
  ]
    .filter((candidate): candidate is { name: 'zcode' | 'claude-code' | 'codex'; updatedAt: number } => candidate.updatedAt !== undefined)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (newest) return newest.name;
  throw new Error('could not detect a harness; pass --harness zcode, claude-code, codex, or omp');
}

export function makeAdapter(name: HarnessName): HarnessAdapter {
  switch (name) {
    case 'zcode': return makeZcodeAdapter();
    case 'claude-code': return makeClaudeCodeAdapter();
    case 'codex': return makeCodexAdapter();
    case 'omp': return makeOmpAdapter();
  }
}
