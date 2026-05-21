import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// elkjs ships as a single Java→JS (GWT) port bundled into one ~1.4 MB file.
// It has no public submodule entry points to split on, and its worker form
// (elk-worker.min.js) is the same size — so the only sub-500 kB option would
// be to externalize it, which is not viable in an Electron file:// build.
// We split every other vendor into its own chunk via manualChunks below and
// raise the warning limit just above the elkjs payload so the practical
// splits we DO have don't get drowned out by a warning we can't action on.
const ELKJS_CHUNK_KB = 1500;

export default defineConfig({
  plugins: [react()],
  base: './', // relative paths for Electron
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Reduce memory usage in constrained environments (SSH worktrees)
    sourcemap: false, // Disable source maps to save memory
    minify: 'esbuild', // esbuild is faster and uses less memory than terser
    chunkSizeWarningLimit: ELKJS_CHUNK_KB,
    rollupOptions: {
      output: {
        // Dependency-aware splitting by resolved module path. The previous
        // object-form manualChunks emitted empty chunks for packages whose
        // top-level entry was tree-shaken (e.g. `react`); matching paths
        // captures all of the package's internal modules.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/elkjs/')) return 'elkjs';
          if (id.includes('/@xyflow/')) return 'xyflow';
          if (/[\\/]xterm(-addon-fit)?[\\/]/.test(id)) return 'xterm';
          if (/[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react';
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
