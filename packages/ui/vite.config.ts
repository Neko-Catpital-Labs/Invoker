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
        // Split large vendor libs off the entry chunk so cold-start
        // parse/eval only pays for what the first paint actually needs.
        // Function form (vs. object form) reliably groups transitive
        // imports like react/jsx-runtime and scheduler with react itself.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
            return 'react';
          }
          if (/[\\/]node_modules[\\/]@xyflow[\\/]/.test(id)) {
            return 'xyflow';
          }
          if (/[\\/]node_modules[\\/]elkjs[\\/]/.test(id)) {
            return 'elkjs';
          }
          if (/[\\/]node_modules[\\/]js-yaml[\\/]/.test(id)) {
            return 'js-yaml';
          }
          if (/[\\/]node_modules[\\/]xterm(-addon-fit)?[\\/]/.test(id)) {
            return 'xterm';
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
