import { defineConfig } from 'tsup';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: {
    compilerOptions: {
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      types: ['node'],
      typeRoots: [
        path.join(root, 'node_modules/@types'),
        path.join(root, '../../node_modules/@types'),
      ],
    },
  },
});
