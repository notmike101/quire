#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { runSetup } from './commands/setup.js';

const USAGE = `quire — share AI coding sessions as expiring, password-protected web links

Usage:
  quire publish [sessionId] [--current] [--harness zcode|claude-code|codex]
                [--password <pw|random>] [--expires <dur|ISO|tomorrow|today|week|month|year>]
                [--preset strict|normal] [--no-chunk] [--yes]
  quire list
  quire revoke <token> [--yes]
  quire update <token> [--password <pw|random>] [--expires <dur|ISO|tomorrow|today|week|month|year>]
  quire setup

  publish requires --current or a session id (no interactive picker).
  --password random generates a random secret and prints it once.
  --yes skips the confirmation prompt (for agents/scripts).

Config: QUIRE_SERVER_URL + QUIRE_API_KEY (env) or ~/.quire/config.json
`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'setup':
      await runSetup();
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

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
