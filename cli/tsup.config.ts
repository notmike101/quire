import type { Options } from 'tsup';

export default {
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,
  // tsup strips the `node:` prefix from builtins by default (removeNodeProtocol:
  // true), emitting e.g. `import { DatabaseSync } from "sqlite"` — a bare spec
  // Node cannot resolve. Keep the prefix so builtins stay importable.
  removeNodeProtocol: false,
} satisfies Options;
