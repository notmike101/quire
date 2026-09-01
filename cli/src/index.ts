#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { runSetup } from './commands/setup.js';

const USAGE = `quire — share AI coding sessions as expiring, password-protected web links

Usage:
  quire publish [sessionId] [--current] [--harness zcode|claude-code|codex|omp]
                [--password <pw|random>] [--expires <dur|ISO|tomorrow|today|week|month|year>]
                [--preset strict|normal] [--format v1|v2] [--no-chunk] [--yes]
  quire list
  quire revoke <token> [--yes]
  quire update <token> [--password <pw|random>] [--expires <dur|ISO|tomorrow|today|week|month|year>]
  quire setup [omp]

  publish requires --current or a session id (no interactive picker).
  --password random generates a random secret and prints it once.
  --format defaults to v2 (sealed share, key in the URL fragment); pass --format v1 for the legacy format.
  --yes skips the confirmation prompt (for agents/scripts).

Config: QUIRE_SERVER_URL + QUIRE_API_KEY (env) or ~/.quire/config.json
`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'setup':
      await runSetup(rest);
      return;
    case 'publish':
    case 'list':
    case 'revoke':
    case 'update': {
      const { runPublish } = await import('./commands/publish.js');
      const { runList } = await import('./commands/list.js');
      const { runRevoke } = await import('./commands/revoke.js');
      const { runUpdate } = await import('./commands/update.js');
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          current: { type: 'boolean', default: false },
          harness: { type: 'string' },
          password: { type: 'string' },
          expires: { type: 'string' },
          preset: { type: 'string' },
          format: { type: 'string', default: 'v2' },
          yes: { type: 'boolean', default: false },
          // Node's parseArgs does not map kebab-case flags to camelCase option
          // keys, so each multi-word flag needs BOTH spellings. Without the
          // kebab alias, `--no-chunk` is rejected as unknown (verified on Node 26).
          noChunk: { type: 'boolean', default: false },
          'no-chunk': { type: 'boolean', default: false },
        },
      });
      // Fold the kebab-case aliases into the camelCase keys the commands read.
      values.noChunk = (values as Record<string, unknown>)['no-chunk'] === true || values.noChunk === true;
      if (command === 'publish') await runPublish(values, positionals);
      if (command === 'list') await runList();
      if (command === 'revoke') await runRevoke(positionals[0], values);
      if (command === 'update') await runUpdate(positionals[0], values);
      return;
    }
    default:
      process.stderr.write(USAGE);
      process.exit(2);
  }
}

main().catch(async (err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  // Known Node bug on Windows (nodejs/node#56645): process.exit() while
  // undici keep-alive connections are still closing triggers a libuv
  // assertion crash (access violation) — any publish that made 2+ HTTP
  // requests (v2 create+finalize, v1 chunked uploads) hit this. Close the
  // global fetch pool and let the event loop drain instead of force-exiting.
  try {
    const undici = process.getBuiltinModule('undici') as
      | { getGlobalDispatcher?: () => { close(): Promise<void> } }
      | undefined; // built-in module (Node 22.3+); shape is undici's, unchecked here
    await undici?.getGlobalDispatcher?.().close();
  } catch {
    // best effort: a failed cleanup must not mask the original error
  }
  process.exitCode = 1;
});
