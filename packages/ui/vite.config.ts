import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

function manualChunks(id: string): string | undefined {
  if (!id.includes('/node_modules/')) return undefined;

  if (id.includes('/node_modules/elkjs/')) return 'elk';
  if (id.includes('/node_modules/@xyflow/')) return 'xyflow';
  if (id.includes('/node_modules/xterm') || id.includes('/node_modules/xterm-addon-fit/')) {
    return 'xterm';
  }
  if (
    id.includes('/node_modules/react/') ||
    id.includes('/node_modules/react-dom/') ||
    id.includes('/node_modules/scheduler/')
  ) {
    return 'react';
  }

  return 'vendor';
}

export default defineConfig({
  plugins: [react()],
  base: './', // relative paths for Electron
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Reduce memory usage in constrained environments (SSH worktrees)
    sourcemap: false, // Disable source maps to save memory
    minify: 'esbuild', // esbuild is faster and uses less memory than terser
    // ELK is a single pre-bundled layout engine artifact. It is split into a
    // lazy chunk below, but cannot be usefully subdivided under the 500 kB
    // default warning ceiling.
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks,
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
});
