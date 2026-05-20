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
    // elkjs ships a single ~1.4MB minified bundle (GWT-transpiled from Java).
    // It has no submodule entry points to enable further splitting, so the
    // best we can do is isolate it into its own chunk that is loaded lazily
    // by `lib/layout.ts`. We raise the warning limit just enough to cover
    // that one chunk; every other chunk in this app stays well under 500 kB.
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) {
            return undefined;
          }
          // Isolate the elkjs layout engine so its bulk does not weigh down
          // the main entry chunk. Imported dynamically from `lib/layout.ts`,
          // so the chunk is only fetched the first time a DAG is laid out.
          if (id.includes('/elkjs/')) {
            return 'elk';
          }
          // React runtime: react, react-dom, and scheduler all share the
          // same lifecycle, so collapse them into one vendor chunk.
          if (
            /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)
          ) {
            return 'react-vendor';
          }
          if (id.includes('/@xyflow/')) {
            return 'xyflow';
          }
          if (id.includes('/xterm/') || id.includes('/xterm-addon-')) {
            return 'xterm';
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
