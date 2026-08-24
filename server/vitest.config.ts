import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // db.test.ts destructively drops the shares/share_messages tables + drizzle
    // schema in beforeAll. public.api.test.ts (this task) is the second
    // DB-touching file; without serialization the two can run concurrently and
    // db.test.ts drops tables out from under public.api.test.ts (flaky
    // "relation does not exist"). Serialize test files.
    fileParallelism: false,
  },
});
