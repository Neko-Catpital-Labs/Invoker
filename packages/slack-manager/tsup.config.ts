import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  outDir: 'dist',
  tsconfig: 'tsconfig.tsup.json',
  clean: true,
  // @invoker/surfaces is consumed as a built artifact at runtime (it bundles
  // @slack/bolt-bound code); everything else is bundled from TS source.
  external: ['@invoker/surfaces', '@slack/bolt', 'sql.js', 'dockerode', 'node-pty', 'node:sqlite'],
  noExternal: [
    '@invoker/workflow-core',
    '@invoker/workflow-graph',
    '@invoker/contracts',
    '@invoker/data-store',
    '@invoker/runtime-domain',
    '@invoker/runtime-adapters',
    '@invoker/runtime-service',
    '@invoker/transport',
    '@invoker/execution-engine',
    'yaml',
  ],
});
