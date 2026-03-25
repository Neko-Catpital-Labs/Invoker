import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  dts: true,
  clean: true,
  // Bundle workspace deps (their package.json point to .ts source, won't load at runtime).
  // sql.js/dockerode stay external — resolved from node_modules.
  noExternal: [
    '@invoker/core',
    '@invoker/protocol',
    '@invoker/persistence',
    '@invoker/transport',
    '@invoker/executors',
    'yaml',
  ],
  external: ['@slack/bolt', 'sql.js', 'dockerode'],
});
