import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import MergifyReporter from '@mergifyio/vitest';

// Match a node_modules path segment for a given package name (handles both
// flat `node_modules/<pkg>` and pnpm's `node_modules/.pnpm/<pkg>@.../node_modules/<pkg>`).
function isFromPackage(id: string, pkg: string): boolean {
  return id.includes(`/node_modules/${pkg}/`);
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
      input: { index: 'index.html', web: 'web.html' },
      output: {
        // Dependency-aware vendor splitting: bin each node_modules file into
        // a named chunk based on its resolved path. This avoids the empty
        // chunks the previous bare-name map produced (Rollup never matched
        // `react` because consumers import `react/jsx-runtime` and friends,
        // not the bare package entry), and keeps elkjs — the bundled layout
        // API — isolated from the rest of the app code. The heavy ELK layout
        // implementation is loaded as a worker asset from layout.ts, so it
        // does not count as an oversized Vite JS chunk.
        manualChunks(id) {
          if (!id.includes('/node_modules/')) return undefined;
          if (isFromPackage(id, 'elkjs')) return 'elkjs';
          if (
            isFromPackage(id, 'react') ||
            isFromPackage(id, 'react-dom') ||
            isFromPackage(id, 'scheduler')
          ) {
            return 'react';
          }
          if (isFromPackage(id, '@xyflow/react')) return 'xyflow';
          if (isFromPackage(id, 'xterm') || isFromPackage(id, 'xterm-addon-fit')) {
            return 'xterm';
          }
          return 'vendor';
        },
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    reporters: ['default', new MergifyReporter()],
  },
});
