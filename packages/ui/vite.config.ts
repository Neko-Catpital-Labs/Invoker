import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

function dependencyChunk(id: string): string | undefined {
  const normalizedId = id.replaceAll('\\', '/');

  if (!normalizedId.includes('/node_modules/')) {
    return undefined;
  }

  if (normalizedId.includes('/node_modules/react/') || normalizedId.includes('/node_modules/react-dom/')) {
    return 'react';
  }
  if (normalizedId.includes('/node_modules/@xyflow/react/')) {
    return 'xyflow';
  }
  if (normalizedId.includes('/node_modules/xterm/') || normalizedId.includes('/node_modules/xterm-addon-fit/')) {
    return 'xterm';
  }
  if (normalizedId.includes('/node_modules/elkjs/')) {
    return 'elk';
  }
  if (normalizedId.includes('/node_modules/js-yaml/') || normalizedId.includes('/node_modules/argparse/')) {
    return 'yaml';
  }

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
        manualChunks: dependencyChunk,
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
});
