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
    // elkjs ships a single ~1.5 MB pre-minified bundle that cannot be split
    // further; it is dynamically imported from src/lib/layout.ts so it lands
    // in its own async chunk instead of the main bundle. Raise the warning
    // ceiling just past that chunk's size so accidental main-bundle growth
    // (>900 kB) still trips the warning.
    chunkSizeWarningLimit: 1700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('@xyflow')) return 'xyflow';
          if (
            id.includes('node_modules/xterm/') ||
            id.includes('node_modules/xterm-addon-')
          ) {
            return 'xterm';
          }
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) {
            return 'react';
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
