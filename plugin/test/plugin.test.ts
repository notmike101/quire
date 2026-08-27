import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('plugin manifest', () => {
  it('has a valid .claude-plugin/plugin.json', () => {
    const manifest = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
    expect(manifest.name).toBe('quire');
    expect(typeof manifest.description).toBe('string');
    expect(manifest.commands).toBe('./commands');
  });

  it('ships a /share command that publishes non-interactively (always --yes, no prompt relay)', () => {
    // Normalize CRLF -> LF so the frontmatter assertions are line-ending
    // agnostic (git autocrlf checks the file out as CRLF on Windows).
    const md = readFileSync(join(root, 'commands', 'share.md'), 'utf8').replace(/\r\n/g, '\n');
    expect(md.startsWith('---\n')).toBe(true);
    expect(md).toContain('description:');
    // The command must drive `quire publish --current` and always pass --yes so
    // the agent is never blocked on a confirmation prompt.
    expect(md).toContain('quire publish --current');
    expect(md).toContain('--yes');
    // It must NOT instruct the agent to relay a confirm prompt or wait on the user.
    expect(md).not.toContain('Never skip or assume confirmation');
    expect(md).not.toContain('relay that prompt');
    // It must NOT pass the free-text instruction as a positional argument.
    expect(md).not.toContain('quire publish --current $ARGUMENTS');
  });

  it('ships a README', () => {
    expect(existsSync(join(root, 'README.md'))).toBe(true);
  });
});
