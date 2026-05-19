import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

function vendorChunk(id: string): string | undefined {
  if (!id.includes('/node_modules/')) return undefined;
  if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) return 'react-vendor';
  if (id.includes('/@xyflow/')) return 'xyflow';
  if (id.includes('/xterm') || id.includes('/xterm-addon-fit/')) return 'xterm';
  if (id.includes('/js-yaml/')) return 'yaml';
  return undefined;
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
    rollupOptions: {
      output: {
        manualChunks: vendorChunk,
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
});
