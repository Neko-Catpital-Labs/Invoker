import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
  external: ['node:sqlite', 'yaml'],
  noExternal: [
    '@invoker/contracts',
    '@invoker/data-store',
    '@invoker/transport',
    '@invoker/workflow-core',
    '@invoker/workflow-graph',
    'neverthrow',
  ],
});
