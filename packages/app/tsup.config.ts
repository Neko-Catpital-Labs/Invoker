import { execSync } from 'child_process';
import { defineConfig } from 'tsup';
import { cpSync } from 'node:fs';

function buildSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'dev';
  }
}

const gitSha = buildSha();

export default defineConfig({
  entry: ['src/main.ts', 'src/preload.ts', 'src/headless-client.ts', 'src/action-graph-diagnostics.ts', 'src/sqlite-quick-check-worker.ts'],
  format: ['cjs'],
  outDir: 'dist',
  external: ['electron', 'node:sqlite', 'sql.js', 'dockerode', 'node-pty', 'dotenv'],
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
    '@invoker/planning-core',
    '@invoker/shell',
    '@invoker/slack-bug-scan',
    '@invoker/surfaces',
    '@slack/bolt',
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
