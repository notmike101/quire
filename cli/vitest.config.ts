import { defineConfig } from 'vitest/config';

// Node's `node:sqlite` builtin is NOT listed in `module.builtinModules`, and
// vite-node 2.1.9 (vitest 2.1.9) derives its builtin set from exactly that
// list AND strips the `node:` prefix (normalizeModuleId) before its
// externalize check. The net effect: a static `import ... from 'node:sqlite'`
// is neither recognized as a builtin nor externalizable (the stripped bare
// `sqlite` is not natively importable), so it falls through to the vite
// transform pipeline and fails with "Failed to load url sqlite".
//
// Workaround: resolve the specifier to a virtual module whose only job is to
// re-export `DatabaseSync` via CJS `require`, which resolves `node:`-prefixed
// builtins natively at runtime. zcode.ts itself stays unchanged.
const SQLITE_ID = '\0node:sqlite';

export default defineConfig({
  plugins: [
    {
      name: 'node-sqlite-shim',
      enforce: 'pre',
      resolveId(id) {
        if (id === 'node:sqlite' || id === 'sqlite' || id === SQLITE_ID) return SQLITE_ID;
      },
      load(id) {
        if (id !== SQLITE_ID) return;
        return [
          "import { createRequire } from 'node:module';",
          'const req = createRequire(import.meta.url);',
          'const sqlite = req("node:sqlite");',
          'export const DatabaseSync = sqlite.DatabaseSync;',
        ].join('\n');
      },
    },
  ],
});
