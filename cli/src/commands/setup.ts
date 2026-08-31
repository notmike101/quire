import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OMP_SHARE_HANDLER_SOURCE } from '../omp-share-handler.js';

export interface InstallOmpOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  source?: string;
}

export function ompAgentDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return env.PI_CODING_AGENT_DIR || join(home, '.omp', 'agent');
}

const OMP_SHARE_CANDIDATES = ['share.ts', 'share.js', 'share.mjs'] as const;

function conflictMessage(existing: string): string {
  return [
    `OMP share handler conflict: ${existing} already exists.`,
    'Quire never overwrites or chains an existing share handler.',
    `To use Quire's /share, rename or remove ${existing}, then run: quire setup omp`,
  ].join('\n');
}

export async function installOmpShareHandler(options: InstallOmpOptions = {}): Promise<{ path: string; unchanged: boolean }> {
  const source = options.source ?? OMP_SHARE_HANDLER_SOURCE;
  const dir = ompAgentDir(options.env, options.home);
  const target = join(dir, 'share.mjs');
  for (const candidate of OMP_SHARE_CANDIDATES) {
    const candidatePath = join(dir, candidate);
    let info;
    try {
      info = await stat(candidatePath);
    } catch {
      continue; // candidate absent
    }
    if (candidate === 'share.mjs' && info.isFile()) {
      const existing = await readFile(candidatePath);
      if (existing.toString('utf8') === source) {
        return { path: candidatePath, unchanged: true };
      }
    }
    throw new Error(conflictMessage(candidatePath));
  }

  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `share.mjs.tmp-${randomBytes(8).toString('hex')}`);
  let created = false;
  try {
    await writeFile(tmp, source, { mode: 0o600 });
    created = true;
    await rename(tmp, target);
  } catch (err) {
    if (created) await unlink(tmp).catch(() => {});
    throw err;
  }
  return { path: target, unchanged: false };
}

export async function runSetup(positionals: string[] = [], options: InstallOmpOptions = {}): Promise<void> {
  if (positionals.length > 1) {
    throw new Error('usage: quire setup [omp]');
  }
  const target = positionals[0];
  if (target === undefined) {
    const apiKey = randomBytes(32).toString('hex');
    const unlockSecret = randomBytes(32).toString('hex');
    console.log(`Add these to your server's .env:\n\n  QUIRE_API_KEY=${apiKey}\n  UNLOCK_SECRET=${unlockSecret}\n`);
    console.log('And point the CLI at your server:\n\n  export QUIRE_SERVER_URL=https://<your-host>\n  export QUIRE_API_KEY=<the key above>\n');
    console.log('Or write ~/.quire/config.json: { "serverUrl": "https://<your-host>", "apiKey": "<key>" }');
    return;
  }
  if (target !== 'omp') {
    throw new Error(`unknown setup target "${target}" (usage: quire setup [omp])`);
  }
  const result = await installOmpShareHandler(options);
  console.log(result.unchanged ? `OMP share handler already installed: ${result.path}` : `Installed OMP share handler: ${result.path}`);
  console.log('/share in an interactive OMP session now publishes through Quire with strict redaction, no password, no expiry.');
  console.log('Restart or reload OMP to activate it.');
}
