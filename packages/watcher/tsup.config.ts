import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  outDir: 'dist',
  tsconfig: 'tsconfig.tsup.json',
  clean: true,
  noExternal: ['@invoker/slack-manager'],
});
