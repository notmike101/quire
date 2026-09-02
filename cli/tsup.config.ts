import type { Options } from 'tsup';

export default {
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,
  // @quire/protocol is a workspace package whose main is raw TS source. Left
  // external, dist would import .ts files from node_modules at runtime, which
  // Node's type stripping refuses (files under node_modules are never
  // stripped). Bundle it instead — it is dependency-free pure TS.
  noExternal: ['@quire/protocol'],
  // tsup strips the `node:` prefix from builtins by default (removeNodeProtocol:
  // true), emitting e.g. `import { DatabaseSync } from "sqlite"` — a bare spec
  // Node cannot resolve. Keep the prefix so builtins stay importable.
  removeNodeProtocol: false,
} satisfies Options;
