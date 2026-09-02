import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

const valid = {
  DATABASE_URL: 'postgres://quire:quire@localhost:54329/quire_test',
  QUIRE_API_KEY: 'a'.repeat(64),
  UNLOCK_SECRET: 'b'.repeat(64),
  PORT: '8787',
};

describe('loadConfig', () => {
  it('parses a valid env', () => {
    const cfg = loadConfig({ ...valid } as NodeJS.ProcessEnv);
    expect(cfg.port).toBe(8787);
    expect(cfg.databaseUrl).toBe(valid.DATABASE_URL);
    expect(cfg.publicRateLimit).toBe(120);
  });

  it('rejects missing QUIRE_API_KEY with the field named', () => {
    const { QUIRE_API_KEY: _drop, ...rest } = valid;
    expect(() => loadConfig(rest as NodeJS.ProcessEnv)).toThrow(/QUIRE_API_KEY/);
  });

  it('rejects a non-numeric PORT', () => {
    expect(() => loadConfig({ ...valid, PORT: 'abc' } as NodeJS.ProcessEnv)).toThrow(/PORT/);
  });

  it('parses a custom public rate limit', () => {
    const cfg = loadConfig({ ...valid, QUIRE_PUBLIC_RATE_LIMIT: '500' } as NodeJS.ProcessEnv);
    expect(cfg.publicRateLimit).toBe(500);
  });
});
