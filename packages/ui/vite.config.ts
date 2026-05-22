import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dependency-aware chunking: route each heavy vendor module to a dedicated
// chunk by its resolved node_modules path. The previous array-form manual
// chunks emitted an empty "react" chunk under Vite 6 + React 19 because the
// automatic JSX runtime (`react/jsx-runtime`) is a distinct module that the
// array form does not match, so Rollup bundled all React code elsewhere and
// left an empty file behind. Matching on the resolved path captures every
// React submodule (jsx-runtime, scheduler, etc.) and keeps the heavy elkjs
// layout engine out of the main entry, which previously pushed it past the
// 500 kB warning threshold.
function vendorChunk(id: string): string | undefined {
  if (!id.includes('node_modules')) return undefined;
  const normalized = id.replace(/\\/g, '/');
  if (
    /\/node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?(react|react-dom|scheduler)\//.test(
      normalized,
    )
  ) {
    return 'react';
  }
  if (normalized.includes('/@xyflow/')) return 'xyflow';
  if (normalized.includes('/xterm') || normalized.includes('/xterm-addon-fit/')) {
    return 'xterm';
  }
  if (normalized.includes('/elkjs/')) return 'elk';
  if (normalized.includes('/js-yaml/')) return 'yaml';
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
