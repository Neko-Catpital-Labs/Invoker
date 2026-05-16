import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// elkjs ships as a single ~1.5 MB pre-bundled module (`elk.bundled.js`); it
// has no submodule entry points that Rollup can split further. Isolating it
// in its own `elk` chunk via manualChunks below and lazy-loading it from the
// layout call site is the only practical split. The remaining `elk` chunk
// minifies to ~1.42 MB, so the warning ceiling is set just above that to
// reflect an intentional, documented exception — not a blanket suppression.
const ELK_CHUNK_WARNING_LIMIT_KB = 1500;

export default defineConfig({
  plugins: [react()],
  base: './', // relative paths for Electron
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Reduce memory usage in constrained environments (SSH worktrees)
    sourcemap: false, // Disable source maps to save memory
    minify: 'esbuild', // esbuild is faster and uses less memory than terser
    chunkSizeWarningLimit: ELK_CHUNK_WARNING_LIMIT_KB,
    rollupOptions: {
      output: {
        // Function-based chunking so bare-package names like "react" match
        // the actual resolved subpaths (e.g. react/jsx-runtime). Buckets heavy
        // vendor dependencies into named chunks and lets everything else share
        // a single `vendor` chunk. Manual chunks built from bare package names
        // previously produced empty `react`/`xterm` chunks and left the main
        // chunk at ~1.77 MB because elkjs was never split out.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/elkjs/')) return 'elk';
          if (id.includes('/@xyflow/')) return 'xyflow';
          if (id.includes('/js-yaml/')) return 'yaml';
          if (
            id.includes('/react-dom/') ||
            id.includes('/react/') ||
            id.includes('/scheduler/')
          ) {
            return 'react';
          }
          return 'vendor';
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
