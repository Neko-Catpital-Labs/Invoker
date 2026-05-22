import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './', // relative paths for Electron
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Reduce memory usage in constrained environments (SSH worktrees)
    sourcemap: false, // Disable source maps to save memory
    minify: 'esbuild', // esbuild is faster and uses less memory than terser
    // The `elk` chunk holds elkjs (`elk.bundled.js`), a ~1.4 MB GWT-compiled
    // graph-layout engine published as one monolithic IIFE — it cannot be
    // meaningfully tree-shaken or further split. We already isolate it in its
    // own chunk and lazy-import it from `lib/layout.ts` so it stays out of
    // the initial load. The threshold is set just above that floor so the
    // intentional ceiling is visible in the build output, and any *other*
    // chunk slipping above it still trips the warning.
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // Dependency-aware chunking: route node_modules into dedicated
        // chunks by package path. The previous object form keyed by bare
        // package name (e.g. 'react') matched nothing — Rollup compares
        // against resolved module IDs like '/node_modules/react/index.js',
        // which produced an empty "react" chunk warning.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/elkjs/')) return 'elk';
          if (id.includes('/@xyflow/')) return 'xyflow';
          if (id.includes('/xterm-addon-') || id.includes('/xterm/')) return 'xterm';
          if (id.includes('/js-yaml/')) return 'js-yaml';
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
