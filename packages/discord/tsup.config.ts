import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  outDir: 'dist',
  tsconfig: 'tsconfig.tsup.json',
  clean: true,
  external: ['@invoker/surfaces', 'discord.js', 'sql.js', 'dockerode', 'node-pty', 'node:sqlite'],
  noExternal: [
    '@invoker/contracts',
    '@invoker/data-store',
    '@invoker/execution-engine',
    '@invoker/planning-core',
    '@invoker/runtime-adapters',
    '@invoker/runtime-domain',
    '@invoker/runtime-service',
    '@invoker/transport',
    '@invoker/workflow-core',
    '@invoker/workflow-graph',
    'yaml',
  ],
});
