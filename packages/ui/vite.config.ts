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
          // Pin the largest vendors to dedicated chunks so the renderer can
          // start without parsing them. xyflow stays in the cold-start path
          // (WorkflowGraph), but react-dom and elkjs are big enough to merit
          // their own files. xterm is intentionally absent: nothing in the
          // current UI bundle imports it, so listing it produces an empty
          // chunk that masks dead-dep regressions.
          react: ['react', 'react-dom'],
          xyflow: ['@xyflow/react'],
          elk: ['elkjs/lib/elk.bundled.js'],
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
