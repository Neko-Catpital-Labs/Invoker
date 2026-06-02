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
        // Split large vendor chunks to reduce memory pressure and keep the
        // startup entry chunk small. A function form is used because the array
        // form did not reliably capture the pnpm-hoisted react modules.
        // elkjs is intentionally NOT listed here: it is dynamically imported in
        // src/lib/layout.ts so Rollup already emits it as a lazy async chunk
        // that stays out of the startup entry.
        manualChunks(id) {
          if (id.includes('node_modules/@xyflow/')) return 'xyflow';
          if (
            id.includes('node_modules/react-dom/') ||
            id.includes('node_modules/react/') ||
            id.includes('node_modules/scheduler/')
          ) {
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
