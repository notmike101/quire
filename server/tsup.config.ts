import type { Options } from 'tsup';

export default {
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,
  // @quire/protocol is a workspace package whose main is raw TS source. Left
  // external, the deployed prod dir would import .ts files from node_modules
  // at runtime, which Node's type stripping refuses (files under node_modules
  // are never stripped). Bundle it instead — it is dependency-free pure TS.
  noExternal: ['@quire/protocol'],
} satisfies Options;
