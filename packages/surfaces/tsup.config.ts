import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  dts: { resolve: false, compilerOptions: { composite: false } },
  tsconfig: 'tsconfig.tsup.json',
  clean: true,
  // Bundle workspace deps (their package.json point to .ts source, won't load at runtime).
  // sql.js/dockerode stay external — resolved from node_modules.
  noExternal: [
    '@invoker/workflow-core',
    '@invoker/contracts',
    '@invoker/data-store',
    '@invoker/transport',
    '@invoker/execution-engine',
    'yaml',
  ],
  external: ['@slack/bolt', 'sql.js', 'dockerode'],
});
