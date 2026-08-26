import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('loadCliConfig', () => {
  let home: string;
  // os.homedir() reads USERPROFILE on Windows and HOME elsewhere — stub both.
  let saved: { HOME?: string; USERPROFILE?: string };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'quire-home-'));
    saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('QUIRE_SERVER_URL', '');
    vi.stubEnv('QUIRE_API_KEY', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (saved.HOME !== undefined) process.env.HOME = saved.HOME;
    if (saved.USERPROFILE !== undefined) process.env.USERPROFILE = saved.USERPROFILE;
  });

  it('reads from env', async () => {
    vi.stubEnv('QUIRE_SERVER_URL', 'https://example.com/');
    vi.stubEnv('QUIRE_API_KEY', 'k'.repeat(64));
    const { loadCliConfig } = await import('../src/config.js');
    const cfg = loadCliConfig();
    expect(cfg.serverUrl).toBe('https://example.com'); // trailing slash stripped
    expect(cfg.apiKey).toBe('k'.repeat(64));
  });

  it('falls back to ~/.quire/config.json', async () => {
    mkdirSync(join(home, '.quire'));
    writeFileSync(join(home, '.quire', 'config.json'), JSON.stringify({ serverUrl: 'https://cfg.example.com', apiKey: 'j'.repeat(64) }));
    const { loadCliConfig } = await import('../src/config.js');
    expect(loadCliConfig().serverUrl).toBe('https://cfg.example.com');
  });

  it('env wins over the file', async () => {
    mkdirSync(join(home, '.quire'));
    writeFileSync(join(home, '.quire', 'config.json'), JSON.stringify({ serverUrl: 'https://cfg.example.com', apiKey: 'j'.repeat(64) }));
    vi.stubEnv('QUIRE_SERVER_URL', 'https://env.example.com');
    vi.stubEnv('QUIRE_API_KEY', 'k'.repeat(64));
    const { loadCliConfig } = await import('../src/config.js');
    expect(loadCliConfig().serverUrl).toBe('https://env.example.com');
  });

  it('throws naming the missing field', async () => {
    const { loadCliConfig } = await import('../src/config.js');
    expect(() => loadCliConfig()).toThrow(/QUIRE_SERVER_URL/);
    vi.stubEnv('QUIRE_SERVER_URL', 'https://x.example.com');
    expect(() => loadCliConfig()).toThrow(/QUIRE_API_KEY/);
  });

  it('rejects a non-http server URL with an accurate message', async () => {
    vi.stubEnv('QUIRE_SERVER_URL', 'ftp://example.com');
    vi.stubEnv('QUIRE_API_KEY', 'k'.repeat(64));
    const { loadCliConfig } = await import('../src/config.js');
    expect(() => loadCliConfig()).toThrow(/must start with http/);
  });
});
