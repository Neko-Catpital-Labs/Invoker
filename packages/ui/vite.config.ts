import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const VENDOR_CHUNK_RULES: Array<{ chunk: string; match: (id: string) => boolean }> = [
  { chunk: 'elkjs', match: (id) => id.includes('/node_modules/elkjs/') },
  { chunk: 'xyflow', match: (id) => id.includes('/node_modules/@xyflow/') },
  {
    chunk: 'xterm',
    match: (id) =>
      id.includes('/node_modules/xterm/') || id.includes('/node_modules/xterm-addon-fit/'),
  },
  {
    chunk: 'react-vendor',
    match: (id) =>
      id.includes('/node_modules/react/') ||
      id.includes('/node_modules/react-dom/') ||
      id.includes('/node_modules/scheduler/'),
  },
  { chunk: 'js-yaml', match: (id) => id.includes('/node_modules/js-yaml/') },
];

export default defineConfig({
  plugins: [react()],
  base: './', // relative paths for Electron
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Reduce memory usage in constrained environments (SSH worktrees)
    sourcemap: false, // Disable source maps to save memory
    minify: 'esbuild', // esbuild is faster and uses less memory than terser
    // elkjs ships a single ~1.4 MB minified UMD bundle (elk.bundled.js) that is
    // the Eclipse Layout Kernel compiled from Java to JavaScript via GWT. It has
    // no exported sub-modules, so it cannot be split by Rollup. Every other
    // vendor (react, xyflow, xterm, js-yaml) and the app code stay well below
    // 500 kB after the manualChunks split below, so this raised ceiling exists
    // solely to accommodate the indivisible elkjs bundle and would still flag a
    // regression in any other chunk.
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // Function form ensures a chunk is only created when at least one module
        // actually resolves into it, avoiding "Generated an empty chunk" warnings.
        manualChunks(id) {
          for (const rule of VENDOR_CHUNK_RULES) {
            if (rule.match(id)) return rule.chunk;
          }
          return undefined;
        },
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
});
