import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'cli-runtime': 'src/cli-runtime.ts',
  },
  format: ['esm'],
  dts: false,
  clean: true,
  removeNodeProtocol: false,
  banner: {
    js: '',
  },
  outExtension: () => ({ js: '.mjs' }),
  onSuccess: 'node scripts/write-dist-bin.cjs',
  external: ['node:sqlite', 'yaml', 'dockerode', 'ssh2', 'cpu-features', '@slack/web-api'],
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
