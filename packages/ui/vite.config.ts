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
        manualChunks: {
          // Split large vendor chunks to reduce memory pressure and keep the
          // cold-start entry chunk small. elkjs is ~1.6MB and is only reached
          // via the lazy-loaded TaskDAG mini panel; keeping it in its own
          // chunk means the renderer never parses it on first paint.
          react: ['react', 'react-dom'],
          xyflow: ['@xyflow/react'],
          xterm: ['xterm', 'xterm-addon-fit'],
          elkjs: ['elkjs/lib/elk.bundled.js'],
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
