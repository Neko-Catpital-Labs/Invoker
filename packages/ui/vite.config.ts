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
    rollupOptions: {
      output: {
        // Function form is required so vendor matchers actually catch the
        // sub-paths (e.g. `react-dom/client`, `react/jsx-runtime`,
        // `elkjs/lib/elk.bundled.js`). The previous array form silently
        // emitted empty chunks because Rollup only matched the exact
        // package entry id.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/elkjs/')) return 'vendor-elk';
          if (id.includes('/@xyflow/')) return 'vendor-xyflow';
          if (id.includes('/js-yaml/')) return 'vendor-yaml';
          if (
            id.includes('/react-dom/') ||
            id.includes('/react/') ||
            id.includes('/scheduler/')
          ) {
            return 'vendor-react';
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
