import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['validate-plan.ts'],
  format: ['esm'],
  outDir: 'dist',
  noExternal: ['yaml'],
  external: ['@invoker/core'],
  clean: false,
  bundle: true,
});
