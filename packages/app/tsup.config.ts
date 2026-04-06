import { defineConfig } from 'tsup';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';

export default defineConfig({
  entry: ['src/main.ts', 'src/preload.ts'],
  format: ['cjs'],
  outDir: 'dist',
  external: ['electron', 'sql.js', 'dockerode', '@invoker/surfaces', '@slack/bolt', 'dotenv'],
  noExternal: [
    '@invoker/core',
    '@invoker/workflow-core',
    '@invoker/workflow-graph',
    '@invoker/contracts',
    '@invoker/data-store',
    '@invoker/transport',
    '@invoker/execution-engine',
    'yaml',
  ],
  clean: true,
  onSuccess: async () => {
    cpSync('assets', 'dist/assets', { recursive: true });
    const src = readFileSync('src/main-process-file-log.ts', 'utf8');
    const out = ts.transpileModule(src, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
      fileName: 'main-process-file-log.ts',
    }).outputText;
    writeFileSync('dist/main-process-file-log.js', out, 'utf8');
  },
});
