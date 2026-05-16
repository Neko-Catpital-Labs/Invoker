import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Map a resolved module id to a vendor chunk. Only returns a name when the
// module is actually pulled into the graph, so Rollup never emits an empty
// manual chunk (the previous string-array config produced empty `react` and
// `xterm` chunks because those entry points were never imported by the UI
// either directly or via JSX runtime + transitive deps).
function vendorChunkFor(id: string): string | undefined {
  if (!id.includes('node_modules')) return undefined;
  const match = id.match(
    /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(@[^/]+\/[^/]+|[^/]+)/,
  );
  if (!match) return undefined;
  const pkg = match[1];
  // elkjs ships a single ~1.5 MB layout engine; lazy-imported from
  // src/lib/layout.ts so it lives in its own async chunk.
  if (pkg === 'elkjs') return 'elk';
  if (pkg === '@xyflow/react') return 'xyflow';
  if (pkg === 'react' || pkg === 'react-dom' || pkg === 'scheduler') return 'react';
  if (pkg === 'js-yaml') return 'js-yaml';
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
    // elkjs ships as a single ~1.4 MB GWT-compiled blob (`elk.bundled.js`)
    // that cannot be tree-shaken or split further — it is the only chunk
    // above the default 500 KB ceiling. Every other chunk is well under
    // 250 KB, so raise the warning limit just enough to cover the elk
    // vendor chunk without masking regressions in app or other vendor code.
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: vendorChunkFor,
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
});
