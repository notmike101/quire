import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
// db.test.ts destructively drops the v1 shares/share_messages tables +
// drizzle schema in beforeAll (migrations 0000/0001 still create them;
// 0008 drops them). Without serialization another DB-touching file can
// run concurrently and lose its tables ("relation does not exist").
    fileParallelism: false,
  },
});
