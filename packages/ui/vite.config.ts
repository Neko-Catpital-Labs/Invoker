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
          // Pull heavy vendor libs into named chunks so the cold-start entry
          // stays small. React stays in the main chunk (it is required on
          // first paint and Rollup would emit a near-empty file otherwise).
          xyflow: ['@xyflow/react'],
          // elkjs is only needed by the lazy mini-DAG; pinning it to its own
          // chunk keeps it out of the entry even though it is also pulled in
          // by the lazy TaskDAG import.
          elkjs: ['elkjs/lib/elk.bundled.js'],
          // js-yaml is only used inside the lazy plan-load handler.
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
