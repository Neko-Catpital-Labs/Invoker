import { defineConfig } from 'tsup';
import { cpSync } from 'node:fs';

export default defineConfig({
  entry: ['src/main.ts', 'src/preload.ts'],
  format: ['cjs'],
  outDir: 'dist',
  external: ['electron', 'better-sqlite3', 'dockerode', '@invoker/surfaces', '@slack/bolt', '@anthropic-ai/sdk', 'dotenv'],
  noExternal: [
    '@invoker/core',
    '@invoker/protocol',
    '@invoker/persistence',
    '@invoker/transport',
    '@invoker/executors',
    'yaml',
  ],
  clean: true,
  onSuccess: async () => {
    cpSync('assets', 'dist/assets', { recursive: true });
  },
});
