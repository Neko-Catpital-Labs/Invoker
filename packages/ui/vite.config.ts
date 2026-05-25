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
          // Split large vendor chunks to reduce memory pressure and to keep
          // them out of the cold-start entry chunk.
          react: ['react', 'react-dom'],
          xyflow: ['@xyflow/react'],
          // elkjs is several MB; isolating it makes it obvious in build output
          // even though the actual load is gated by a dynamic import in
          // src/lib/layout.ts (entry chunk does not depend on it).
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
