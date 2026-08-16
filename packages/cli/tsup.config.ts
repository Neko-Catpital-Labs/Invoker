import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  banner: {
    js: `#!/usr/bin/env node
import { createRequire as __createRequire } from 'node:module';
const require = __createRequire(import.meta.url);`,
  },
  external: ['node:sqlite', 'yaml', 'dockerode', 'ssh2', 'cpu-features'],
  noExternal: [
    '@invoker/contracts',
    '@invoker/data-store',
    '@invoker/execution-engine',
    '@invoker/shell',
    '@invoker/transport',
    '@invoker/workflow-core',
    '@invoker/workflow-graph',
    'neverthrow',
  ],
});
