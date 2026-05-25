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
          // startup entry chunk small. elkjs is ~1.5MB and is only needed once
          // the user opens the task DAG; js-yaml is only needed when a plan is
          // parsed locally.
          react: ['react', 'react-dom'],
          xyflow: ['@xyflow/react'],
          xterm: ['xterm', 'xterm-addon-fit'],
          elkjs: ['elkjs/lib/elk.bundled.js'],
          'js-yaml': ['js-yaml'],
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
