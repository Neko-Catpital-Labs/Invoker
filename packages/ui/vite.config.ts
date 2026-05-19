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
          // Split heavy vendors so the entry chunk stays small. xyflow ships
          // with the eager WorkflowGraph render. elkjs is heavy and only
          // reachable through the lazy TaskDAG, so it lands in its own chunk
          // and is fetched on demand.
          xyflow: ['@xyflow/react'],
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
