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
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          // Normalize pnpm paths so we match by package name, not the .pnpm hash.
          const afterNodeModules = id.slice(id.lastIndexOf('node_modules/') + 'node_modules/'.length);
          const pkg = afterNodeModules.startsWith('@')
            ? afterNodeModules.split('/').slice(0, 2).join('/')
            : afterNodeModules.split('/')[0];
          if (pkg === 'react' || pkg === 'react-dom' || pkg === 'scheduler') return 'react';
          if (pkg === '@xyflow/react') return 'xyflow';
          if (pkg === 'xterm' || pkg === 'xterm-addon-fit') return 'xterm';
          if (pkg === 'elkjs') return 'elkjs';
          return 'vendor';
        },
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    // jsdom has no real Web Worker; swap the worker-based ELK loader for the
    // all-in-one bundle, whose inline fake-worker runs synchronously on the
    // main thread.
    alias: {
      'elkjs/lib/elk-api.js': 'elkjs/lib/elk.bundled.js',
    },
  },
});
