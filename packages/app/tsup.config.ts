import { execSync } from 'child_process';
import { defineConfig } from 'tsup';
import { cpSync } from 'node:fs';

const gitSha = execSync('git rev-parse --short HEAD').toString().trim();

export default defineConfig({
  entry: ['src/main.ts', 'src/preload.ts', 'src/headless-client.ts', 'src/action-graph-diagnostics.ts'],
  format: ['cjs'],
  outDir: 'dist',
  external: ['electron', 'node:sqlite', 'sql.js', 'dockerode', 'node-pty', '@invoker/surfaces', '@slack/bolt', 'dotenv'],
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
  clean: true,
  define: {
    __BUILD_SHA__: JSON.stringify(gitSha),
    __BUILD_VERSION__: JSON.stringify(require('./package.json').version),
  },
  onSuccess: async () => {
    cpSync('assets', 'dist/assets', { recursive: true });
  },
});
