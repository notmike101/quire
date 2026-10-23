import { existsSync, statSync } from 'node:fs';
import { makeZcodeAdapter, zcodeDbPath } from './zcode.js';
import { makeClaudeCodeAdapter, claudeProjectsDir } from './claude-code.js';
import { codexStateDbPath, codexStoreUpdatedAt, makeCodexAdapter } from './codex.js';
import { makeOmpAdapter } from './omp.js';
import type { HarnessAdapter } from './types.js';

export type HarnessName = 'zcode' | 'claude-code' | 'codex' | 'omp';

/**
 * Resolve the default stores used for automatic harness detection.
 *
 * @returns Paths for the ZCode, Claude Code, and Codex stores.
 */
export function defaultStorePaths(): { zcode: string; claudeCode: string; codex: string } {
  return { zcode: zcodeDbPath(), claudeCode: claudeProjectsDir(), codex: codexStateDbPath() };
}

/**
 * Read a store's modification time without failing discovery.
 *
 * @param path - Candidate store path.
 * @returns Modification time in milliseconds, or undefined if unavailable.
 */
function mtimeIfExists(path: string): number | undefined {
  try {
    return existsSync(path) ? statSync(path).mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Prefer explicit harness environment markers, then the newest available store.
 *
 * @param env - Environment containing optional harness markers.
 * @param paths - Store locations to compare when no marker is set.
 * @param paths.zcode - ZCode database path whose modification time is compared.
 * @param paths.claudeCode - Claude Code projects directory whose modification time is compared.
 * @param paths.codex - Codex database path used to read the newest task timestamp.
 * @returns Detected harness name; OMP requires explicit selection.
 */
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

/**
 * Construct the adapter for an explicitly selected harness.
 *
 * @param name - Supported harness identifier.
 * @returns Harness-specific discovery and loading implementation.
 */
export function makeAdapter(name: HarnessName): HarnessAdapter {
  switch (name) {
    case 'zcode': return makeZcodeAdapter();
    case 'claude-code': return makeClaudeCodeAdapter();
    case 'codex': return makeCodexAdapter();
    case 'omp': return makeOmpAdapter();
  }
}
