import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  tsconfig: 'tsconfig.build.json',
  noExternal: ['@invoker/contracts', '@invoker/workflow-core', '@invoker/workflow-graph'],
  external: ['yaml'],
});
