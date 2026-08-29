import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  // The compose stack's server occasionally drops the first request during its
  // startup race ("socket hang up" on the first POST /api/chats). One retry
  // absorbs that infra flake without masking real failures (a genuine
  // regression fails both attempts).
  retries: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8790',
    trace: 'off',
    launchOptions: { executablePath: 'D:\\cloakbrowser\\current\\chrome.exe' },
  },
  globalSetup: './test/global-setup.ts',
  globalTeardown: './test/global-teardown.ts',
});
