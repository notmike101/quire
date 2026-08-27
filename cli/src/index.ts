#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { runSetup } from './commands/setup.js';

const USAGE = `quire — share AI coding sessions as expiring, password-protected web links

Usage:
  quire publish [sessionId] [--current] [--harness zcode|claude-code]
                [--password <pw>] [--expires <dur|ISO>] [--preset strict|normal|none]
                [--no-chunk] [--yes]
  quire list
  quire revoke <token>
  quire update <token> [--password <pw>] [--expires <dur|ISO>]
  quire setup

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
          noChunk: { type: 'boolean', default: false },
        },
      });
      if (command === 'publish') await runPublish(values, positionals);
      if (command === 'list') await runList();
      if (command === 'revoke') await runRevoke(positionals[0]);
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
